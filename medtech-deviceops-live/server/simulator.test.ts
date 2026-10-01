import { describe, expect, it } from 'vitest';
import {
  applyAction,
  buildCandidates,
  createScenarioState,
  createState,
  injectEvent,
  prepareTurn,
  snapshot,
} from './simulator';
import { buildDecisionRequest, parseAnswers, percentile } from './decisions';
import { SOP } from './policy';
import type { Candidate } from '../shared/types';

function candidateFor(state: ReturnType<typeof createState>, kind: Candidate['kind']) {
  const candidate = buildCandidates(snapshot(state)).find((option) => option.kind === kind);
  if (!candidate) throw new Error(`Missing candidate ${kind}`);
  return candidate;
}

describe('synthetic analyzer loop', () => {
  it('starts with a healthy twelve-device fleet and a single wait candidate', () => {
    const state = createState(42);
    expect(snapshot(state).healthyCount).toBe(12);
    expect(buildCandidates(snapshot(state)).map((candidate) => candidate.id)).toEqual(['wait']);
  });
  it('is deterministic for a seed and does not mutate its input', () => {
    const original = createState(42);
    const first = injectEvent(original, 'isolated_fault');
    expect(first).toEqual(injectEvent(createState(42), 'isolated_fault'));
    expect(snapshot(original).healthyCount).toBe(12);
  });
  it('services an isolated equipment fault', () => {
    const damaged = injectEvent(createState(42), 'isolated_fault').state;
    const result = applyAction(damaged, candidateFor(damaged, 'service'));
    expect(result.outcome.kind).toBe('applied');
    expect(snapshot(result.state).healthyCount).toBe(12);
    expect(result.state.completedActions).toBe(1);
  });
  it('keeps a wrong equipment-service action visible without fixing shared-lot QC', () => {
    const damaged = injectEvent(createState(42), 'lot_qc').state;
    const result = applyAction(damaged, candidateFor(damaged, 'service'));
    expect(result.outcome.kind).toBe('no_change');
    expect(snapshot(result.state).healthyCount).toBe(10);
    expect(snapshot(result.state).devices.filter((device) => device.qc === 'failed')).toHaveLength(2);
  });
  it('resolves review only with a separately labeled synthetic reviewer two turns later', () => {
    const damaged = injectEvent(createState(42), 'lot_qc').state;
    const held = applyAction(damaged, candidateFor(damaged, 'review')).state;
    expect(held.completedActions).toBe(0);
    expect(snapshot(held).pendingTasks).toHaveLength(1);
    const next = prepareTurn(held);
    expect(snapshot(next).devices.filter((device) => device.status === 'review')).toHaveLength(4);
    const resolved = prepareTurn(next);
    expect(snapshot(resolved).healthyCount).toBe(12);
    expect(resolved.completedActions).toBe(1);
    expect(
      resolved.events.some(
        (event) => event.kind === 'simulated_reviewer' && event.message.includes('No product release')
      )
    ).toBe(true);
  });
  it('returns missing observations on the following turn', () => {
    const damaged = injectEvent(createState(42), 'ambiguous_report').state;
    const requested = applyAction(damaged, candidateFor(damaged, 'clarify')).state;
    expect(snapshot(requested).pendingTasks[0]?.kind).toBe('information');
    const next = prepareTurn(requested);
    expect(next.informationRequests).toHaveLength(0);
    expect(next.events.some((event) => event.kind === 'simulated_clarification')).toBe(true);
    expect(snapshot(next).devices.some((device) => device.status === 'ambiguous')).toBe(false);
  });
  it('adds seeded issues every fourth turn and enforces the cap', () => {
    let state = createState(42);
    for (let index = 0; index < 3; index += 1) state = prepareTurn(state);
    expect(snapshot(state).healthyCount).toBe(12);
    state = prepareTurn(state);
    expect(snapshot(state).healthyCount).toBeLessThan(12);
    state.tick = 60;
    expect(() => prepareTurn(state)).toThrow('60-turn');
  });
  it('never puts private causes, RNG state, or an expected answer into AI context', () => {
    const damaged = injectEvent(createState(42), 'ambiguous_report').state;
    const request = buildDecisionRequest(snapshot(damaged), SOP);
    const serialized = JSON.stringify(request);
    for (const privateKey of ['clarificationCause', '"cause"', 'randomState', 'expectedAction'])
      expect(serialized).not.toContain(privateKey);
    expect(request.options.version).toBe('1.0');
    expect(Object.values(request.questions).map((question) => question.type)).toEqual(['choice']);
  });
  it('starts each story with its incident ready, without advancing or deciding', () => {
    for (const scenario of ['lot_qc', 'isolated_fault', 'ambiguous_report'] as const) {
      const state = createScenarioState(42, scenario);
      expect(state.scenario).toBe(scenario);
      expect(state.tick).toBe(0);
      expect(snapshot(state).healthyCount).toBeLessThan(12);
      expect(state.events).toHaveLength(1);
      expect(state.events[0].kind).toBe(scenario);
      expect(state.completedActions).toBe(0);
    }
  });
  it('sends only affected devices and one choice question, not a dashboard snapshot', () => {
    const observed = snapshot(createScenarioState(42, 'lot_qc'));
    const original = structuredClone(observed);
    const request = buildDecisionRequest(observed, SOP);
    expect(Object.keys(request.questions)).toEqual(['next_action']);
    expect(request.state.devices).toHaveLength(2);
    expect(request.state.snapshot).toBeUndefined();
    expect(Object.keys(request.state.devices![0])).not.toContain('queue');
    expect(request.state.devices?.every((device) => device.qc === 'failed')).toBe(true);
    expect(observed).toEqual(original);
  });
  it('separates confirmed QC failures from missing observations in the public summary', () => {
    const incomplete = buildDecisionRequest(snapshot(injectEvent(createState(42), 'ambiguous_report').state), SOP);
    expect(Object.values(incomplete.state.observations.qcFailuresByLot).flat()).toHaveLength(0);
    expect(incomplete.state.observations.unconfirmedReportIds).toHaveLength(1);
    expect(incomplete.state.observations.reportedEquipmentFaultIds).toHaveLength(0);
    const sharedLot = buildDecisionRequest(snapshot(injectEvent(createState(42), 'lot_qc').state), SOP);
    expect(Object.values(sharedLot.state.observations.qcFailuresByLot).flat()).toHaveLength(2);
    expect(sharedLot.state.observations.unconfirmedReportIds).toHaveLength(0);
  });
  it('offers lot review only for a confirmed shared-lot QC pattern', () => {
    for (const kind of ['isolated_fault', 'ambiguous_report'] as const) {
      const observed = snapshot(injectEvent(createState(42), kind).state);
      expect(buildCandidates(observed).some((candidate) => candidate.kind === 'review')).toBe(false);
    }
    const sharedLot = snapshot(injectEvent(createState(42), 'lot_qc').state);
    expect(buildCandidates(sharedLot).some((candidate) => candidate.kind === 'review')).toBe(true);
    const failing = sharedLot.devices.find((device) => device.qc === 'failed');
    if (!failing) throw new Error('Expected a synthetic QC failure.');
    failing.qc = 'unknown';
    expect(buildCandidates(sharedLot).some((candidate) => candidate.kind === 'review')).toBe(false);
  });
  it('offers clarification only when observable measurements are missing', () => {
    const explicitFault = snapshot(injectEvent(createState(42), 'isolated_fault').state);
    const incomplete = snapshot(injectEvent(createState(42), 'ambiguous_report').state);
    expect(buildCandidates(explicitFault).some((candidate) => candidate.kind === 'clarify')).toBe(false);
    expect(buildCandidates(incomplete).some((candidate) => candidate.kind === 'clarify')).toBe(true);
    expect(buildCandidates(incomplete).some((candidate) => candidate.kind === 'service')).toBe(true);
  });
});

