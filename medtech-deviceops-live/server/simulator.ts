import type { ActionOutcome, Analyzer, Candidate, FleetSnapshot, ScenarioKind, SimEvent } from '../shared/types';

interface PrivateDevice {
  observed: Analyzer;
  cause: 'equipment' | 'reagent' | 'ambiguous' | null;
  clarificationCause: 'equipment' | 'reagent' | null;
}

export interface SimulatorState {
  scenario?: ScenarioKind;
  tick: number;
  randomState: number;
  eventSeq: number;
  devices: PrivateDevice[];
  completedActions: number;
  trainingChecksProcessed: number;
  events: SimEvent[];
  lotReviews: { lotId: string; dueTurn: number }[];
  informationRequests: { deviceId: string; dueTurn: number }[];
}

function random(state: SimulatorState) {
  state.randomState = (Math.imul(state.randomState, 1664525) + 1013904223) >>> 0;
  return state.randomState / 4294967296;
}

function appendEvent(state: SimulatorState, kind: string, message: string) {
  state.eventSeq += 1;
  state.events = [...state.events, { id: `event-${state.eventSeq}`, turn: state.tick, kind, message }].slice(-12);
}

function restoreDevice(device: PrivateDevice) {
  device.cause = null;
  device.clarificationCause = null;
  Object.assign(device.observed, {
    status: 'healthy',
    qc: 'passed',
    temperatureC: 36.4,
    calibrationOffset: 0.04,
    pending: null,
    report: 'Training controls passed. No equipment alerts.',
  } satisfies Partial<Analyzer>);
}

function markEquipmentFault(device: PrivateDevice) {
  device.cause = 'equipment';
  Object.assign(device.observed, {
    status: 'fault',
    qc: 'passed',
    temperatureC: 39.1,
    calibrationOffset: 0.86,
    pending: null,
    report: 'Rotor calibration drift reported. Training QC controls passed; no reagent fault reported.',
  } satisfies Partial<Analyzer>);
}

function markQcFailure(device: PrivateDevice) {
  device.cause = 'reagent';
  Object.assign(device.observed, {
    status: 'qc_issue',
    qc: 'failed',
    temperatureC: 36.4,
    calibrationOffset: 0.04,
    pending: null,
    report: 'Training QC controls failed on this reagent lot. Equipment telemetry remains normal.',
  } satisfies Partial<Analyzer>);
}

export function createState(seed: number): SimulatorState {
  return {
    tick: 0,
    randomState: seed >>> 0,
    eventSeq: 0,
    devices: Array.from({ length: 12 }, (_unused, index) => ({
      observed: {
        id: `AN-${String(index + 1).padStart(2, '0')}`,
        bay: `${String.fromCharCode(65 + Math.floor(index / 4))}${(index % 4) + 1}`,
        lotId: ['RG-214', 'RG-215', 'RG-216'][index % 3],
        status: 'healthy',
        qc: 'passed',
        temperatureC: Math.round((36.2 + (index % 4) * 0.1) * 10) / 10,
        calibrationOffset: 0.04,
        queue: 12 + ((seed + index * 7) % 18),
        report: 'Training controls passed. No equipment alerts.',
        pending: null,
      },
      cause: null,
      clarificationCause: null,
    })),
    completedActions: 0,
    trainingChecksProcessed: 0,
    events: [],
    lotReviews: [],
    informationRequests: [],
  };
}

export function snapshot(state: SimulatorState): FleetSnapshot {
  return {
    turn: state.tick,
    devices: structuredClone(state.devices.map((device) => device.observed)),
    healthyCount: state.devices.filter((device) => device.observed.status === 'healthy').length,
    completedActions: state.completedActions,
    trainingChecksProcessed: state.trainingChecksProcessed,
    events: structuredClone(state.events),
    pendingTasks: [
      ...state.lotReviews.map((review) => ({
        kind: 'quality_review' as const,
        target: review.lotId,
        scheduledTurn: review.dueTurn,
      })),
      ...state.informationRequests.map((request) => ({
        kind: 'information' as const,
        target: request.deviceId,
        scheduledTurn: request.dueTurn,
      })),
    ],
  };
}

