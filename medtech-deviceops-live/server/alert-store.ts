import type { LakebasePool } from '@databricks/appkit';
import type { AlertGameRun, AlertGameStep, AlertGameStepSummary, AlertGameSummary } from '../shared/alerts';
import { advanceAlertGame, alertSnapshot, nextAlertRequest, type AlertGameState } from './alert-game';
import { percentile } from './decisions';
import { HttpError } from './errors';
import { loadSop } from './run-store';

export type AlertGameReader = Pick<LakebasePool, 'query'>;

export interface AlertGameRow {
  id: string;
  owner_key: string;
  seed: number;
  mode: AlertGameSummary['mode'];
  revision: number;
  policy_version: string;
  state: AlertGameState;
  created_at: Date;
  updated_at: Date;
}

export function summarizeAlertGame(row: AlertGameRow): AlertGameSummary {
  return {
    id: row.id,
    seed: row.seed,
    mode: row.mode,
    revision: row.revision,
    createdAt: row.created_at.toISOString(),
  };
}

export async function loadAlertGameRow(
  pool: AlertGameReader,
  owner: string,
  id: string,
  lock = false
): Promise<AlertGameRow> {
  const { rows } = await pool.query<AlertGameRow>(
    `SELECT * FROM deviceops_sim.alert_game_runs WHERE id = $1 AND owner_key = $2${lock ? ' FOR UPDATE' : ''}`,
    [id, owner]
  );
  if (!rows[0]) throw new HttpError(404, 'This game shift was not found for the signed-in user.');
  return rows[0];
}

export async function savedAlertRequest(
  pool: AlertGameReader,
  runId: string,
  requestId: string
): Promise<AlertGameStep | null> {
  const { rows } = await pool.query<{ detail: AlertGameStep }>(
    'SELECT detail FROM deviceops_sim.alert_game_steps WHERE run_id = $1 AND request_id = $2',
    [runId, requestId]
  );
  return rows[0]?.detail ?? null;
}

export async function loadAlertGameView(
  pool: AlertGameReader,
  owner: string,
  id: string,
  nowMs = Date.now()
): Promise<AlertGameRun> {
  const row = await loadAlertGameRow(pool, owner, id);
  const { rows } = await pool.query<{ detail: AlertGameStep }>(
    'SELECT detail FROM deviceops_sim.alert_game_steps WHERE run_id = $1 AND turn <= $2 ORDER BY turn DESC LIMIT 1',
    [id, row.state.turn]
  );
  const timingRows = await pool.query<{ api_ms: number }>(
    `SELECT (detail->>'apiMs')::INTEGER AS api_ms FROM deviceops_sim.alert_game_steps
     WHERE run_id = $1 AND turn <= $2 AND detail->>'source' = 'ai' ORDER BY turn`,
    [id, row.state.turn]
  );
  const timings = timingRows.rows.map((entry) => entry.api_ms);
  const state = advanceAlertGame(row.state, nowMs);
  return {
    ...summarizeAlertGame(row),
    policyVersion: row.policy_version,
    snapshot: alertSnapshot(state),
    nextDecision: nextAlertRequest(state, await loadSop(pool, row.policy_version)),
    latestStep: rows[0]?.detail ?? null,
    timings: {
      aiDecisions: timings.length,
      apiP50: percentile(timings, 0.5),
      apiP95: percentile(timings, 0.95),
    },
    observedAt: new Date(nowMs).toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export async function loadAlertSteps(
  pool: AlertGameReader,
  owner: string,
  id: string
): Promise<AlertGameStepSummary[]> {
  await loadAlertGameRow(pool, owner, id);
  const { rows } = await pool.query<{ summary: AlertGameStepSummary }>(
    `SELECT detail - ARRAY['request', 'rawResponse', 'answers', 'beforeSnapshot', 'afterSnapshot'] AS summary
     FROM deviceops_sim.alert_game_steps WHERE run_id = $1 ORDER BY turn DESC LIMIT 60`,
    [id]
  );
  return rows.map((entry) => entry.summary);
}

export async function loadAlertStep(
  pool: AlertGameReader,
  owner: string,
  id: string,
  turn: number
): Promise<AlertGameStep> {
  await loadAlertGameRow(pool, owner, id);
  const { rows } = await pool.query<{ detail: AlertGameStep }>(
    'SELECT detail FROM deviceops_sim.alert_game_steps WHERE run_id = $1 AND turn = $2',
    [id, turn]
  );
  if (!rows[0]) throw new HttpError(404, 'No saved handoff exists for this turn.');
  return rows[0].detail;
}

export async function saveAlertGameState(pool: AlertGameReader, row: AlertGameRow, state: AlertGameState) {
  await pool.query(
    `UPDATE deviceops_sim.alert_game_runs
     SET state = $1::jsonb, revision = revision + 1, updated_at = NOW()
     WHERE id = $2 AND owner_key = $3`,
    [JSON.stringify(state), row.id, row.owner_key]
  );
}
