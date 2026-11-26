import { ApiFailure, normalizeApiResult } from './http';
import type { ApiResult, Transport } from './types';

export interface FetchTransportOptions {
  /** Empty string means same-origin (browser). */
  baseUrl?: string;
  headers: Record<string, string>;
  credentials?: RequestCredentials;
  timeoutMs?: number;
}

export function createFetchTransport(options: FetchTransportOptions): Transport {
  const base = options.baseUrl ?? '';
  const credentials = options.credentials ?? 'include';
  const timeoutMs = options.timeoutMs ?? 30_000;

  async function request(path: string, init: RequestInit): Promise<ApiResult<unknown>> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error(`请求超时（${timeoutMs}ms）：${path}`)), timeoutMs);
    try {
      const response = await fetch(`${base}${path}`, {
        credentials,
        ...init,
        signal: controller.signal,
      });

      let payload: unknown;
      try {
        payload = await response.json();
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') throw error;
        throw new ApiFailure(
          normalizeApiResult(response.status, undefined),
          `接口响应不是合法 JSON（http=${response.status}, path=${path}）`,
        );
      }

      return normalizeApiResult(response.status, payload);
    } finally {
      clearTimeout(timeout);
    }
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
