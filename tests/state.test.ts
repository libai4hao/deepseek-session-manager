import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readStorageState } from '../src/cli/state';

const TEMP_DIRS: string[] = [];

afterEach(() => {
  while (TEMP_DIRS.length > 0) {
    const dir = TEMP_DIRS.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function writeState(payload: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsx-state-'));
  TEMP_DIRS.push(dir);
  const file = join(dir, 'auth.json');
  writeFileSync(file, JSON.stringify(payload), 'utf8');
  return file;
}

describe('readStorageState', () => {
  it('reads the bearer token from localStorage.userToken', () => {
    const file = writeState({
      cookies: [
        { name: 'ds_session', value: 'abc', domain: '.deepseek.com' },
        { name: 'other', value: 'zzz', domain: '.example.com' },
      ],
      origins: [
        {
          origin: 'https://chat.deepseek.com',
          localStorage: [{ name: 'userToken', value: JSON.stringify({ value: 'tok_123' }) }],
        },
      ],
    });

    const state = readStorageState(file);

    expect(state.token).toBe('tok_123');
    expect(state.cookieHeader).toBe('ds_session=abc');
  });

  it('tolerates a raw string token', () => {
    const file = writeState({
      origins: [{ origin: 'https://chat.deepseek.com', localStorage: [{ name: 'userToken', value: '"raw-token"' }] }],
    });

    expect(readStorageState(file).token).toBe('raw-token');
  });

  it('returns no token when the state has none', () => {
    const file = writeState({ cookies: [], origins: [] });
    expect(readStorageState(file).token).toBeUndefined();
    expect(readStorageState(file).cookieHeader).toBeUndefined();
  });
});
