import {
  ALERT_ROUTES,
  type AlertDecisionRequest,
  type AlertGameMode,
  type AlertGameSnapshot,
  type AlertGameStats,
  type AlertOutcome,
  type AlertRoute,
  type AlertSource,
  type DeviceAlert,
  type ImagingDevice,
} from '../shared/alerts';
import type { Policy } from '../shared/types';
import { ALERT_POLICY } from './alert-policy';
import { HttpError } from './errors';

export const SHIFT_DURATION_MS = 60_000;
export const ALERT_WINDOW_MS = 15_000;

interface StoredAlert {
  observed: DeviceAlert;
  expectedRoute: AlertRoute;
  explanation: string;
}

interface AlertTemplate {
  modality: ImagingDevice['modality'];
  headline: string;
  signal: string;
  diagnostics: DeviceAlert['diagnostics'];
  remoteReview: DeviceAlert['remoteReview'];
  notes: string[];
  expectedRoute: AlertRoute;
  explanation: string;
}

export interface AlertGameState {
  seed: number;
  mode: AlertGameMode;
  elapsedMs: number;
  anchorMs: number | null;
  turn: number;
  nextArrival: number;
  devices: ImagingDevice[];
  schedule: StoredAlert[];
  alerts: StoredAlert[];
  stats: AlertGameStats;
}

const TEMPLATES: AlertTemplate[] = [
  {
    modality: 'MR',
    headline: 'Cooling airflow advisory',
    signal: 'A synthetic upstream monitor reported reduced RF cooling airflow.',
    diagnostics: 'available',
    remoteReview: 'not_started',
    notes: [
      'Current diagnostics are attached. The filter has not been inspected and no engineer has assessed this yet.',
      'A local visit was discussed, but NOT requested. Current logs are available for a remote investigation.',
    ],
    expectedRoute: 'remote_review',
    explanation:
      'Fresh evidence is available, but the cause is unconfirmed and no physical inspection was recommended.',
  },
  {
    modality: 'MR',
    headline: 'Physical inspection follow-up',
    signal: 'The same synthetic cooling advisory appeared after a remote troubleshooting session.',
    diagnostics: 'available',
    remoteReview: 'completed',
    notes: [
      'Remote engineer: checks are complete. A local inspection of the intake/filter assembly is needed; no visit is booked.',
      'Remote tests are complete. The specialist recommends hands-on inspection of the cooling cabinet, not another remote session.',
    ],
    expectedRoute: 'field_review',
    explanation:
      'An engineer has already reviewed the evidence and recommended physical inspection. Handoff is not dispatch.',
  },
  {
    modality: 'MR',
    headline: 'Incomplete operator report',
    signal: 'An operator opened a technical ticket; no diagnostic event is confirmed.',
    diagnostics: 'missing',
    remoteReview: 'not_started',
    notes: [
      'The ticket only says “sounds different.” No event log or current diagnostics were uploaded.',
      '“Same issue again,” says the note. The upload is blank; yesterday’s suspicion is not current evidence.',
    ],
    expectedRoute: 'request_details',
    explanation:
      'The note is incomplete and diagnostic evidence is missing. Request evidence instead of guessing a cause.',
  },
  {
    modality: 'CT',
    headline: 'Service software exception',
    signal: 'A synthetic service-software event log contains a recurring exception.',
    diagnostics: 'available',
    remoteReview: 'not_started',
    notes: [
      'Current logs are attached. Remote access can be arranged; no physical inspection has been requested.',
      'The operator asks whether a site visit is needed. Nobody has reviewed the fresh diagnostic bundle yet.',
    ],
    expectedRoute: 'remote_review',
    explanation: 'Current diagnostic evidence supports a remote engineering investigation, not a guessed repair.',
  },
  {
    modality: 'CT',
    headline: 'Engineering handoff',
    signal: 'A synthetic component-condition advisory has an existing engineering review.',
    diagnostics: 'available',
    remoteReview: 'completed',
    notes: [
      'Engineer reviewed the advisory and recommends an on-site inspection. The service desk still needs to review the handoff.',
      'Remote specialist: log review complete; follow-up requires physical inspection. This is a recommendation, not a diagnosis.',
    ],
    expectedRoute: 'field_review',
    explanation:
      'Completed engineering review explicitly requests physical inspection. Route the existing recommendation.',
  },
  {
    modality: 'MR',
    headline: 'Stale diagnostic attachment',
    signal: 'A new synthetic advisory arrived with an older diagnostic bundle.',
    diagnostics: 'stale',
    remoteReview: 'not_started',
    notes: [
      'This alert is from today, but the attached logs are from last week. “That was the previous issue,” the technician adds.',
      'The old ticket mentions a possible filter issue. No current logs are attached and no new engineering review exists.',
    ],
    expectedRoute: 'request_details',
    explanation:
      'Old logs and an earlier suspicion do not establish the current service path. Request fresh diagnostics.',
  },
];

