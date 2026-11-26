import type { ExecResult, ExecStatus } from './types';

export type AuditStatus = 'planned' | ExecStatus;

export interface AuditEvent {
  ts: string;
  event: 'plan' | 'delete' | 'verify' | 'abort';
  sessionId?: string;
  title?: string;
  updatedAt?: number;
  sourceLink?: string;
  accountHash?: string;
  shape?: string;
  attempts?: number;
  status?: AuditStatus;
  ms?: number;
  snapshot?: string;
  note?: string;
}

export function toAuditLine(event: AuditEvent): string {
  return JSON.stringify({
    ...event,
    sourceLink: event.sourceLink ? redactSecrets(event.sourceLink) : undefined,
    note: event.note ? redactSecrets(event.note) : undefined,
  });
}

/** Defence in depth: nothing that looks like a credential leaves this process. */
export function redactSecrets(text: string): string {
  return text
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer ***')
    .replace(/(["']?cookie["']?\s*[=:]\s*)(?!Bearer\s)(?:"[^"]*"|'[^']*'|[^&\r\n}]+)/gi, '$1***')
    .replace(/(["']?(?:token|authorization)["']?\s*[=:]\s*)(?!Bearer\s)(?:"[^"]*"|'[^']*'|[^&\s;,}]+)/gi, '$1***')
    .replace(/(https?:\/\/)[^/\s:@]+:[^/\s@]+@/gi, '$1***@');
}

export async function hashId(value: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('当前环境缺少 WebCrypto，无法安全生成账号指纹');

  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(value));
  const hex = Array.from(new Uint8Array(digest))
    .slice(0, 8)
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');

  return `sha256:${hex}`;
}

export function execResultToAudit(result: ExecResult, base: Partial<AuditEvent> = {}): AuditEvent {
  const note = result.reason ?? base.note;

  return {
    ...base,
    ts: new Date().toISOString(),
    event: 'delete',
    sessionId: base.sessionId ?? result.id,
    status: result.status,
    attempts: result.attempts,
    ms: result.ms,
    note: note ? redactSecrets(note) : undefined,
  };
}
