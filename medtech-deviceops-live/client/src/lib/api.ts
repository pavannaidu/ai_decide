export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function api<Result>(url: string, options: RequestInit = {}): Promise<Result> {
  const response = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
    signal: options.signal ?? AbortSignal.timeout(25_000),
  });
  const data: unknown = await response.json();
  if (!response.ok) {
    const message =
      data && typeof data === 'object' && 'error' in data && typeof data.error === 'string'
        ? data.error
        : `Request failed with HTTP ${response.status}.`;
    throw new ApiError(response.status, message);
  }
  return data as Result;
}

export function post<Result>(url: string, body: unknown) {
  return api<Result>(url, { method: 'POST', body: JSON.stringify(body) });
}