function createDevices(): ImagingDevice[] {
  return Array.from({ length: 12 }, (_unused, index) => ({
    id: `${index < 6 ? 'MR' : 'CT'}-${String((index % 6) + 1).padStart(2, '0')}`,
    modality: index < 6 ? 'MR' : 'CT',
    site: ['Harbor Imaging', 'Oakridge Imaging', 'Cedar Imaging'][Math.floor(index / 4)],
  }));
}

export function createAlertGame(seed: number, mode: AlertGameMode): AlertGameState {
  const devices = createDevices();
  let randomState = seed >>> 0;
  const nextRandom = () => {
    randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
    return randomState;
  };
  const interval = mode === 'storm' ? 2000 : 4000;
  const schedule = Array.from({ length: Math.ceil(SHIFT_DURATION_MS / interval) }, (_unused, index): StoredAlert => {
    const template = TEMPLATES[index < 3 ? index : nextRandom() % TEMPLATES.length];
    const eligible = devices.filter((device) => device.modality === template.modality);
    const device = eligible[nextRandom() % eligible.length];
    const arrivedAtMs = index * interval;
    return {
      observed: {
        id: `AL-${String(index + 1).padStart(3, '0')}`,
        deviceId: device.id,
        headline: template.headline,
        signal: template.signal,
        technicianNote: template.notes[nextRandom() % template.notes.length],
        diagnostics: template.diagnostics,
        remoteReview: template.remoteReview,
        arrivedAtMs,
        dueAtMs: Math.min(SHIFT_DURATION_MS, arrivedAtMs + ALERT_WINDOW_MS),
        status: 'queued',
        route: null,
        source: null,
        result: null,
      },
      expectedRoute: template.expectedRoute,
      explanation: template.explanation,
    };
  });
  return advanceAlertGame(
    {
      seed,
      mode,
      elapsedMs: 0,
      anchorMs: null,
      turn: 0,
      nextArrival: 0,
      devices,
      schedule,
      alerts: [],
      stats: { score: 0, routed: 0, matches: 0, mismatches: 0, missed: 0, streak: 0, bestStreak: 0 },
    },
    0
  );
}

export function advanceAlertGame(source: AlertGameState, nowMs: number): AlertGameState {
  const state = structuredClone(source);
  if (state.anchorMs !== null) {
    state.elapsedMs = Math.min(SHIFT_DURATION_MS, state.elapsedMs + Math.max(0, nowMs - state.anchorMs));
    state.anchorMs = nowMs;
  }
  while (state.nextArrival < state.schedule.length) {
    const scheduled = state.schedule[state.nextArrival];
    if (scheduled.observed.arrivedAtMs > state.elapsedMs) break;
    state.alerts.push(structuredClone(scheduled));
    state.nextArrival += 1;
  }
  for (const alert of state.alerts) {
    if (alert.observed.status !== 'queued' || alert.observed.dueAtMs > state.elapsedMs) continue;
    alert.observed.status = 'expired';
    state.stats.missed += 1;
    state.stats.score -= 2;
    state.stats.streak = 0;
  }
  if (state.elapsedMs >= SHIFT_DURATION_MS) state.anchorMs = null;
  return state;
}

export function setAlertClock(source: AlertGameState, running: boolean, nowMs: number): AlertGameState {
  const state = advanceAlertGame(source, nowMs);
  if (running && state.elapsedMs >= SHIFT_DURATION_MS) {
    throw new HttpError(409, 'This game shift is complete. Start a new shift; its history is retained.');
  }
  state.anchorMs = running ? nowMs : null;
  return state;
}

