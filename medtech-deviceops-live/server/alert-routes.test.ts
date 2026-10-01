import { randomUUID } from 'node:crypto';
import type { LakebasePool } from '@databricks/appkit';
import type { Application, Request, Response } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AlertGameStep } from '../shared/alerts';
import { createAlertGame, setAlertClock } from './alert-game';
import { ALERT_POLICY } from './alert-policy';
import type { AlertGameRow } from './alert-store';
import { HttpError } from './errors';

const transport = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('./ai-decide', () => ({ callAiDecide: transport.call }));
import { registerAlertRoutes } from './alert-routes';

function modelResponse() {
  return {
    raw: {
      response: {
        answers: {
          next_action: {
            type: 'choice',
            choice: 'remote_review',
            confidence: 0.8,
            probabilities: { remote_review: 0.8, field_review: 0.1, request_details: 0.1 },
          },
        },
      },
      metadata: { version: '1.0' },
      extra: 'unmodified evidence',
    },
    apiMs: 42,
  };
}

function routeHarness(running = true) {
  const id = randomUUID();
  const saved = new Map<string, AlertGameStep>();
  const row: AlertGameRow = {
    id,
    owner_key: 'owner-a',
    seed: 42,
    mode: 'steady',
    revision: 0,
    policy_version: ALERT_POLICY.version,
    state: setAlertClock(createAlertGame(42, 'steady'), running, Date.now()),
    created_at: new Date(),
    updated_at: new Date(),
  };
  const query = vi.fn(async (sql: string, values: unknown[] = []) => {
    await Promise.resolve();
    if (sql.startsWith('SELECT * FROM deviceops_sim.alert_game_runs')) {
      return { rows: values[0] === id && values[1] === row.owner_key ? [structuredClone(row)] : [] };
    }
    if (sql.includes('FROM deviceops_sim.sop_versions')) return { rows: [{ content: ALERT_POLICY }] };
    if (sql.startsWith('SELECT detail') && sql.includes('request_id')) {
      const detail = saved.get(String(values[1]));
      return { rows: detail ? [{ detail }] : [] };
    }
    if (sql.startsWith('SELECT detail')) {
      const details = [...saved.values()].filter((entry) => entry.turn <= Number(values[1])).reverse();
      return { rows: details.slice(0, 1).map((detail) => ({ detail })) };
    }
    if (sql.includes("detail->>'apiMs'")) {
      return {
        rows: [...saved.values()]
          .filter((entry) => entry.source === 'ai' && entry.turn <= Number(values[1]))
          .map((entry) => ({ api_ms: entry.apiMs })),
      };
    }
    if (sql.startsWith('UPDATE deviceops_sim.alert_game_runs')) {
      row.state = JSON.parse(String(values[0])) as AlertGameRow['state'];
      row.revision += 1;
    }
    if (sql.startsWith('INSERT INTO deviceops_sim.alert_game_steps')) {
      saved.set(String(values[2]), JSON.parse(String(values[3])) as AlertGameStep);
    }
    return { rows: [] };
  });
  const release = vi.fn();
  const pool = { query, connect: vi.fn().mockResolvedValue({ query, release }) };
  const posts = new Map<string, (request: Request, response: Response) => void>();
  const app = {
    get: vi.fn(),
    post: (path: string, handler: (request: Request, response: Response) => void) => posts.set(path, handler),
  };
  registerAlertRoutes(app as unknown as Application, pool as unknown as LakebasePool);
  const invoke = (body: unknown, owner = 'owner-a') =>
    new Promise<{ status: number; data: unknown }>((resolve) => {
      let status = 200;
      const response = {
        status: (next: number) => {
          status = next;
          return response;
        },
        json: (data: unknown) => resolve({ status, data }),
      };
      posts.get('/api/alert-games/:id/triage')!(
        { params: { id }, body, header: () => owner } as unknown as Request,
        response as unknown as Response
      );
    });
  return { row, saved, query, release, invoke };
}

describe('transactional alert triage', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-01T12:00:00Z'));
    transport.call.mockResolvedValue(modelResponse());
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('stores the exact model evidence and applies a request ID only once', async () => {
    const harness = routeHarness();
    const input = { alertId: 'AL-001', requestId: randomUUID() };
    expect((await harness.invoke(input)).status).toBe(200);
    expect((await harness.invoke(input)).status).toBe(200);
    expect(transport.call).toHaveBeenCalledTimes(1);
    expect(harness.saved.size).toBe(1);
    const step = harness.saved.get(input.requestId)!;
    expect(step.requestId).toBe(input.requestId);
    expect(step.rawResponse).toEqual(modelResponse().raw);
    expect(step.request).toEqual(transport.call.mock.calls[0][0]);
    expect(step.apiMs).toBe(42);
    expect(step.source).toBe('ai');
    expect(harness.row.state.stats.routed).toBe(1);
    expect(harness.release).toHaveBeenCalledOnce();
  });

  it('preserves new arrivals that happen while the real transport is awaited', async () => {
    const harness = routeHarness();
    transport.call.mockImplementationOnce(() => {
      vi.setSystemTime(Date.now() + 9000);
      return Promise.resolve(modelResponse());
    });
    expect((await harness.invoke({ alertId: 'AL-001', requestId: randomUUID() })).status).toBe(200);
    expect(harness.row.state.elapsedMs).toBe(9000);
    expect(harness.row.state.alerts).toHaveLength(3);
    expect(harness.row.state.alerts[0].observed.status).toBe('routed');
    expect(harness.row.state.alerts[1].observed.status).toBe('queued');
  });

  it('does not invent an AI response for a human handoff', async () => {
    const harness = routeHarness();
    const input = { alertId: 'AL-001', requestId: randomUUID(), route: 'remote_review' };
    expect((await harness.invoke(input)).status).toBe(200);
    expect(transport.call).not.toHaveBeenCalled();
    expect(harness.saved.get(input.requestId)).toMatchObject({
      source: 'human',
      rawResponse: null,
      answers: null,
      apiMs: null,
    });
  });

  it('pauses on transport failure and does not route or save a fabricated response', async () => {
    const harness = routeHarness();
    transport.call.mockRejectedValueOnce(new HttpError(502, 'Live inference failed; no mock response.'));
    const result = await harness.invoke({ alertId: 'AL-001', requestId: randomUUID() });
    expect(result.status).toBe(502);
    expect(harness.row.state.anchorMs).toBeNull();
    expect(harness.row.state.alerts[0].observed.status).toBe('queued');
    expect(harness.saved.size).toBe(0);
  });

  it('requires the signed-in owner and a running shift before spending an AI call', async () => {
    const harness = routeHarness(false);
    const input = { alertId: 'AL-001', requestId: randomUUID() };
    expect((await harness.invoke(input, 'owner-b')).status).toBe(404);
    expect((await harness.invoke(input)).status).toBe(409);
    expect(transport.call).not.toHaveBeenCalled();
  });

  it('rejects unsafe routes and mismatched retries without silently changing the action', async () => {
    const harness = routeHarness();
    const requestId = randomUUID();
    expect((await harness.invoke({ alertId: 'AL-001', requestId, route: 'repair_device' })).status).toBe(400);
    expect(transport.call).not.toHaveBeenCalled();
    expect((await harness.invoke({ alertId: 'AL-001', requestId })).status).toBe(200);
    expect((await harness.invoke({ alertId: 'AL-001', requestId, route: 'remote_review' })).status).toBe(409);
    expect(transport.call).toHaveBeenCalledTimes(1);
  });
});