export function injectEvent(source: SimulatorState, kind: ScenarioKind) {
  const state = structuredClone(source);
  const available = state.devices.filter((device) => device.observed.status === 'healthy');
  if (!available.length)
    return { state, injected: false, message: 'No healthy analyzer is available for this scenario.' };
  const target = available[Math.floor(random(state) * available.length)];
  let message: string;
  if (kind === 'isolated_fault') {
    markEquipmentFault(target);
    message = `${target.observed.id} reports an isolated rotor calibration fault.`;
  } else if (kind === 'lot_qc') {
    const lotIds = [...new Set(available.map((device) => device.observed.lotId))].filter(
      (lotId) => available.filter((device) => device.observed.lotId === lotId).length >= 2
    );
    if (!lotIds.length)
      return { state, injected: false, message: 'This scenario needs two healthy analyzers on one lot.' };
    const lotId = lotIds[Math.floor(random(state) * lotIds.length)];
    const affected = available.filter((device) => device.observed.lotId === lotId).slice(0, 2);
    affected.forEach(markQcFailure);
    message = `${affected.map((device) => device.observed.id).join(' and ')} fail training QC on shared lot ${lotId}.`;
  } else {
    target.cause = 'ambiguous';
    target.clarificationCause = random(state) < 0.5 ? 'equipment' : 'reagent';
    Object.assign(target.observed, {
      status: 'ambiguous',
      qc: 'unknown',
      temperatureC: null,
      calibrationOffset: null,
      report:
        'Intermittent invalid control reading. Technician note incomplete; equipment versus reagent cause unconfirmed.',
    } satisfies Partial<Analyzer>);
    message = `${target.observed.id} receives an incomplete technician report. More information is needed.`;
  }
  appendEvent(state, kind, message);
  return { state, injected: true, message };
}

export function createScenarioState(seed: number, scenario: ScenarioKind): SimulatorState {
  return { ...injectEvent(createState(seed), scenario).state, scenario };
}

export function prepareTurn(source: SimulatorState): SimulatorState {
  if (source.tick >= 60) throw new Error('This run has reached its 60-turn limit.');
  let state = structuredClone(source);
  state.tick += 1;
  for (const review of state.lotReviews.filter((task) => task.dueTurn <= state.tick)) {
    const affected = state.devices.filter((device) => device.observed.lotId === review.lotId);
    affected.forEach(restoreDevice);
    state.completedActions += 1;
    appendEvent(
      state,
      'simulated_reviewer',
      `Synthetic reviewer event: ${review.lotId} receives replacement training reagent and passing controls. No product release or quality approval.`
    );
  }
  state.lotReviews = state.lotReviews.filter((task) => task.dueTurn > state.tick);
  for (const request of state.informationRequests.filter((task) => task.dueTurn <= state.tick)) {
    const target = state.devices.find((device) => device.observed.id === request.deviceId);
    if (!target || target.observed.pending !== 'information') continue;
    if (target.clarificationCause === 'reagent') {
      markQcFailure(target);
      const second = state.devices.find(
        (device) =>
          device.observed.id !== target.observed.id &&
          device.observed.lotId === target.observed.lotId &&
          device.observed.status === 'healthy'
      );
      if (second) markQcFailure(second);
      appendEvent(
        state,
        'simulated_clarification',
        `Synthetic technician response: ${target.observed.lotId} has repeated training QC failures; equipment readings are normal.`
      );
    } else {
      markEquipmentFault(target);
      appendEvent(
        state,
        'simulated_clarification',
        `Synthetic technician response: ${target.observed.id} has isolated rotor drift; reagent controls passed.`
      );
    }
    state.completedActions += 1;
  }
  state.informationRequests = state.informationRequests.filter((task) => task.dueTurn > state.tick);
  state.devices.forEach((device, index) => {
    const processed =
      device.observed.status === 'healthy' ? Math.min(device.observed.queue, 3 + ((state.tick + index) % 4)) : 0;
    state.trainingChecksProcessed += processed;
    device.observed.queue = Math.min(99, device.observed.queue - processed + 2);
  });
  if (state.tick % 4 === 0) {
    const kinds: ScenarioKind[] = ['isolated_fault', 'lot_qc', 'ambiguous_report'];
    state = injectEvent(state, kinds[Math.floor(random(state) * kinds.length)]).state;
  }
  return state;
}