export function alertSnapshot(state: AlertGameState): AlertGameSnapshot {
  const alerts = state.alerts.map((alert) => structuredClone(alert.observed));
  return {
    elapsedMs: state.elapsedMs,
    durationMs: SHIFT_DURATION_MS,
    running: state.anchorMs !== null,
    complete: state.elapsedMs >= SHIFT_DURATION_MS,
    devices: structuredClone(state.devices),
    alerts,
    nextArrivalMs: state.schedule[state.nextArrival]?.observed.arrivedAtMs ?? null,
    pending: alerts.filter((alert) => alert.status === 'queued').length,
    routeCounts: Object.fromEntries(
      ALERT_ROUTES.map((route) => [route.id, alerts.filter((alert) => alert.route === route.id).length])
    ) as Record<AlertRoute, number>,
    stats: structuredClone(state.stats),
  };
}

export function buildAlertRequest(
  state: AlertGameState,
  alertId: string,
  policy: Policy = ALERT_POLICY
): AlertDecisionRequest {
  const selected = state.alerts.find((alert) => alert.observed.id === alertId)?.observed;
  if (!selected || selected.status !== 'queued') {
    throw new HttpError(409, 'This alert is no longer waiting. Refresh the queue before triaging.');
  }
  const device = state.devices.find((entry) => entry.id === selected.deviceId);
  if (!device) throw new HttpError(503, 'The alert device is missing from the saved game.');
  const { id, deviceId, headline, signal, technicianNote, diagnostics, remoteReview } = selected;
  return {
    state: {
      alert: { id, deviceId, headline, signal, technicianNote, diagnostics, remoteReview },
      device: structuredClone(device),
      routingPolicy: structuredClone(policy),
      scope:
        'Choose one technical service handoff for a synthetic medical-imaging device. Investigation happens after routing.',
    },
    questions: {
      next_action: {
        type: 'choice',
        instructions:
          'Which service queue should receive this alert? Follow the routing policy and interpret the complete note. Do not diagnose the cause.',
        criteria: Object.fromEntries(ALERT_ROUTES.map((route) => [route.id, `${route.label}: ${route.description}`])),
      },
    },
    options: { version: '1.0' },
  };
}

export function nextAlertRequest(state: AlertGameState, policy: Policy = ALERT_POLICY) {
  const alert = state.alerts.find((entry) => entry.observed.status === 'queued');
  return alert ? { alertId: alert.observed.id, request: buildAlertRequest(state, alert.observed.id, policy) } : null;
}

export function applyAlertRoute(
  source: AlertGameState,
  alertId: string,
  route: AlertRoute,
  routedBy: AlertSource
): { state: AlertGameState; outcome: AlertOutcome } {
  const state = structuredClone(source);
  const alert = state.alerts.find((entry) => entry.observed.id === alertId);
  if (!alert || alert.observed.status === 'routed') {
    throw new HttpError(409, 'This alert was already routed or is unavailable. No duplicate handoff was applied.');
  }
  state.turn += 1;
  const responseMs = Math.max(0, state.elapsedMs - alert.observed.arrivedAtMs);
  if (alert.observed.status === 'expired') {
    return {
      state,
      outcome: {
        kind: 'late',
        message:
          'The response arrived after the game deadline. No handoff was applied; the missed alert was already counted.',
        expectedRoute: alert.expectedRoute,
        explanation: alert.explanation,
        points: 0,
        responseMs,
      },
    };
  }
  const matched = route === alert.expectedRoute;
  const points = matched ? 10 + (responseMs <= 6000 ? 3 : 0) : -4;
  Object.assign(alert.observed, {
    status: 'routed',
    route,
    source: routedBy,
    result: matched ? 'match' : 'mismatch',
  } satisfies Partial<DeviceAlert>);
  state.stats.routed += 1;
  state.stats.matches += matched ? 1 : 0;
  state.stats.mismatches += matched ? 0 : 1;
  state.stats.score += points;
  state.stats.streak = matched ? state.stats.streak + 1 : 0;
  state.stats.bestStreak = Math.max(state.stats.bestStreak, state.stats.streak);
  const label = ALERT_ROUTES.find((entry) => entry.id === route)?.label ?? route;
  return {
    state,
    outcome: {
      kind: matched ? 'match' : 'mismatch',
      message: `${alertId} handed to ${label}. ${matched ? 'Matches' : 'Does not match'} the synthetic routing rubric. No device was repaired or controlled.`,
      expectedRoute: alert.expectedRoute,
      explanation: alert.explanation,
      points,
      responseMs,
    },
  };
}
