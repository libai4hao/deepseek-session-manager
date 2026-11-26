import { describe, expect, it } from 'vitest';
import { dedupeLinks, parseLink, parseLinks, sanitizeLinkForReport, stripNoise } from '../src/core/parser';

const ID = '43d6c267-1f2e-4a3b-9c5d-1234567890ab';

describe('parseLink', () => {
  it('parses a normal session link', () => {
    const result = parseLink(`https://chat.deepseek.com/a/chat/s/${ID}`);
    expect(result.kind).toBe('session');
    expect(result.id).toBe(ID);
  });

  it('ignores query string and hash', () => {
    const result = parseLink(`https://chat.deepseek.com/a/chat/s/${ID}?from=share#msg-3`);
    expect(result.kind).toBe('session');
    expect(result.id).toBe(ID);
  });

  it('accepts a trailing slash', () => {
    expect(parseLink(`https://chat.deepseek.com/a/chat/s/${ID}/`).kind).toBe('session');
  });

  it('rejects share links as read-only', () => {
    const result = parseLink('https://chat.deepseek.com/share/abc123');
    expect(result.kind).toBe('share');
    expect(result.reason).toContain('只读');
  });

  it('rejects look-alike hosts', () => {
    expect(parseLink(`https://chat.deepseek.com.evil.com/a/chat/s/${ID}`).kind).toBe('foreign');
  });

  it('rejects the bare root', () => {
    expect(parseLink('https://chat.deepseek.com/').kind).toBe('bad');
  });

  it('accepts a bare uuid', () => {
    const result = parseLink(ID.toUpperCase());
    expect(result.kind).toBe('session');
    expect(result.id).toBe(ID);
  });

  it('strips copy/paste noise', () => {
    expect(stripNoise(`  https://chat.deepseek.com/a/chat/s/${ID}，`)).toBe(
      `https://chat.deepseek.com/a/chat/s/${ID}`,
    );
    expect(parseLink(`  https://chat.deepseek.com/a/chat/s/${ID}）`).kind).toBe('session');
  });

  it('rejects empty input', () => {
    expect(parseLink('   ').kind).toBe('bad');
  });
});

describe('parseLinks', () => {
  it('skips blank lines and keeps order', () => {
    const links = parseLinks([`https://chat.deepseek.com/a/chat/s/${ID}`, '', '   ']);
    expect(links).toHaveLength(1);
    expect(links[0].id).toBe(ID);
  });
});

describe('dedupeLinks', () => {
  it('dedupes by session id', () => {
    const links = parseLinks([
      `https://chat.deepseek.com/a/chat/s/${ID}`,
      `https://chat.deepseek.com/a/chat/s/${ID}?x=1`,
      'https://chat.deepseek.com/share/abc',
    ]);
    const deduped = dedupeLinks(links);
    expect(deduped).toHaveLength(2);
  });
});

describe('sanitizeLinkForReport', () => {
  it('keeps only the canonical session URL', () => {
    const link = parseLink(`https://chat.deepseek.com/a/chat/s/${ID}?token=secret#fragment`);
    expect(sanitizeLinkForReport(link)).toBe(`https://chat.deepseek.com/a/chat/s/${ID}`);
  });

  it('removes URL credentials, query and hash from rejected links', () => {
    const link = parseLink('https://user:pass@example.com/path?token=secret#fragment');
    expect(sanitizeLinkForReport(link)).toBe('https://example.com/path');
  });
});
