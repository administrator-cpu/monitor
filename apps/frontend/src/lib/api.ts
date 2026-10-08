import { API_PREFIX, CSRF_HEADER, CSRF_VALUE, type ApiErrorBody } from '@cc/shared';
import { API_BASE } from './config';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly issues?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** The browser could not reach the API at all (as opposed to an error response). */
export class NetworkError extends Error {
  constructor() {
    super('Cannot reach the monitor API.');
    this.name = 'NetworkError';
  }
}

let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: (() => void) | null): void {
  onUnauthorized = fn;
}

interface Options {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  /** Calls such as /auth/me and /auth/login handle 401 themselves. */
  skipUnauthorizedHandler?: boolean;
  signal?: AbortSignal;
}

/**
 * All monitor data is fetched straight from the VPS: the session cookie travels
 * with `credentials: 'include'` and state-changing calls carry the CSRF header.
 */
export async function api<T = unknown>(path: string, opts: Options = {}): Promise<T> {
  const method = opts.method ?? 'GET';
  const headers: Record<string, string> = {};
  if (method !== 'GET') headers[CSRF_HEADER] = CSRF_VALUE;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${API_PREFIX}${path}`, {
      method,
      headers,
      credentials: 'include',
      cache: 'no-store',
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: opts.signal,
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    throw new NetworkError();
  }

  if (res.status === 204) return undefined as T;
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    // non-JSON body
  }
  if (!res.ok) {
    const b = (json ?? {}) as Partial<ApiErrorBody>;
    if (res.status === 401 && !opts.skipUnauthorizedHandler) onUnauthorized?.();
    throw new ApiError(
      res.status,
      b.error ?? 'error',
      b.message ?? `Request failed (${res.status})`,
      b.issues,
    );
  }
  return json as T;
}

export const fetcher = <T>(path: string) => api<T>(path);

/** First human-readable problem from an error, for forms. */
export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    const first = Array.isArray(e.issues)
      ? (e.issues[0] as { message?: string } | undefined)
      : undefined;
    return first?.message ? `${e.message} ${first.message}` : e.message;
  }
  if (e instanceof Error) return e.message;
  return 'Something went wrong.';
}
