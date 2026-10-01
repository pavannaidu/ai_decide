import { getExecutionContext } from '@databricks/appkit';
import { HttpError } from './errors';

export const AI_DEADLINE_MS = 10_000;

export async function callAiDecide(payload: unknown): Promise<{ raw: unknown; apiMs: number }> {
  const started = performance.now();
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new HttpError(504, 'Live AI inference exceeded 10 seconds. The run is paused; retry this turn.'));
    }, AI_DEADLINE_MS);
  });
  const inference = async () => {
    const client = getExecutionContext().client;
    await client.config.ensureResolved();
    const headers = new Headers({ 'Content-Type': 'application/json' });
    await client.config.authenticate(headers);
    if (!client.config.host) throw new HttpError(503, 'Databricks workspace authentication is not configured.');
    const response = await fetch(new URL('/api/2.0/ai-functions/ai-decide', client.config.host), {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!response.ok) {
      const status = response.status;
      throw new HttpError(
        status === 429 ? 429 : 502,
        status === 403
          ? 'The app service principal cannot access ai_decide. No simulated action was applied.'
          : `Live ai_decide returned HTTP ${status}. No simulated action was applied; retry this turn.`
      );
    }
    const raw: unknown = await response.json();
    return { raw, apiMs: Math.round(performance.now() - started) };
  };
  try {
    return await Promise.race([inference(), deadline]);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(
      502,
      'Live AI inference could not complete. No mock response was substituted; retry this turn.'
    );
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
