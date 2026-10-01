import { describe, expect, it, vi } from 'vitest';
import { createAlertGame, setAlertClock } from './alert-game';
import { ALERT_POLICY } from './alert-policy';
import { loadAlertGameView, loadAlertStep, summarizeAlertGame } from './alert-store';

function savedRow() {
  return {
    id: 'game-id',
    owner_key: 'owner-a',
    seed: 42,
    mode: 'steady' as const,
    revision: 1,
    policy_version: ALERT_POLICY.version,
    state: setAlertClock(createAlertGame(42, 'steady'), true, 1000),
    created_at: new Date('2026-10-01T01:00:00Z'),
    updated_at: new Date('2026-10-01T01:00:00Z'),
  };
}

describe('immutable Lakebase alert evidence', () => {
  it('projects the independent clock without modifying a saved row or writing from GET', async () => {
    const row = savedRow();
    const original = structuredClone(row);
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [row] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ api_ms: 25 }, { api_ms: 75 }] })
      .mockResolvedValueOnce({ rows: [{ content: ALERT_POLICY }] });
    const view = await loadAlertGameView({ query }, 'owner-a', 'game-id', 10_000);
    expect(view.snapshot.elapsedMs).toBe(9000);
    expect(view.snapshot.alerts).toHaveLength(3);
    expect(view.timings).toEqual({ aiDecisions: 2, apiP50: 25, apiP95: 75 });
    expect(view.nextDecision?.request.state.alert.id).toBe('AL-001');
    expect(view.observedAt).toBe(new Date(10_000).toISOString());
    expect(row).toEqual(original);
    expect(query.mock.calls.map((call) => String(call[0])).every((sql) => sql.startsWith('SELECT'))).toBe(true);
    expect(query.mock.calls[0][1]).toEqual(['game-id', 'owner-a']);
  });

  it('never reads evidence for a run outside the signed-in owner', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    await expect(loadAlertStep({ query }, 'other-owner', 'game-id', 1)).rejects.toMatchObject({ status: 404 });
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][1]).toEqual(['game-id', 'other-owner']);
  });

  it('returns exactly the saved request and raw response, without a new model call', async () => {
    const detail = { turn: 1, request: { historic: 'request' }, rawResponse: { preserved: 'response' } };
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [savedRow()] })
      .mockResolvedValueOnce({ rows: [{ detail }] });
    expect(await loadAlertStep({ query }, 'owner-a', 'game-id', 1)).toEqual(detail);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('retains the game mode, seed, and revision in saved-shift summaries', () => {
    expect(summarizeAlertGame(savedRow())).toEqual({
      id: 'game-id',
      seed: 42,
      mode: 'steady',
      revision: 1,
      createdAt: '2026-10-01T01:00:00.000Z',
    });
  });
});
