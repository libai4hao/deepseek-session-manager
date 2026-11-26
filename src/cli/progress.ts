import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { snapshotMatchesMeta, validateSnapshot } from '../core/snapshot';
import type { ExecResult, SessionMeta } from '../core/types';
import { validateEncryptedSnapshot } from './snapshot-crypto';

export type ProgressStatus = 'snapshotted' | 'deleted' | 'skipped' | 'failed' | 'aborted';

export interface ProgressEntry {
  status: ProgressStatus;
  at: string;
  attempts?: number;
  ms?: number;
  snapshot?: string;
  verifiedAt?: string;
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
    if (typeof parsed.updatedAt !== 'string') return undefined;
    if (parsed.accountHash !== undefined && typeof parsed.accountHash !== 'string') return undefined;
    if (!parsed.entries || typeof parsed.entries !== 'object' || Array.isArray(parsed.entries)) return undefined;
    const validStatuses = new Set<ProgressStatus>(['snapshotted', 'deleted', 'skipped', 'failed', 'aborted']);
    for (const [id, entry] of Object.entries(parsed.entries)) {
      if (!id || !entry || typeof entry !== 'object' || !validStatuses.has(entry.status) || typeof entry.at !== 'string') {
        return undefined;
      }
      if (entry.snapshot !== undefined && typeof entry.snapshot !== 'string') return undefined;
      if (entry.verifiedAt !== undefined && typeof entry.verifiedAt !== 'string') return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

/** Only a confirmed deletion is safe to skip on resume. */
export function completedIds(progress?: Progress): Set<string> {
  const done = new Set<string>();
  for (const [id, entry] of Object.entries(progress?.entries ?? {})) {
    if (entry.status === 'deleted' && entry.verifiedAt) done.add(id);
  }
  return done;
}

/** Snapshots captured by an earlier run can be reused instead of re-fetching the transcript. */
export function reusableSnapshots(
  progress: Progress | undefined,
  snapshotDir: string,
  exists: (path: string) => boolean = existsSync,
  read: (path: string) => string = path => readFileSync(path, 'utf8'),
  metaById?: Map<string, SessionMeta>,
): Map<string, string> {
  const reusable = new Map<string, string>();

  for (const [id, entry] of Object.entries(progress?.entries ?? {})) {
    const name = entry.snapshot;
    // A progress file is user-editable: never let it point outside snapshots/.
    if (!name || basename(name) !== name || !exists(join(snapshotDir, name))) continue;

    const fullPath = join(snapshotDir, name);
    try {
      if (name.endsWith('.enc.json')) {
        validateEncryptedSnapshot(JSON.parse(read(fullPath)));
      } else {
        const snapshot = validateSnapshot(JSON.parse(read(fullPath)));
        if (snapshot.id !== id) continue;
        const meta = metaById?.get(id);
        if (meta && !snapshotMatchesMeta(snapshot, meta)) continue;
      }
    } catch {
      continue;
    }

    reusable.set(id, name);
  }

  return reusable;
}

export type ResumeAccountVerdict = 'ok' | 'no-current-hash' | 'no-stored-hash' | 'mismatch';

/** Resume must never mix two accounts, even when they share an output directory. */
export function checkResumeAccount(
  progress: Progress | undefined,
  accountHash: string | undefined,
): ResumeAccountVerdict {
  if (!progress) return 'ok';
  if (!accountHash) return 'no-current-hash';
  if (!progress.accountHash) return 'no-stored-hash';
  return progress.accountHash === accountHash ? 'ok' : 'mismatch';
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
      result.status === 'noop'
        ? 'failed'
        : result.status === 'skipped' && result.reason === 'ABORTED'
          ? 'aborted'
          : (result.status as ProgressStatus);

    base.entries[result.id] = {
      status,
      at,
      attempts: result.attempts,
      ms: result.ms,
      snapshot: idToSnapshot.get(result.id) ?? base.entries[result.id]?.snapshot,
      verifiedAt: status === 'deleted' ? at : undefined,
    };
  }

  base.updatedAt = at;
  return base;
}

export { reconcileDeletedResults } from '../core/executor';

export function writeProgress(path: string, progress: Progress): void {
  const tempPath = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(tempPath, `${JSON.stringify(progress, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    renameSync(tempPath, path);
  } catch (error) {
    try {
      if (existsSync(tempPath)) {
        unlinkSync(tempPath);
      }
    } catch { /* preserve original write error */ }
    throw error;
  }
}
