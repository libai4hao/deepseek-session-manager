import { describe, expect, it } from 'vitest';
import { execResultToAudit, redactSecrets, toAuditLine } from '../src/core/audit';

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
});
