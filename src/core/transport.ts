import { normalizeApiResult } from './http';
import type { ApiResult, Transport } from './types';

export interface FetchTransportOptions {
  /** Empty string means same-origin (browser). */
  baseUrl?: string;
  headers: Record<string, string>;
  credentials?: RequestCredentials;
}

export function createFetchTransport(options: FetchTransportOptions): Transport {
  const base = options.baseUrl ?? '';
  const credentials = options.credentials ?? 'include';

  async function request(path: string, init: RequestInit): Promise<ApiResult<unknown>> {
    const response = await fetch(`${base}${path}`, { credentials, ...init });

    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    return normalizeApiResult(response.status, payload);
  }

  return {
    get<T>(path: string): Promise<ApiResult<T>> {
      return request(path, {
        method: 'GET',
        headers: options.headers,
      }) as unknown as Promise<ApiResult<T>>;
    },
    post<T>(path: string, body: unknown): Promise<ApiResult<T>> {
      return request(path, {
        method: 'POST',
        headers: options.headers,
        body: JSON.stringify(body ?? {}),
      }) as unknown as Promise<ApiResult<T>>;
    },
  };
}
