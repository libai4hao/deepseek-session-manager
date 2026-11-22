import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { completedIds, markSnapshots, mergeResults, readProgress, reusableSnapshots } from '../src/cli/progress';

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

  it('reuses only snapshots that still exist on disk', () => {
    const progress = {
      schema: 'dsx.progress.v1' as const,
      updatedAt: '',
      entries: {
        a: { status: 'failed' as const, at: '', snapshot: 'a.json' },
        b: { status: 'failed' as const, at: '', snapshot: 'gone.json' },
      },
    };

    const reusable = reusableSnapshots(progress, '/snap', path => path.endsWith('a.json'));
    expect([...reusable.entries()]).toEqual([['a', 'a.json']]);
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

  it('survives a corrupt progress file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsx-progress-'));
    const path = join(dir, 'progress.json');
    writeFileSync(path, '{not json', 'utf8');

    expect(readProgress(path)).toBeUndefined();
    expect(readProgress(join(dir, 'missing.json'))).toBeUndefined();
  });
});
