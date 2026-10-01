import { randomUUID } from 'node:crypto';
import type { LakebasePool } from '@databricks/appkit';
import type { Application } from 'express';
import { z } from 'zod';
import type { AlertGameStep, AlertRoute } from '../shared/alerts';
import { ALERT_ROUTES } from '../shared/alerts';
import { callAiDecide } from './ai-decide';
import {
  advanceAlertGame,
  alertSnapshot,
  applyAlertRoute,
  buildAlertRequest,
  createAlertGame,
  setAlertClock,
} from './alert-game';
import { ALERT_POLICY } from './alert-policy';
import {
  loadAlertGameRow,
  loadAlertGameView,
  loadAlertStep,
  loadAlertSteps,
  savedAlertRequest,
  saveAlertGameState,
  summarizeAlertGame,
  type AlertGameRow,
} from './alert-store';
import { parseAnswers } from './decisions';
import { HttpError } from './errors';
import { ownerKey, route } from './routes';
import { loadSop } from './run-store';

export const newAlertGameSchema = z.object({
  seed: z.number().int().min(0).max(2147483647).default(42),
  mode: z.enum(['steady', 'storm']).default('steady'),
  requestId: z.uuid().optional(),
});
export const alertTriageSchema = z.object({
  alertId: z.string().regex(/^AL-\d{3}$/),
  requestId: z.uuid(),
  route: z.enum(['remote_review', 'field_review', 'request_details']).optional(),
});

async function changeClock(pool: LakebasePool, owner: string, id: string, running: boolean) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const row = await loadAlertGameRow(client, owner, id, true);
    await saveAlertGameState(client, row, setAlertClock(row.state, running, Date.now()));
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export function registerAlertRoutes(app: Application, pool: LakebasePool) {
  app.get(
    '/api/alert-games',
    route(async (request) => {
      const owner = ownerKey(request);
      const { rows } = await pool.query<AlertGameRow>(
        'SELECT * FROM deviceops_sim.alert_game_runs WHERE owner_key = $1 ORDER BY updated_at DESC LIMIT 10',
        [owner]
      );
      return {
        policyVersion: ALERT_POLICY.version,
        runs: rows.map(summarizeAlertGame),
        run: rows[0] ? await loadAlertGameView(pool, owner, rows[0].id) : null,
      };
    })
  );

  app.post(
    '/api/alert-games',
    route(async (request) => {
      const owner = ownerKey(request);
      const input = newAlertGameSchema.parse(request.body);
      const id = input.requestId ?? randomUUID();
      await pool.query(
        `INSERT INTO deviceops_sim.alert_game_runs(id, owner_key, seed, mode, policy_version, state)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb) ON CONFLICT (id) DO NOTHING`,
        [
          id,
          owner,
          input.seed,
          input.mode,
          ALERT_POLICY.version,
          JSON.stringify(createAlertGame(input.seed, input.mode)),
        ]
      );
      const existing = await loadAlertGameRow(pool, owner, id);
      if (existing.seed !== input.seed || existing.mode !== input.mode) {
        throw new HttpError(409, 'That request ID already belongs to a shift with different settings.');
      }
      return loadAlertGameView(pool, owner, id);
    })
  );

  app.get(
    '/api/alert-games/:id',
    route((request) => loadAlertGameView(pool, ownerKey(request), z.uuid().parse(request.params.id)))
  );

  app.post(
    '/api/alert-games/:id/clock',
    route(async (request) => {
      const owner = ownerKey(request);
      const id = z.uuid().parse(request.params.id);
      const input = z.object({ running: z.boolean() }).parse(request.body);
      await changeClock(pool, owner, id, input.running);
      return loadAlertGameView(pool, owner, id);
    })
  );

  app.get(
    '/api/alert-games/:id/steps',
    route((request) => loadAlertSteps(pool, ownerKey(request), z.uuid().parse(request.params.id)))
  );

  app.get(
    '/api/alert-games/:id/steps/:turn',
    route((request) =>
      loadAlertStep(
        pool,
        ownerKey(request),
        z.uuid().parse(request.params.id),
        z.coerce.number().int().min(1).max(60).parse(request.params.turn)
      )
    )
  );

  app.post(
    '/api/alert-games/:id/triage',
    route(async (request) => {
      const started = performance.now();
      const owner = ownerKey(request);
      const id = z.uuid().parse(request.params.id);
      const input = alertTriageSchema.parse(request.body);
      const row = await loadAlertGameRow(pool, owner, id);
      const saved = await savedAlertRequest(pool, id, input.requestId);
      if (saved) {
        if (
          saved.alertId !== input.alertId ||
          saved.source !== (input.route ? 'human' : 'ai') ||
          (input.route && saved.selectedAction !== input.route)
        ) {
          throw new HttpError(409, 'This retry ID belongs to a different handoff. No action was applied.');
        }
        return loadAlertGameView(pool, owner, id);
      }
      const beforeState = advanceAlertGame(row.state, Date.now());
      if (beforeState.anchorMs === null) {
        throw new HttpError(409, 'Start or resume the game clock before triaging an alert.');
      }
      const payload = buildAlertRequest(beforeState, input.alertId, await loadSop(pool, row.policy_version));
      let inference: { raw: unknown; apiMs: number } | null = null;
      let answers: ReturnType<typeof parseAnswers> | null = null;
      try {
        if (!input.route) {
          inference = await callAiDecide(payload);
          answers = parseAnswers(inference.raw, payload);
        }
      } catch (error) {
        await changeClock(pool, owner, id, false);
        throw error;
      }
      const selected = input.route ?? (answers?.next_action.choice as AlertRoute);
      if (!ALERT_ROUTES.some((entry) => entry.id === selected)) {
        await changeClock(pool, owner, id, false);
        throw new HttpError(502, 'AI selected a route outside the permitted handoffs. The game is paused.');
      }
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const current = await loadAlertGameRow(client, owner, id, true);
        const existing = await savedAlertRequest(client, id, input.requestId);
        if (!existing) {
          const latest = advanceAlertGame(current.state, Date.now());
          const source = input.route ? 'human' : 'ai';
          const result = applyAlertRoute(latest, input.alertId, selected, source);
          const step: AlertGameStep = {
            turn: result.state.turn,
            requestId: input.requestId,
            alertId: input.alertId,
            selectedAction: selected,
            actionLabel: ALERT_ROUTES.find((entry) => entry.id === selected)!.label,
            source,
            outcome: result.outcome,
            apiMs: inference?.apiMs ?? null,
            totalMs: Math.round(performance.now() - started),
            createdAt: new Date().toISOString(),
            request: payload,
            rawResponse: inference?.raw ?? null,
            answers,
            beforeSnapshot: alertSnapshot(beforeState),
            afterSnapshot: alertSnapshot(result.state),
          };
          await saveAlertGameState(client, current, result.state);
          await client.query(
            `INSERT INTO deviceops_sim.alert_game_steps(run_id, turn, request_id, detail)
             VALUES ($1, $2, $3, $4::jsonb)`,
            [id, step.turn, input.requestId, JSON.stringify(step)]
          );
        } else if (
          existing.alertId !== input.alertId ||
          existing.selectedAction !== selected ||
          existing.source !== (input.route ? 'human' : 'ai')
        ) {
          throw new HttpError(409, 'This request ID already records a different handoff.');
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
      return loadAlertGameView(pool, owner, id);
    })
  );
}
