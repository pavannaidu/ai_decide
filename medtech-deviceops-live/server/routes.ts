import { randomUUID } from 'node:crypto';
import type { LakebasePool } from '@databricks/appkit';
import type { Application, Request, Response } from 'express';
import { z } from 'zod';
import { callAiDecide } from './ai-decide';
import { buildDecisionRequest, parseAnswers } from './decisions';
import { HttpError } from './errors';
import { SOP } from './policy';
import {
  applyAction,
  buildCandidates,
  createScenarioState,
  createState,
  injectEvent,
  prepareTurn,
  snapshot,
} from './simulator';
import { hasRequest, loadRunRow, loadRunView, loadSop, loadStep, loadSteps, summarizeRun } from './run-store';
import type { RunRow } from './run-store';

export const tickInputSchema = z.object({
  expectedRevision: z.number().int().min(0),
  requestId: z.uuid(),
});
export const eventInputSchema = z.object({
  expectedRevision: z.number().int().min(0),
  kind: z.enum(['isolated_fault', 'lot_qc', 'ambiguous_report']),
});
const newRunSchema = z.object({
  seed: z.number().int().min(0).max(2147483647).default(42),
  requestId: z.uuid().optional(),
  scenario: eventInputSchema.shape.kind.optional(),
});

export function ownerKey(request: Request) {
  const owner = request.header('x-forwarded-user') ?? request.header('x-forwarded-email');
  if (owner) return owner;
  if (process.env.NODE_ENV === 'development') return 'local-demo';
  throw new HttpError(401, 'Use the authenticated Databricks App URL to access simulation runs.');
}

export function route(handler: (request: Request) => Promise<unknown>) {
  return (request: Request, response: Response): void => {
    void Promise.resolve()
      .then(() => handler(request))
      .then((data: unknown) => response.json(data))
      .catch((error: unknown) => {
        if (error instanceof HttpError) {
          response.status(error.status).json({ error: error.message });
        } else if (error instanceof z.ZodError) {
          response.status(400).json({ error: 'Invalid request. Check the run ID, revision, event type, and seed.' });
        } else {
          console.error('Simulation operation failed:', error instanceof Error ? error.message : 'Unknown error');
          response.status(503).json({
            error:
              'The operation could not be saved in Lakebase. The simulation is paused; no in-memory fallback is enabled.',
          });
        }
      });
  };
}

