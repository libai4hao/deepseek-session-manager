import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { checkResumeAccount, completedIds, markSnapshots, mergeResults, readProgress, reconcileDeletedResults, reusableSnapshots, writeProgress } from '../src/cli/progress';
import type { Snapshot } from '../src/core/snapshot';

const TEMP_DIRS: string[] = [];

afterEach(() => {
  while (TEMP_DIRS.length > 0) {
    const dir = TEMP_DIRS.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsx-progress-'));
  TEMP_DIRS.push(dir);
  return dir;
}

const snapshot: Snapshot = {
  schema: 'dsx.snapshot.v1',
  id: 'a',
  title: 'title',
  pinned: false,
  updatedAt: 1,
  capturedAt: '2026-01-01T00:00:00.000Z',
  messageCount: 0,
  messages: [],
};

describe('resume bookkeeping', () => {
  it('treats only confirmed deletions as finished', () => {
    const done = completedIds({
      schema: 'dsx.progress.v1',
      updatedAt: '',
      entries: {
        a: { status: 'deleted', at: '' },
        b: { status: 'skipped', at: '' },
        c: { status: 'failed', at: '' },
        d: { status: 'snapshotted', at: '' },
        e: { status: 'aborted', at: '' },
      },
    });

    expect([...done]).toEqual(['a']);
  });

  it('reuses only complete snapshots that stay inside the directory and match the session', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'a.json'), JSON.stringify(snapshot), 'utf8');
    writeFileSync(join(dir, 'incomplete.json'), JSON.stringify({ schema: 'dsx.snapshot.v1', id: 'b' }), 'utf8');
    writeFileSync(join(dir, 'someone-else.json'), JSON.stringify({ ...snapshot, id: 'other' }), 'utf8');
    writeFileSync(join(dir, 'broken.json'), '{oops', 'utf8');
    writeFileSync(join(dir, 'd.enc.json'), JSON.stringify({
      schema: 'dsx.snapshot.enc.v1',
      kdf: { name: 'scrypt', salt: 'salt', N: 1, r: 1, p: 1 },
      cipher: { name: 'aes-256-gcm', iv: 'iv', tag: 'tag' },
      data: 'ciphertext',
    }), 'utf8');
    writeFileSync(join(dir, 'e.enc.json'), 'ciphertext', 'utf8');
    writeFileSync(join(dir, 'f.enc.json'), '', 'utf8');

    const progress = {
      schema: 'dsx.progress.v1' as const,
      updatedAt: '',
      entries: {
        a: { status: 'failed' as const, at: '', snapshot: 'a.json' },
        b: { status: 'failed' as const, at: '', snapshot: 'incomplete.json' },
        c: { status: 'failed' as const, at: '', snapshot: '../outside.json' },
        x: { status: 'failed' as const, at: '', snapshot: 'someone-else.json' },
        y: { status: 'failed' as const, at: '', snapshot: 'broken.json' },
        d: { status: 'failed' as const, at: '', snapshot: 'd.enc.json' },
        e: { status: 'failed' as const, at: '', snapshot: 'e.enc.json' },
        f: { status: 'failed' as const, at: '', snapshot: 'f.enc.json' },
      },
    };

    const reusable = reusableSnapshots(progress, dir);
    expect([...reusable.entries()]).toEqual([['a', 'a.json'], ['d', 'd.enc.json']]);
  });

  it('refuses to resume when the stored account differs from the current one', () => {
    const progress = markSnapshots(undefined, new Map([['session-1', 'one.json']]));

    expect(checkResumeAccount(progress, undefined)).toBe('no-current-hash');
    expect(checkResumeAccount(progress, 'hash-b')).toBe('no-stored-hash');

    const stored = { ...progress, accountHash: 'hash-a' };
    expect(checkResumeAccount(stored, 'hash-b')).toBe('mismatch');
    expect(checkResumeAccount(stored, 'hash-a')).toBe('ok');
    expect(checkResumeAccount(undefined, 'hash-a')).toBe('ok');
  });

  it('records snapshots without clobbering an existing verdict', () => {
    const base = {
      schema: 'dsx.progress.v1' as const,
      updatedAt: '',
      entries: { a: { status: 'failed' as const, at: 'x', attempts: 3 } },
    };

    const next = markSnapshots(base, new Map([['a', 'a.json']]));
    expect(next.entries.a.status).toBe('snapshotted');
    expect(next.entries.a.snapshot).toBe('a.json');
  });

  it('maps noop to deleted and ABORTED skips to aborted', () => {
    const next = mergeResults(undefined, [
      { id: 'a', status: 'noop', attempts: 1, ms: 10 },
      { id: 'b', status: 'aborted', attempts: 0, ms: 0 },
      { id: 'c', status: 'skipped', attempts: 0, ms: 0, reason: 'ABORTED' },
    ]);

    expect(next.entries.a.status).toBe('deleted');
    expect(next.entries.b.status).toBe('aborted');
    expect(next.entries.c.status).toBe('aborted');
  });

  it('does not mark deletions complete when verification fails or still finds them', () => {
    const results = [
      { id: 'a', status: 'deleted' as const, attempts: 1, ms: 1 },
      { id: 'b', status: 'deleted' as const, attempts: 1, ms: 1 },
      { id: 'c', status: 'deleted' as const, attempts: 1, ms: 1 },
    ];

    expect(reconcileDeletedResults(results, [
      { id: 'a', stillThere: false },
      { id: 'b', stillThere: true },
    ]).map(result => [result.id, result.status, result.reason])).toEqual([
      ['a', 'deleted', undefined],
      ['b', 'failed', 'VERIFY_STILL_THERE'],
      ['c', 'failed', 'VERIFY_FAILED'],
    ]);
    expect(reconcileDeletedResults(results, undefined).every(result => result.status === 'failed')).toBe(true);
  });

  it('writes progress through a completed replacement and leaves no temp file', () => {
    const path = join(tempDir(), 'progress.json');
    const progress = markSnapshots(undefined, new Map([['session-1', 'one.json']]));
    writeProgress(path, progress);
    expect(JSON.parse(readFileSync(path, 'utf8')).entries['session-1'].snapshot).toBe('one.json');
    expect(existsSync(`${path}.tmp-${process.pid}`)).toBe(false);
  });

  it('survives a corrupt progress file', () => {
    const path = join(tempDir(), 'progress.json');
    writeFileSync(path, '{not json', 'utf8');

    expect(readProgress(path)).toBeUndefined();
    expect(readProgress(join(tempDir(), 'missing.json'))).toBeUndefined();
  });
});
