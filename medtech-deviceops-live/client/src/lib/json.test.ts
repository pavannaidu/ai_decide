import { describe, expect, it } from 'vitest';
import { formatJson } from './json';

describe('readable API JSON', () => {
  it('leads with the question without removing or changing any request fields', () => {
    const request = {
      state: { observations: ['synthetic'] },
      options: { version: '1.0' },
      questions: { next_action: { type: 'choice' } },
    };
    const formatted = formatJson(request);
    const parsed = JSON.parse(formatted) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(['questions', 'state', 'options']);
    expect(parsed).toEqual(request);
  });
  it('leads with the real response and preserves metadata and unrecognized fields', () => {
    const response = {
      metadata: { version: '1.0' },
      additional: 'preserved',
      response: { answers: { next_action: { choice: 'wait' } } },
    };
    const formatted = formatJson(response);
    const parsed = JSON.parse(formatted) as Record<string, unknown>;
    expect(Object.keys(parsed)[0]).toBe('response');
    expect(parsed).toEqual(response);
  });
});