export function registerRoutes(app: Application, pool: LakebasePool) {
  app.get(
    '/api/health',
    route(async () => {
      const { rows } = await pool.query<{ owned: boolean }>(
        `SELECT nspowner = (SELECT oid FROM pg_roles WHERE rolname = CURRENT_USER) AS owned
       FROM pg_namespace WHERE nspname = 'deviceops_sim'`
      );
      if (!rows.length) throw new HttpError(503, 'Lakebase schema initialization has not completed.');
      return {
        status: 'ready',
        lakebase: 'connected',
        schema: 'deviceops_sim',
        identity: process.env.DATABRICKS_APP_NAME ? 'app service principal' : 'local CLI profile',
        schemaOwnedByCaller: rows[0].owned,
      };
    })
  );

  app.get(
    '/api/runs',
    route(async (request) => {
      const owner = ownerKey(request);
      const { rows } = await pool.query<RunRow>(
        'SELECT * FROM deviceops_sim.simulation_runs WHERE owner_key = $1 ORDER BY updated_at DESC LIMIT 10',
        [owner]
      );
      return {
        policyVersion: SOP.version,
        runs: rows.map(summarizeRun),
        run: rows[0] ? await loadRunView(pool, owner, rows[0].id) : null,
        preview: snapshot(createState(42)),
      };
    })
  );

  app.post(
    '/api/runs',
    route(async (request) => {
      const owner = ownerKey(request);
      const input = newRunSchema.parse(request.body);
      const id = input.requestId ?? randomUUID();
      const state = input.scenario ? createScenarioState(input.seed, input.scenario) : createState(input.seed);
      await pool.query(
        `INSERT INTO deviceops_sim.simulation_runs(id, owner_key, seed, sop_version, state)
       VALUES ($1, $2, $3, $4, $5::jsonb) ON CONFLICT (id) DO NOTHING`,
        [id, owner, input.seed, SOP.version, JSON.stringify(state)]
      );
      return loadRunView(pool, owner, id);
    })
  );

  app.get(
    '/api/runs/:id',
    route((request) => loadRunView(pool, ownerKey(request), z.uuid().parse(request.params.id)))
  );

  app.get(
    '/api/runs/:id/steps',
    route((request) => loadSteps(pool, ownerKey(request), z.uuid().parse(request.params.id)))
  );

  app.get(
    '/api/runs/:id/steps/:turn',
    route((request) =>
      loadStep(
        pool,
        ownerKey(request),
        z.uuid().parse(request.params.id),
        z.coerce.number().int().min(1).max(60).parse(request.params.turn)
      )
    )
  );

  app.post(
    '/api/runs/:id/events',
    route(async (request) => {
      const owner = ownerKey(request);
      const id = z.uuid().parse(request.params.id);
      const input = eventInputSchema.parse(request.body);
      const run = await loadRunRow(pool, owner, id);
      if (run.revision !== input.expectedRevision)
        throw new HttpError(409, 'This run changed in another request. Refresh before injecting an event.');
      if (run.tick >= 60)
        throw new HttpError(409, 'This run is complete. Reset to start a new run; history is retained.');
      const result = injectEvent(run.state, input.kind);
      if (!result.injected) throw new HttpError(409, result.message);
      const updated = await pool.query<{ id: string }>(
        `UPDATE deviceops_sim.simulation_runs SET state = $1::jsonb, revision = revision + 1, updated_at = NOW()
       WHERE id = $2 AND owner_key = $3 AND revision = $4 RETURNING id`,
        [JSON.stringify(result.state), id, owner, input.expectedRevision]
      );
      if (!updated.rows.length)
        throw new HttpError(409, 'The run changed while injecting the event. Refresh and try again.');
      return { run: await loadRunView(pool, owner, id), message: result.message };
    })
  );

  app.post(
    '/api/runs/:id/tick',
    route(async (request) => {
      const started = performance.now();
      const owner = ownerKey(request);
      const id = z.uuid().parse(request.params.id);
      const input = tickInputSchema.parse(request.body);
      const run = await loadRunRow(pool, owner, id);
      if (await hasRequest(pool, id, input.requestId)) return loadRunView(pool, owner, id);
      if (run.revision !== input.expectedRevision)
        throw new HttpError(409, 'The run changed in another request. Refresh before deciding.');
      if (run.tick >= 60)
        throw new HttpError(409, 'This run is complete. Reset to start a new run; history is retained.');
      const prepared = prepareTurn(run.state);
      const before = snapshot(prepared);
      const sop = await loadSop(pool, run.sop_version);
      const payload = buildDecisionRequest(before, sop);
      const { raw, apiMs } = await callAiDecide(payload);
      const answers = parseAnswers(raw, payload);
      const candidate = buildCandidates(before).find((option) => option.id === answers.next_action.choice);
      if (!candidate) throw new HttpError(502, 'The returned decision was not one of the offered actions.');
      const { state, outcome } = applyAction(prepared, candidate);
      const after = snapshot(state);
      const client = await pool.connect();
      let changed = false;
      try {
        await client.query('BEGIN');
        const updated = await client.query<{ id: string }>(
          `UPDATE deviceops_sim.simulation_runs
         SET state = $1::jsonb, tick = $2, revision = revision + 1, updated_at = NOW()
         WHERE id = $3 AND owner_key = $4 AND revision = $5 RETURNING id`,
          [JSON.stringify(state), state.tick, id, owner, input.expectedRevision]
        );
        changed = updated.rows.length > 0;
        if (changed) {
          await client.query(
            `INSERT INTO deviceops_sim.simulation_steps
           (run_id, turn, request_id, request, raw_response, selected_action, before_snapshot,
            after_snapshot, outcome, api_ms, tick_ms)
           VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7::jsonb, $8::jsonb, $9, $10, $11)`,
            [
              id,
              state.tick,
              input.requestId,
              JSON.stringify(payload),
              JSON.stringify(raw),
              candidate.id,
              JSON.stringify(before),
              JSON.stringify(after),
              JSON.stringify(outcome),
              apiMs,
              Math.round(performance.now() - started),
            ]
          );
          await client.query('COMMIT');
        } else {
          await client.query('ROLLBACK');
        }
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
      if (!changed && !(await hasRequest(pool, id, input.requestId))) {
        throw new HttpError(
          409,
          'The run changed while AI was deciding. This response was not applied. Refresh and try again.'
        );
      }
      return loadRunView(pool, owner, id);
    })
  );
}
