import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ authenticate: vi.fn(), ensureResolved: vi.fn() }));
vi.mock('@databricks/appkit', () => ({
  getExecutionContext: () => ({ client: { config: { host: 'https://example.invalid', ...mocks } } }),
}));
import { AI_DEADLINE_MS, callAiDecide } from './ai-decide';

describe('live AI transport', () => {
  beforeEach(() => {
    mocks.ensureResolved.mockResolvedValue(undefined);
    mocks.authenticate.mockImplementation((headers: Headers) => {
      headers.set('Authorization', 'Bearer test-only');
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });
  it('uses the service context and returns the unmodified raw response', async () => {
    const raw = { response: { answers: {} }, metadata: { version: '1.0' }, additional: 'preserved' };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(raw), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await callAiDecide({ options: { version: '1.0' } });
    expect(result.raw).toEqual(raw);
    expect(mocks.authenticate).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('https://example.invalid/api/2.0/ai-functions/ai-decide');
    expect(result.apiMs).toBeGreaterThanOrEqual(0);
  });
  it('does not silently substitute a mock on service-principal permission errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 403 })));
    const request = callAiDecide({});
    await expect(request).rejects.toThrow('service principal');
    await expect(request).rejects.toMatchObject({ status: 502 });
  });
  it('applies the ten-second deadline even when authentication hangs', async () => {
    vi.useFakeTimers();
    mocks.ensureResolved.mockImplementation(() => new Promise(() => {}));
    const request = callAiDecide({});
    const failed = expect(request).rejects.toThrow('10 seconds');
    await vi.advanceTimersByTimeAsync(AI_DEADLINE_MS);
    await failed;
    await expect(request).rejects.toMatchObject({ status: 504 });
  });
});
