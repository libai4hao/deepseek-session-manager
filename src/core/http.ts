import type { ApiErrorKind, ApiResult } from './types';

export class ApiFailure extends Error {
  readonly result: ApiResult<unknown>;

  constructor(result: ApiResult<unknown>, message: string) {
    super(message);
    this.name = 'ApiFailure';
    this.result = result;
  }
}

/**
 * DeepSeek web wraps business payloads in { code, msg, data: { biz_code, biz_msg, biz_data } }.
 * HTTP 200 with code 40003 means the bearer token is invalid.
 */
export function normalizeApiResult<T = unknown>(http: number, payload: unknown): ApiResult<T> {
  const top = (payload ?? {}) as Record<string, unknown>;
  const wrapper = (top['data'] ?? {}) as Record<string, unknown>;

  return {
    http,
    code: typeof top['code'] === 'number' ? (top['code'] as number) : http === 200 ? 0 : http,
    bizCode: typeof wrapper['biz_code'] === 'number' ? (wrapper['biz_code'] as number) : undefined,
    bizMsg: typeof wrapper['biz_msg'] === 'string' ? (wrapper['biz_msg'] as string) : undefined,
    data: (wrapper['biz_data'] ?? undefined) as T | undefined,
    detail: top['detail'],
    raw: payload,
  };
}

export function classifyResult(result: ApiResult<unknown>): ApiErrorKind {
  if (result.code === 40003 || result.http === 401) return 'auth';
  if (result.http === 403) return 'forbidden';
  if (result.http === 422) return 'schema';
  if (result.http === 429) return 'rate';
  if (result.http >= 500) return 'server';
  if (result.http !== 200) return 'business';
  if (result.code !== 0) return 'business';
  return 'ok';
}

export function authHeaders(token: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
    'x-client-platform': 'web',
    ...extra,
  };
}

/** Pull the 422 schema hint out of `{ detail: [{ loc: "body.xxx" }] }`. */
export function schemaHint(result: ApiResult<unknown>): string | undefined {
  const detail = result.detail as Array<{ loc?: unknown }> | undefined;
  if (!Array.isArray(detail) || detail.length === 0) return undefined;
  const loc = detail[0]?.loc;
  if (typeof loc === 'string') return loc;
  if (Array.isArray(loc)) return loc.join('.');
  return undefined;
}
