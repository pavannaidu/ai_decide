import { describe, expect, it } from 'vitest';
import { ALERT_ROUTES } from '../shared/alerts';
import {
  advanceAlertGame,
  alertSnapshot,
  applyAlertRoute,
  buildAlertRequest,
  createAlertGame,
  nextAlertRequest,
  setAlertClock,
  SHIFT_DURATION_MS,
} from './alert-game';
import { ALERT_POLICY } from './alert-policy';
import { parseAnswers } from './decisions';

describe('independent medical-device alert feed', () => {
  it('starts paused with a synthetic alert, without exposing the scoring answer key', () => {
    const state = createAlertGame(42, 'steady');
    const observed = alertSnapshot(state);
    expect(observed.running).toBe(false);
    expect(observed.devices).toHaveLength(12);
    expect(observed.alerts).toHaveLength(1);
    expect(observed.alerts[0].headline).toBe('Cooling airflow advisory');
    expect(JSON.stringify(observed)).not.toContain('expectedRoute');
    expect(JSON.stringify(observed)).not.toContain('explanation');
    expect(JSON.stringify(observed)).not.toContain('schedule');
  });

  it('arrives on wall-clock time even without a triage action or model response', () => {
    const initial = setAlertClock(createAlertGame(42, 'steady'), true, 1000);
    const advanced = advanceAlertGame(initial, 10_000);
    expect(advanced.elapsedMs).toBe(9000);
    expect(advanced.alerts).toHaveLength(3);
    expect(advanced.turn).toBe(0);
    expect(initial.alerts).toHaveLength(1);
    expect(initial.elapsedMs).toBe(0);
  });

  it('does not fast-forward time on pause and counts only resumed running time', () => {
    const initial = setAlertClock(createAlertGame(42, 'steady'), true, 1000);
    const paused = setAlertClock(initial, false, 5000);
    expect(advanceAlertGame(paused, 100_000).elapsedMs).toBe(4000);
    const resumed = setAlertClock(paused, true, 100_000);
    expect(advanceAlertGame(resumed, 102_000).elapsedMs).toBe(6000);
  });

  it('emits more alerts during a storm without changing the model contract', () => {
    const steady = advanceAlertGame(setAlertClock(createAlertGame(42, 'steady'), true, 1000), 10_000);
    const storm = advanceAlertGame(setAlertClock(createAlertGame(42, 'storm'), true, 1000), 10_000);
    expect(storm.alerts.length).toBeGreaterThan(steady.alerts.length);
    expect(nextAlertRequest(storm)?.request).toEqual(nextAlertRequest(steady)?.request);
  });

  it('expires each missed alert exactly once, without silently removing it', () => {
    const initial = setAlertClock(createAlertGame(42, 'steady'), true, 1000);
    const advanced = advanceAlertGame(initial, 16_000);
    expect(advanced.alerts[0].observed.status).toBe('expired');
    expect(advanced.stats.missed).toBe(1);
    expect(advanced.stats.score).toBe(-2);
    expect(advanceAlertGame(advanced, 16_000).stats).toEqual(advanced.stats);
    expect(alertSnapshot(advanced).alerts[0].status).toBe('expired');
  });

  it('stops at the game duration and does not silently start another shift', () => {
    const initial = setAlertClock(createAlertGame(42, 'storm'), true, 1000);
    const completed = advanceAlertGame(initial, 1_000_000);
    expect(completed.elapsedMs).toBe(SHIFT_DURATION_MS);
    expect(alertSnapshot(completed).complete).toBe(true);
    expect(completed.anchorMs).toBeNull();
    expect(completed.stats.missed).toBe(completed.schedule.length);
    expect(nextAlertRequest(completed)).toBeNull();
    expect(() => setAlertClock(completed, true, 1_000_001)).toThrow('complete');
  });

  it('is deterministic for a saved seed and mode', () => {
    expect(createAlertGame(42, 'storm')).toEqual(createAlertGame(42, 'storm'));
    expect(createAlertGame(42, 'steady').schedule).not.toEqual(createAlertGame(43, 'steady').schedule);
  });
});

