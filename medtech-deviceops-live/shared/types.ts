export type DeviceStatus = 'healthy' | 'fault' | 'qc_issue' | 'ambiguous' | 'review';
export type ScenarioKind = 'isolated_fault' | 'lot_qc' | 'ambiguous_report';

export interface Analyzer {
  id: string;
  bay: string;
  lotId: string;
  status: DeviceStatus;
  qc: 'passed' | 'failed' | 'unknown' | 'pending';
  temperatureC: number | null;
  calibrationOffset: number | null;
  queue: number;
  report: string;
  pending: 'information' | 'review' | null;
}

export interface SimEvent {
  id: string;
  turn: number;
  kind: string;
  message: string;
}

export interface FleetSnapshot {
  turn: number;
  devices: Analyzer[];
  healthyCount: number;
  completedActions: number;
  trainingChecksProcessed: number;
  events: SimEvent[];
  pendingTasks: { kind: 'quality_review' | 'information'; target: string; scheduledTurn: number }[];
}

export interface Policy {
  version: string;
  title: string;
  scope: string;
  rules: readonly string[];
}

export interface Candidate {
  id: string;
  kind: 'service' | 'review' | 'clarify' | 'wait';
  label: string;
  description: string;
  deviceId?: string;
  lotId?: string;
}

export interface DecisionRequest {
  state: {
    observations: {
      qcFailuresByLot: Record<string, string[]>;
      reportedEquipmentFaultIds: string[];
      unconfirmedReportIds: string[];
      pendingResponseTargets: string[];
    };
    devices?: Pick<Analyzer, 'id' | 'lotId' | 'qc' | 'temperatureC' | 'calibrationOffset' | 'report' | 'pending'>[];
    snapshot?: FleetSnapshot;
    sop: Policy;
    scope: string;
  };
  questions: {
    next_action: { type: 'choice'; instructions: string; criteria: Record<string, string> };
    quality_review_needed?: {
      type: 'noul';
      instructions: string;
      criteria: { true: string; false: string };
    };
    attention_priority?: { type: 'score'; instructions: string; criteria: string[] };
  };
  options: { version: '1.0' };
}

export interface DecisionAnswers {
  next_action: {
    type: 'choice';
    choice: string;
    confidence: number;
    probabilities: Record<string, number>;
  };
  quality_review_needed?: { type: 'noul'; probability: number };
  attention_priority?: {
    type: 'score';
    score: number;
    confidence: number;
    probabilities: Record<string, number>;
    legend: Record<string, string>;
  };
}

export interface ActionOutcome {
  kind: 'applied' | 'no_change';
  message: string;
  affectedIds: string[];
}

export interface StepSummary {
  turn: number;
  selectedAction: string;
  actionLabel: string;
  outcome: ActionOutcome;
  apiMs: number;
  tickMs: number;
  createdAt: string;
}

export interface StepDetail extends StepSummary {
  request: DecisionRequest;
  rawResponse: unknown;
  answers: DecisionAnswers;
  beforeSnapshot: FleetSnapshot;
  afterSnapshot: FleetSnapshot;
  candidates: Candidate[];
}

export interface RunSummary {
  id: string;
  seed: number;
  tick: number;
  createdAt: string;
}

export interface RunView extends RunSummary {
  revision: number;
  sopVersion: string;
  scenario: ScenarioKind | null;
  snapshot: FleetSnapshot;
  latestStep: StepDetail | null;
  nextDecision: { request: DecisionRequest; beforeSnapshot: FleetSnapshot } | null;
  stats: { decisions: number; apiP50: number | null; apiP95: number | null };
  updatedAt: string;
}

export interface Bootstrap {
  policyVersion: string;
  runs: RunSummary[];
  run: RunView | null;
  preview: FleetSnapshot;
}

export interface TickInput {
  expectedRevision: number;
  requestId: string;
}

export interface Health {
  status: string;
  lakebase: string;
  schema: string;
  identity: string;
  schemaOwnedByCaller: boolean;
}
