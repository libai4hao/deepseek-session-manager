import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { checkResumeAccount, completedIds, markSnapshots, mergeResults, readProgress, reusableSnapshots, writeProgress } from '../src/cli/progress';

describe('resume bookkeeping', () => {
  it('treats deleted and skipped as finished, but not failed', () => {
    const done = completedIds({
      schema: 'dsx.progress.v1',
      updatedAt: '',
      entries: {
        a: { status: 'deleted', at: '' },
        b: { status: 'skipped', at: '' },
        c: { status: 'failed', at: '' },
        d: { status: 'snapshotted', at: '' },
      },
    });

    expect([...done].sort()).toEqual(['a', 'b']);
  });

  it('reuses only snapshots that exist, stay inside the directory and belong to the same session', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsx-progress-'));
    writeFileSync(join(dir, 'a.json'), JSON.stringify({ schema: 'dsx.snapshot.v1', id: 'a' }), 'utf8');
    writeFileSync(join(dir, 'someone-else.json'), JSON.stringify({ schema: 'dsx.snapshot.v1', id: 'other' }), 'utf8');
    writeFileSync(join(dir, 'broken.json'), '{oops', 'utf8');
    writeFileSync(join(dir, 'd.enc.json'), 'ciphertext', 'utf8');
    writeFileSync(join(dir, 'e.enc.json'), '', 'utf8');

    const progress = {
      schema: 'dsx.progress.v1' as const,
      updatedAt: '',
      entries: {
        a: { status: 'failed' as const, at: '', snapshot: 'a.json' },
        b: { status: 'failed' as const, at: '', snapshot: 'gone.json' },
        c: { status: 'failed' as const, at: '', snapshot: '../outside.json' },
        x: { status: 'failed' as const, at: '', snapshot: 'someone-else.json' },
        y: { status: 'failed' as const, at: '', snapshot: 'broken.json' },
        d: { status: 'failed' as const, at: '', snapshot: 'd.enc.json' },
        e: { status: 'failed' as const, at: '', snapshot: 'e.enc.json' },
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

  it('maps noop to deleted so a rerun does not touch it again', () => {
    const next = mergeResults(undefined, [
      { id: 'a', status: 'noop', attempts: 1, ms: 10 },
      { id: 'b', status: 'aborted', attempts: 0, ms: 0 },
    ]);

    expect(next.entries.a.status).toBe('deleted');
    expect(next.entries.b.status).toBe('aborted');
  });

  it('writes progress through a completed replacement and leaves no temp file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsx-progress-'));
    const path = join(dir, 'progress.json');
    const progress = markSnapshots(undefined, new Map([['session-1', 'one.json']]));
    writeProgress(path, progress);
    expect(JSON.parse(readFileSync(path, 'utf8')).entries['session-1'].snapshot).toBe('one.json');
    expect(existsSync(`${path}.tmp-${process.pid}`)).toBe(false);
  });

  it('survives a corrupt progress file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsx-progress-'));
    const path = join(dir, 'progress.json');
    writeFileSync(path, '{not json', 'utf8');

    expect(readProgress(path)).toBeUndefined();
    expect(readProgress(join(dir, 'missing.json'))).toBeUndefined();
  });
});
