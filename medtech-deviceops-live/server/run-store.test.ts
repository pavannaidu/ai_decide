import { describe, expect, it, vi } from 'vitest';
import { buildDecisionRequest } from './decisions';
import { SOP } from './policy';
import { detailStep, loadRunView } from './run-store';
import { buildCandidates, createScenarioState, createState, injectEvent, prepareTurn, snapshot } from './simulator';

describe('immutable saved decision evidence', () => {
  it('preserves original choices and descriptions after eligibility rules change', () => {
    const before = snapshot(injectEvent(createState(42), 'ambiguous_report').state);
    const request = buildDecisionRequest(before, SOP);
    request.questions.next_action.criteria = {
      'review:RG-214': 'The exact historic review description.',
      wait: 'The exact historic wait description.',
    };
    expect(buildCandidates(before).some((candidate) => candidate.kind === 'review')).toBe(false);
    const raw = {
      response: {
        answers: {
          next_action: {
            type: 'choice',
            choice: 'review:RG-214',
            probabilities: { 'review:RG-214': 1, wait: 0 },
            confidence: 1,
          },
          quality_review_needed: { type: 'noul', probability: 1 },
          attention_priority: {
            type: 'score',
            score: 2,
            probabilities: { '0': 0, '1': 0, '2': 1 },
            legend: { '0': 'Routine', '1': 'Attention', '2': 'Priority' },
            confidence: 1,
          },
        },
      },
      metadata: { version: '1.0' },
    };
    const saved = detailStep({
      turn: 1,
      selected_action: 'review:RG-214',
      request,
      raw_response: raw,
      before_snapshot: before,
      after_snapshot: before,
      outcome: JSON.stringify({ kind: 'applied', message: 'Historic synthetic hold.', affectedIds: [] }),
      api_ms: 850,
      tick_ms: 900,
      created_at: new Date('2026-10-01T01:00:00Z'),
    });
    expect(saved.candidates.map((candidate) => candidate.id)).toEqual(['review:RG-214', 'wait']);
    expect(saved.candidates.map((candidate) => candidate.description)).toEqual(
      Object.values(request.questions.next_action.criteria)
    );
    expect(saved.actionLabel).toBe('Review lot RG-214');
    expect(saved.rawResponse).toEqual(raw);
  });
});

describe('the actual next request', () => {
  it('previews the same prepared state and request that the next tick uses, without changing the saved run', async () => {
    const state = createScenarioState(42, 'lot_qc');
    const original = structuredClone(state);
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'test-run',
            seed: 42,
            tick: 0,
            revision: 0,
            sop_version: SOP.version,
            state,
            created_at: new Date('2026-10-01T01:00:00Z'),
            updated_at: new Date('2026-10-01T01:00:00Z'),
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ content: SOP }] });
    const run = await loadRunView({ query }, 'test-owner', 'test-run');
    const nextSnapshot = snapshot(prepareTurn(state));
    expect(run.nextDecision?.beforeSnapshot).toEqual(nextSnapshot);
    expect(run.nextDecision?.request).toEqual(buildDecisionRequest(nextSnapshot, SOP));
    expect(run.scenario).toBe('lot_qc');
    expect(run.tick).toBe(0);
    expect(run.latestStep).toBeNull();
    expect(state).toEqual(original);
  });
  it('does not prepare another request when the run is complete', async () => {
    const state = createState(42);
    state.tick = 60;
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'complete-run',
            seed: 42,
            tick: 60,
            revision: 60,
            sop_version: SOP.version,
            state,
            created_at: new Date('2026-10-01T01:00:00Z'),
            updated_at: new Date('2026-10-01T01:00:00Z'),
          },
        ],
      })
      .mockResolvedValue({ rows: [] });
    const run = await loadRunView({ query }, 'test-owner', 'complete-run');
    expect(run.nextDecision).toBeNull();
    expect(query).toHaveBeenCalledTimes(3);
  });
});
