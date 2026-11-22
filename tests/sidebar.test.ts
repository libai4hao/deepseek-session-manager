import { describe, expect, it } from 'vitest';

import { sessionIdFromHref } from '../src/userscript/sidebar';

describe('sessionIdFromHref', () => {
  const id = '7d76209a-4092-47be-bfb0-cae33b520507';

  it('reads the id from an absolute chat url', () => {
    expect(sessionIdFromHref(`https://chat.deepseek.com/a/chat/s/${id}`)).toBe(id);
  });

  it('ignores query, hash and trailing slash', () => {
    expect(sessionIdFromHref(`/a/chat/s/${id}/?tab=1#top`)).toBe(id);
    expect(sessionIdFromHref(`https://chat.deepseek.com/a/chat/s/${id.toUpperCase()}`)).toBe(id);
  });

  it('returns null for share pages and ordinary pages', () => {
    expect(sessionIdFromHref('https://chat.deepseek.com/a/chat/share/abc123')).toBeNull();
    expect(sessionIdFromHref('https://chat.deepseek.com/')).toBeNull();
    expect(sessionIdFromHref('not a url')).toBeNull();
  });
});
