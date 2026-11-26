import { afterEach, describe, expect, it, vi } from 'vitest';
import { execResultToAudit, hashId, redactSecrets, toAuditLine } from '../src/core/audit';
import { ensureWebCrypto } from '../src/cli/runtime';

afterEach(() => vi.unstubAllGlobals());

describe('redactSecrets', () => {
  it('masks bearer tokens', () => {
    expect(redactSecrets('401 Authorization: Bearer abc.Def-123_x')).toContain('Bearer ***');
    expect(redactSecrets('401 Authorization: Bearer abc.Def-123_x')).not.toContain('abc.Def');
  });

  it('masks token / cookie query pairs', () => {
    const text = 'failed ?token=sk-live-123&cookie=session%3Dabc';
    const out = redactSecrets(text);
    expect(out).not.toContain('sk-live-123');
    expect(out).not.toContain('session%3Dabc');
    expect(out).toContain('token=***');
    expect(redactSecrets('cookie=a=secret1; b=secret2')).not.toContain('secret1');
    expect(redactSecrets('cookie=a=secret1; b=secret2')).not.toContain('secret2');
  });

  it('masks header and JSON credential forms', () => {
    expect(redactSecrets('Cookie: session=abc')).not.toContain('session=abc');
    expect(redactSecrets('Cookie: a=secret1; b=secret2')).not.toContain('secret1');
    expect(redactSecrets('Cookie: a=secret1; b=secret2')).not.toContain('secret2');
    expect(redactSecrets('Authorization: Bearer abc.def')).not.toContain('abc.def');
    expect(redactSecrets('{"token":"sk-live-123"}')).not.toContain('sk-live-123');
    expect(redactSecrets('https://user:pass@example.com/path')).not.toContain('user:pass');
  });

  it('leaves ordinary error text untouched', () => {
    expect(redactSecrets('HTTP 500 upstream timeout')).toBe('HTTP 500 upstream timeout');
  });
});

describe('execResultToAudit', () => {
  it('redacts the reason before it reaches the audit line', () => {
    const event = execResultToAudit({
      id: '7d76209a-4092-47be-bfb0-cae33b520507',
      status: 'failed',
      attempts: 2,
      ms: 71,
      reason: 'request rejected, header was Bearer abc.def.ghi',
    });

    expect(event.event).toBe('delete');
    expect(event.status).toBe('failed');
    expect(event.attempts).toBe(2);
    expect(event.note).not.toContain('abc.def.ghi');
    expect(toAuditLine(event)).not.toContain('abc.def.ghi');
  });

  it('keeps an explicit base note when there is no reason', () => {
    const event = execResultToAudit(
      { id: 'x', status: 'deleted', attempts: 1, ms: 12 },
      { sessionId: 'x', note: 'verify: gone' },
    );
    expect(event.note).toBe('verify: gone');
  });

  it('redacts manually constructed audit events at the serialization boundary', () => {
    const line = toAuditLine({
      ts: 'now',
      event: 'plan',
      sourceLink: 'https://chat.deepseek.com/a/chat/s/a?token=secret',
      note: 'Cookie: session=secret',
    });
    expect(line).not.toContain('secret');
  });
});

describe('hashId', () => {
  it('uses the CLI runtime WebCrypto shim on Node versions without a global', async () => {
    vi.stubGlobal('crypto', undefined);
    ensureWebCrypto();
    await expect(hashId('account-1')).resolves.toMatch(/^sha256:[0-9a-f]{16}$/);
  });

  it('fails closed when WebCrypto is unavailable', async () => {
    vi.stubGlobal('crypto', undefined);
    await expect(hashId('account-1')).rejects.toThrow(/WebCrypto/);
  });
});
