import type { DecisionAnswers, DecisionRequest, Policy } from './types';

export type AlertRoute = 'remote_review' | 'field_review' | 'request_details';
export type AlertGameMode = 'steady' | 'storm';
export type AlertSource = 'ai' | 'human';

export const ALERT_ROUTES: { id: AlertRoute; label: string; description: string }[] = [
  {
    id: 'remote_review',
    label: 'Remote engineer',
    description: 'Send available diagnostic evidence to a remote engineer for investigation.',
  },
  {
    id: 'field_review',
    label: 'Field-service review',
    description: 'Hand off an existing engineer recommendation for physical inspection. No automatic dispatch.',
  },
  {
    id: 'request_details',
    label: 'Get more information',
    description: 'Request missing or stale diagnostics before choosing a service path.',
  },
];

export interface ImagingDevice {
  id: string;
  modality: 'MR' | 'CT';
  site: string;
}

export interface DeviceAlert {
  id: string;
  deviceId: string;
  headline: string;
  signal: string;
  technicianNote: string;
  diagnostics: 'available' | 'missing' | 'stale';
  remoteReview: 'not_started' | 'completed';
  arrivedAtMs: number;
  dueAtMs: number;
  status: 'queued' | 'routed' | 'expired';
  route: AlertRoute | null;
  source: AlertSource | null;
  result: 'match' | 'mismatch' | null;
}

export interface AlertGameStats {
  score: number;
  routed: number;
  matches: number;
  mismatches: number;
  missed: number;
  streak: number;
  bestStreak: number;
}

export interface AlertGameSnapshot {
  elapsedMs: number;
  durationMs: number;
  running: boolean;
  complete: boolean;
  devices: ImagingDevice[];
  alerts: DeviceAlert[];
  nextArrivalMs: number | null;
  pending: number;
  routeCounts: Record<AlertRoute, number>;
  stats: AlertGameStats;
}

export interface AlertDecisionRequest {
  state: {
    alert: Pick<
      DeviceAlert,
      'id' | 'deviceId' | 'headline' | 'signal' | 'technicianNote' | 'diagnostics' | 'remoteReview'
    >;
    device: ImagingDevice;
    routingPolicy: Policy;
    scope: string;
  };
  questions: Pick<DecisionRequest['questions'], 'next_action'>;
  options: { version: '1.0' };
}

export interface AlertOutcome {
  kind: 'match' | 'mismatch' | 'late';
  message: string;
  expectedRoute: AlertRoute;
  explanation: string;
  points: number;
  responseMs: number;
}

export interface AlertGameStepSummary {
  turn: number;
  requestId?: string;
  alertId: string;
  selectedAction: AlertRoute;
  actionLabel: string;
  source: AlertSource;
  outcome: AlertOutcome;
  apiMs: number | null;
  totalMs: number;
  createdAt: string;
}

export interface AlertGameStep extends AlertGameStepSummary {
  request: AlertDecisionRequest;
  rawResponse: unknown;
  answers: DecisionAnswers | null;
  beforeSnapshot: AlertGameSnapshot;
  afterSnapshot: AlertGameSnapshot;
}

export interface AlertGameSummary {
  id: string;
  seed: number;
  mode: AlertGameMode;
  revision: number;
  createdAt: string;
}

export interface AlertGameRun extends AlertGameSummary {
  policyVersion: string;
  snapshot: AlertGameSnapshot;
  nextDecision: { alertId: string; request: AlertDecisionRequest } | null;
  latestStep: AlertGameStep | null;
  timings: { aiDecisions: number; apiP50: number | null; apiP95: number | null };
  observedAt: string;
  updatedAt: string;
}

export interface AlertGameBootstrap {
  policyVersion: string;
  runs: AlertGameSummary[];
  run: AlertGameRun | null;
}
