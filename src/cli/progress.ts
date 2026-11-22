import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ExecResult } from '../core/types';

export type ProgressStatus = 'snapshotted' | 'deleted' | 'skipped' | 'failed' | 'aborted';

export interface ProgressEntry {
  status: ProgressStatus;
  at: string;
  attempts?: number;
  ms?: number;
  snapshot?: string;
}

export interface Progress {
  schema: 'dsx.progress.v1';
  updatedAt: string;
  accountHash?: string;
  entries: Record<string, ProgressEntry>;
}

export function progressPath(outDir: string): string {
  return join(outDir, 'progress.json');
}

/** Tolerate a corrupt or hand-edited file: resume simply starts from scratch. */
export function readProgress(path: string): Progress | undefined {
  if (!existsSync(path)) return undefined;

  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Progress;
    if (parsed.schema !== 'dsx.progress.v1') return undefined;
    if (!parsed.entries || typeof parsed.entries !== 'object') return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

/** Ids whose work is finished for good: deleted, or confirmed absent on the server. */
export function completedIds(progress?: Progress): Set<string> {
  const done = new Set<string>();
  for (const [id, entry] of Object.entries(progress?.entries ?? {})) {
    if (entry.status === 'deleted' || entry.status === 'skipped') done.add(id);
  }
  return done;
}

/** Snapshots captured by an earlier run can be reused instead of re-fetching the transcript. */
export function reusableSnapshots(
  progress: Progress | undefined,
  snapshotDir: string,
  exists: (path: string) => boolean = existsSync,
): Map<string, string> {
  const reusable = new Map<string, string>();
  for (const [id, entry] of Object.entries(progress?.entries ?? {})) {
    if (entry.snapshot && exists(join(snapshotDir, entry.snapshot))) reusable.set(id, entry.snapshot);
  }
  return reusable;
}

function emptyProgress(accountHash?: string): Progress {
  return { schema: 'dsx.progress.v1', updatedAt: new Date().toISOString(), accountHash, entries: {} };
}

export function markSnapshots(
  progress: Progress | undefined,
  idToFile: Map<string, string>,
  now: Date = new Date(),
): Progress {
  const base = progress ?? emptyProgress();
  const at = now.toISOString();

  for (const [id, snapshot] of idToFile) {
    base.entries[id] = { ...base.entries[id], status: 'snapshotted', at, snapshot };
  }

  base.updatedAt = at;
  return base;
}

export function mergeResults(
  progress: Progress | undefined,
  results: ExecResult[],
  idToSnapshot: Map<string, string> = new Map(),
  now: Date = new Date(),
): Progress {
  const base = progress ?? emptyProgress();
  const at = now.toISOString();

  for (const result of results) {
    const status: ProgressStatus =
      result.status === 'noop' ? 'deleted' : (result.status as ProgressStatus);

    base.entries[result.id] = {
      status,
      at,
      attempts: result.attempts,
      ms: result.ms,
      snapshot: idToSnapshot.get(result.id) ?? base.entries[result.id]?.snapshot,
    };
  }

  base.updatedAt = at;
  return base;
}

export function writeProgress(path: string, progress: Progress): void {
  writeFileSync(path, JSON.stringify(progress, null, 2), 'utf8');
}
