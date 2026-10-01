import type { LakebasePool } from '@databricks/appkit';
import type {
  ActionOutcome,
  Candidate,
  DecisionRequest,
  FleetSnapshot,
  Policy,
  RunSummary,
  RunView,
  StepDetail,
  StepSummary,
} from '../shared/types';
import type { SimulatorState } from './simulator';
import { prepareTurn, snapshot } from './simulator';
import { buildDecisionRequest, parseAnswers, percentile } from './decisions';
import { HttpError } from './errors';

type RunReader = Pick<LakebasePool, 'query'>;

export interface RunRow {
  id: string;
  owner_key: string;
  seed: number;
  tick: number;
  revision: number;
  sop_version: string;
  state: SimulatorState;
  created_at: Date;
  updated_at: Date;
}

interface StepRow {
  turn: number;
  selected_action: string;
  request: DecisionRequest;
  raw_response: unknown;
  before_snapshot: FleetSnapshot;
  after_snapshot: FleetSnapshot;
  outcome: string;
  api_ms: number;
  tick_ms: number;
  created_at: Date;
}

export function summarizeRun(row: RunRow): RunSummary {
  return { id: row.id, seed: row.seed, tick: row.tick, createdAt: row.created_at.toISOString() };
}

function savedCandidates(request: DecisionRequest): Candidate[] {
  return Object.entries(request.questions.next_action.criteria).map(([id, description]): Candidate => {
    if (id === 'wait') return { id, description, kind: 'wait', label: 'Wait and observe' };
    const [kind, target] = id.split(':');
    if (!target) throw new HttpError(502, 'A saved choice has an unsupported identifier.');
    if (kind === 'review') return { id, description, kind, lotId: target, label: `Review lot ${target}` };
    if (kind === 'service' || kind === 'clarify') {
      return {
        id,
        description,
        kind,
        deviceId: target,
        label: `${kind === 'service' ? 'Service' : 'Clarify'} ${target}`,
      };
    }
    throw new HttpError(502, 'A saved choice has an unsupported action type.');
  });
}

export function summarizeStep(row: StepRow): StepSummary {
  const candidate = savedCandidates(row.request).find((option) => option.id === row.selected_action);
  return {
    turn: row.turn,
    selectedAction: row.selected_action,
    actionLabel: candidate?.label ?? row.selected_action,
    outcome: JSON.parse(row.outcome) as ActionOutcome,
    apiMs: row.api_ms,
    tickMs: row.tick_ms,
    createdAt: row.created_at.toISOString(),
  };
}

export function detailStep(row: StepRow): StepDetail {
  return {
    ...summarizeStep(row),
    request: row.request,
    rawResponse: row.raw_response,
    answers: parseAnswers(row.raw_response, row.request),
    beforeSnapshot: row.before_snapshot,
    afterSnapshot: row.after_snapshot,
    candidates: savedCandidates(row.request),
  };
}

export async function loadRunRow(pool: RunReader, owner: string, id: string): Promise<RunRow> {
  const { rows } = await pool.query<RunRow>(
    'SELECT * FROM deviceops_sim.simulation_runs WHERE id = $1 AND owner_key = $2',
    [id, owner]
  );
  if (!rows[0]) throw new HttpError(404, 'This simulation run was not found for the signed-in user.');
  return rows[0];
}

export async function loadRunView(pool: RunReader, owner: string, id: string): Promise<RunView> {
  const row = await loadRunRow(pool, owner, id);
  const steps = await pool.query<StepRow>(
    'SELECT * FROM deviceops_sim.simulation_steps WHERE run_id = $1 AND turn = $2',
    [id, row.tick]
  );
  const timings = await pool.query<{ api_ms: number }>(
    'SELECT api_ms FROM deviceops_sim.simulation_steps WHERE run_id = $1 AND turn <= $2 ORDER BY turn',
    [id, row.tick]
  );
  const apiTimes = timings.rows.map((step) => step.api_ms);
  const beforeSnapshot = row.tick < 60 ? snapshot(prepareTurn(row.state)) : null;
  const nextDecision = beforeSnapshot
    ? { beforeSnapshot, request: buildDecisionRequest(beforeSnapshot, await loadSop(pool, row.sop_version)) }
    : null;
  const firstScenario = row.state.events.find((event) =>
    ['isolated_fault', 'lot_qc', 'ambiguous_report'].includes(event.kind)
  )?.kind;
  return {
    ...summarizeRun(row),
    revision: row.revision,
    sopVersion: row.sop_version,
    scenario: row.state.scenario ?? (firstScenario as RunView['scenario']) ?? null,
    snapshot: snapshot(row.state),
    latestStep: steps.rows[0] ? detailStep(steps.rows[0]) : null,
    nextDecision,
    stats: { decisions: apiTimes.length, apiP50: percentile(apiTimes, 0.5), apiP95: percentile(apiTimes, 0.95) },
    updatedAt: row.updated_at.toISOString(),
  };
}

export async function loadSteps(pool: RunReader, owner: string, id: string): Promise<StepSummary[]> {
  await loadRunRow(pool, owner, id);
  const { rows } = await pool.query<StepRow>(
    'SELECT * FROM deviceops_sim.simulation_steps WHERE run_id = $1 ORDER BY turn DESC LIMIT 60',
    [id]
  );
  return rows.map(summarizeStep);
}

export async function loadStep(pool: RunReader, owner: string, id: string, turn: number): Promise<StepDetail> {
  await loadRunRow(pool, owner, id);
  const { rows } = await pool.query<StepRow>(
    'SELECT * FROM deviceops_sim.simulation_steps WHERE run_id = $1 AND turn = $2',
    [id, turn]
  );
  if (!rows[0]) throw new HttpError(404, 'No saved decision exists for this turn.');
  return detailStep(rows[0]);
}

export async function hasRequest(pool: RunReader, id: string, requestId: string): Promise<boolean> {
  const { rows } = await pool.query<{ exists: boolean }>(
    'SELECT EXISTS(SELECT 1 FROM deviceops_sim.simulation_steps WHERE run_id = $1 AND request_id = $2) AS exists',
    [id, requestId]
  );
  return rows[0]?.exists ?? false;
}

export async function loadSop(pool: RunReader, version: string): Promise<Policy> {
  const { rows } = await pool.query<{ content: Policy }>(
    'SELECT content FROM deviceops_sim.sop_versions WHERE version = $1',
    [version]
  );
  if (!rows[0]) throw new HttpError(503, 'The saved SOP version is unavailable.');
  return rows[0].content;
}
