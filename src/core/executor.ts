import { classifyResult } from './http';
import type { ApiResult, DeleteShape, ExecHooks, ExecOptions, ExecResult, Transport } from './types';

const defaultSleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
const DEFAULT_BACKOFF = [1000, 2000, 4000];

export function deleteSession(
  transport: Transport,
  id: string,
  shape: DeleteShape,
): Promise<ApiResult<unknown>> {
  const body = shape === 'single' ? { chat_session_id: id } : { chat_session_ids: [id] };
  return transport.post<unknown>('/api/v0/chat_session/delete', body);
}

/**
 * Serial, rate-limited, idempotent delete queue.
 * One auth failure aborts the whole run: continuing with a dead token only produces noise.
 */
export async function runQueue(
  transport: Transport,
  ids: string[],
  options: ExecOptions,
  hooks: ExecHooks = {},
): Promise<ExecResult[]> {
  const sleep = options.sleep ?? defaultSleep;
  const backoff = options.backoff ?? DEFAULT_BACKOFF;
  const cooldownMs = options.forbiddenCooldownMs ?? 30_000;
  const shape = { current: options.shape };

  const results: ExecResult[] = [];
  let aborted = false;

  for (let index = 0; index < ids.length; index += 1) {
    const id = ids[index];

    if (aborted) {
      const skipped: ExecResult = { id, status: 'skipped', attempts: 0, ms: 0, reason: 'ABORTED' };
      results.push(skipped);
      hooks.onResult?.(skipped);
      continue;
    }

    if (index > 0) {
      await sleep(index % options.batchSize === 0 ? options.batchPauseMs : options.intervalMs);
    }

    hooks.onStart?.(id, index, ids.length);

    if (options.dryRun) {
      const dry: ExecResult = { id, status: 'skipped', attempts: 0, ms: 0, reason: 'DRY_RUN' };
      results.push(dry);
      hooks.onResult?.(dry);
      continue;
    }

    let attempts = 0;
    let lastReason = 'UNKNOWN';
    let lastMs = 0;
    let outcome: ExecResult | null = null;

    while (outcome === null && attempts < options.retries + 1) {
      attempts += 1;
      const started = Date.now();

      let response: ApiResult<unknown> | null = null;
      try {
        response = await deleteSession(transport, id, shape.current === 'auto' ? 'single' : shape.current);
      } catch (error) {
        // Distinguish a hung connection from an HTTP-level failure so reports stay diagnosable.
        const message = error instanceof Error ? error.message : 'NETWORK';
        const isTimeout = error instanceof Error && (error.name === 'AbortError' || message.includes('超时'));
        lastReason = isTimeout ? `TIMEOUT: ${message}` : message;
      }
      lastMs = Date.now() - started;

      if (!response) {
        if (attempts < options.retries + 1) {
          await sleep(backoff[Math.min(attempts - 1, backoff.length - 1)] ?? 4000);
        }
        continue;
      }

      const kind = classifyResult(response);

      if (kind === 'ok') {
        const bizOk = response.bizCode === undefined || response.bizCode === 0;
        outcome = bizOk
          ? { id, status: 'deleted', attempts, ms: lastMs }
          : {
              id,
              status: 'failed',
              attempts,
              ms: lastMs,
              reason: response.bizMsg ?? `biz_code=${response.bizCode ?? 'unknown'}`,
            };
        break;
      }

      if (kind === 'schema') {
        if (shape.current === 'auto') {
          shape.current = 'array';
          hooks.onShapeDetected?.('array');
          lastReason = 'SHAPE_SWITCHED';
          continue;
        }
        outcome = { id, status: 'failed', attempts, ms: lastMs, reason: 'SCHEMA_MISMATCH' };
        break;
      }

      if (kind === 'auth') {
        outcome = { id, status: 'aborted', attempts, ms: lastMs, reason: 'AUTH_FAILED' };
        aborted = true;
        break;
      }

      lastReason = kind.toUpperCase();

      if (kind === 'forbidden') {
        if (attempts < options.retries + 1) await sleep(cooldownMs);
      } else if (kind === 'rate' || kind === 'server') {
        if (attempts < options.retries + 1) {
          await sleep(backoff[Math.min(attempts - 1, backoff.length - 1)] ?? 4000);
        }
      } else {
        outcome = { id, status: 'failed', attempts, ms: lastMs, reason: response.bizMsg ?? kind };
      }
    }

    const final: ExecResult = outcome ?? {
      id,
      status: 'failed',
      attempts,
      ms: lastMs,
      reason: lastReason,
    };
    results.push(final);
    hooks.onResult?.(final);
  }

  return results;
}