describe('decision response integrity', () => {
  const request = buildDecisionRequest(snapshot(createState(42)), SOP);
  const response = {
    response: {
      answers: {
        next_action: { type: 'choice', choice: 'wait', confidence: 0.95, probabilities: { wait: 1 } },
        quality_review_needed: { type: 'noul', probability: 0 },
        attention_priority: {
          type: 'score',
          score: 0,
          confidence: 1,
          probabilities: { '0': 1 },
          legend: { '0': 'Routine' },
        },
      },
    },
    metadata: { version: '1.0' },
  };
  it('accepts documented nested response shapes', () => {
    expect(parseAnswers(response, request).next_action.choice).toBe('wait');
  });
  it('accepts a choice-only response while retaining support for saved multi-question responses', () => {
    const choiceOnly = {
      response: { answers: { next_action: response.response.answers.next_action } },
      metadata: response.metadata,
    };
    expect(Object.keys(parseAnswers(choiceOnly, request))).toEqual(['next_action']);
    expect(parseAnswers(response, request).quality_review_needed?.probability).toBe(0);
    expect(parseAnswers(response, request).attention_priority?.score).toBe(0);
  });
  it('rejects choices that were not offered, including prototype property names', () => {
    for (const choice of ['service:unknown', 'toString']) {
      const altered = structuredClone(response);
      altered.response.answers.next_action.choice = choice;
      expect(() => parseAnswers(altered, request)).toThrow('outside');
    }
  });
  it('rejects malformed probabilities and out-of-range scores', () => {
    const altered = structuredClone(response);
    altered.response.answers.attention_priority.score = 9;
    expect(() => parseAnswers(altered, request)).toThrow('invalid');
    expect(() => parseAnswers({}, request)).toThrow('invalid');
  });
  it('calculates nearest-rank percentiles without fabricating empty values', () => {
    expect(percentile([], 0.95)).toBeNull();
    expect(percentile([300, 100, 200], 0.5)).toBe(200);
    expect(percentile([300, 100, 200], 0.95)).toBe(300);
  });
});