describe('bounded service-queue decision', () => {
  it('offers only three handoffs and no diagnosis, repair, or device-control action', () => {
    const state = createAlertGame(42, 'steady');
    const request = buildAlertRequest(state, 'AL-001');
    expect(Object.keys(request.questions)).toEqual(['next_action']);
    expect(Object.keys(request.questions.next_action.criteria)).toEqual(ALERT_ROUTES.map((entry) => entry.id));
    expect(request.options.version).toBe('1.0');
    expect(request.state.routingPolicy.version).toBe(ALERT_POLICY.version);
    expect(JSON.stringify(request)).not.toContain('expectedRoute');
    expect(JSON.stringify(request)).not.toContain('dueAtMs');
    expect(JSON.stringify(request)).not.toContain('score');
  });

  it('keeps the exact preview payload stable while the independent game clock moves', () => {
    const initial = setAlertClock(createAlertGame(42, 'steady'), true, 1000);
    const before = buildAlertRequest(initial, 'AL-001');
    const later = buildAlertRequest(advanceAlertGame(initial, 8000), 'AL-001');
    expect(later).toEqual(before);
  });

  it('uses the saved policy content rather than inventing current policy rules', () => {
    const historic = { ...ALERT_POLICY, version: 'SAVED-EXAMPLE', rules: ['Historic rule.'] };
    expect(buildAlertRequest(createAlertGame(42, 'steady'), 'AL-001', historic).state.routingPolicy).toEqual(historic);
  });

  it('does not read the private rubric into the AI response parser', () => {
    const request = buildAlertRequest(createAlertGame(42, 'steady'), 'AL-001');
    const raw = {
      response: {
        answers: {
          next_action: {
            type: 'choice',
            choice: 'request_details',
            confidence: 0.7,
            probabilities: { request_details: 0.7, remote_review: 0.2, field_review: 0.1 },
          },
        },
      },
      metadata: { version: '1.0' },
    };
    expect(parseAnswers(raw, request).next_action.choice).toBe('request_details');
    expect(() =>
      parseAnswers(
        { ...raw, response: { answers: { next_action: { ...raw.response.answers.next_action, choice: 'repair' } } } },
        request
      )
    ).toThrow('outside');
  });
});

describe('honest simulated handoff results', () => {
  it('scores the first three cases against the synthetic rubric only', () => {
    let state = advanceAlertGame(setAlertClock(createAlertGame(42, 'steady'), true, 1000), 9500);
    for (const [alertId, route] of [
      ['AL-001', 'remote_review'],
      ['AL-002', 'field_review'],
      ['AL-003', 'request_details'],
    ] as const) {
      const result = applyAlertRoute(state, alertId, route, 'human');
      expect(result.outcome.kind).toBe('match');
      expect(result.outcome.message).toContain('synthetic routing rubric');
      expect(result.outcome.message).toContain('No device');
      state = result.state;
    }
    expect(state.stats.routed).toBe(3);
    expect(state.stats.matches).toBe(3);
    expect(state.stats.bestStreak).toBe(3);
    expect(alertSnapshot(state).routeCounts).toEqual({ remote_review: 1, field_review: 1, request_details: 1 });
  });

  it('shows a wrong AI route instead of replacing it with the answer key', () => {
    const initial = createAlertGame(42, 'steady');
    const result = applyAlertRoute(initial, 'AL-001', 'field_review', 'ai');
    expect(result.outcome.kind).toBe('mismatch');
    expect(result.outcome.expectedRoute).toBe('remote_review');
    expect(result.state.alerts[0].observed.route).toBe('field_review');
    expect(result.state.alerts[0].observed.source).toBe('ai');
    expect(result.state.stats.score).toBe(-4);
    expect(initial.alerts[0].observed.status).toBe('queued');
  });

  it('records a late response without applying a handoff or double-counting the miss', () => {
    const state = advanceAlertGame(setAlertClock(createAlertGame(42, 'steady'), true, 1000), 16_500);
    const result = applyAlertRoute(state, 'AL-001', 'remote_review', 'ai');
    expect(result.outcome.kind).toBe('late');
    expect(result.outcome.points).toBe(0);
    expect(result.state.alerts[0].observed.route).toBeNull();
    expect(result.state.stats.missed).toBe(1);
    expect(result.state.stats).toEqual(state.stats);
    expect(result.state.turn).toBe(1);
  });

  it('does not permit a duplicate route or a request for an already-routed alert', () => {
    const result = applyAlertRoute(createAlertGame(42, 'steady'), 'AL-001', 'remote_review', 'human');
    expect(() => applyAlertRoute(result.state, 'AL-001', 'remote_review', 'ai')).toThrow('duplicate');
    expect(() => buildAlertRequest(result.state, 'AL-001')).toThrow('no longer');
  });
});