export function buildCandidates(observed: FleetSnapshot): Candidate[] {
  const candidates: Candidate[] = [];
  const available = observed.devices.filter((device) => device.status !== 'healthy' && !device.pending);
  for (const lotId of [...new Set(available.map((device) => device.lotId))]) {
    if (observed.devices.filter((device) => device.lotId === lotId && device.qc === 'failed').length < 2) continue;
    candidates.push({
      id: `review:${lotId}`,
      kind: 'review',
      lotId,
      label: `Review lot ${lotId}`,
      description: `Place reagent lot ${lotId} on a simulated hold and ask a reviewer. Not quality approval.`,
    });
  }
  for (const device of available) {
    candidates.push({
      id: `service:${device.id}`,
      kind: 'service',
      deviceId: device.id,
      label: `Service ${device.id}`,
      description: `Service machine ${device.id}. This fixes equipment faults, not reagent issues.`,
    });
    if (device.qc === 'unknown' || device.temperatureC === null || device.calibrationOffset === null) {
      candidates.push({
        id: `clarify:${device.id}`,
        kind: 'clarify',
        deviceId: device.id,
        label: `Clarify ${device.id}`,
        description: `Ask a technician for missing measurements on ${device.id}.`,
      });
    }
  }
  return [
    ...candidates,
    {
      id: 'wait',
      kind: 'wait',
      label: 'Wait and observe',
      description: 'Wait for the next observation or a pending simulated response.',
    },
  ];
}

export function applyAction(
  source: SimulatorState,
  candidate: Candidate
): { state: SimulatorState; outcome: ActionOutcome } {
  const state = structuredClone(source);
  let outcome: ActionOutcome = {
    kind: 'no_change',
    message: 'No new action. The simulation waits for the next observation.',
    affectedIds: [],
  };
  if (candidate.kind === 'service') {
    const target = state.devices.find((device) => device.observed.id === candidate.deviceId);
    if (target?.cause === 'equipment' && !target.observed.pending) {
      restoreDevice(target);
      state.completedActions += 1;
      outcome = {
        kind: 'applied',
        message: `Simulated service restored ${target.observed.id}.`,
        affectedIds: [target.observed.id],
      };
    } else {
      outcome.message = `Service did not fix ${candidate.deviceId ?? 'the machine'}. The problem is still visible.`;
    }
  } else if (candidate.kind === 'review') {
    const affected = state.devices.filter((device) => device.observed.lotId === candidate.lotId);
    affected.forEach((device) => {
      device.observed.status = 'review';
      device.observed.pending = 'review';
      device.observed.qc = 'pending';
      device.observed.report =
        'Simulated hold. Synthetic quality reviewer response pending; no approval has been granted.';
    });
    state.informationRequests = state.informationRequests.filter(
      (request) => !affected.some((device) => device.observed.id === request.deviceId)
    );
    state.lotReviews.push({ lotId: candidate.lotId!, dueTurn: state.tick + 2 });
    outcome = {
      kind: 'applied',
      message: `${candidate.lotId ?? 'The reagent lot'} is on a simulated hold. A synthetic reviewer responds in two turns.`,
      affectedIds: affected.map((device) => device.observed.id),
    };
  } else if (candidate.kind === 'clarify') {
    const target = state.devices.find((device) => device.observed.id === candidate.deviceId);
    if (target) {
      target.observed.pending = 'information';
      if (!target.clarificationCause) target.clarificationCause = target.cause === 'reagent' ? 'reagent' : 'equipment';
      state.informationRequests.push({ deviceId: target.observed.id, dueTurn: state.tick + 1 });
      outcome = {
        kind: 'applied',
        message: `A technician was asked for missing measurements on ${target.observed.id}. Synthetic reply due next turn.`,
        affectedIds: [target.observed.id],
      };
    }
  }
  appendEvent(state, candidate.kind === 'wait' ? 'observation' : 'simulated_action', outcome.message);
  return { state, outcome };
}
