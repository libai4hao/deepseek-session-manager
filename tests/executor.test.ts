import { describe, expect, it } from 'vitest';
import { runQueue } from '../src/core/executor';
import type { ApiResult, ExecOptions, Transport } from '../src/core/types';

const IDS = ['id-one-0001', 'id-two-0002', 'id-three-0003'];

function makeTransport(responses: Array<() => ApiResult<unknown>>) {
  const bodies: unknown[] = [];

  const transport: Transport = {
    async get<T>(): Promise<ApiResult<T>> {
      return { http: 200, code: 0 } as ApiResult<T>;
    },
    async post<T>(_path: string, body: unknown): Promise<ApiResult<T>> {
      bodies.push(body);
      const next = responses.shift();
      return (next ? next() : { http: 200, code: 0 }) as ApiResult<T>;
    },
  };

  return { transport, bodies };
}

const fastOptions = (overrides: Partial<ExecOptions> = {}): ExecOptions => ({
  intervalMs: 0,
  batchSize: 10,
  batchPauseMs: 0,
  retries: 2,
  shape: 'auto',
  sleep: async () => undefined,
  ...overrides,
});

describe('runQueue', () => {
  it('does not touch the network in dry-run mode', async () => {
    const { transport, bodies } = makeTransport([]);
    const results = await runQueue(transport, IDS, fastOptions({ dryRun: true }));

    expect(bodies).toHaveLength(0);
    expect(results.every(result => result.status === 'skipped' && result.reason === 'DRY_RUN')).toBe(true);
  });

  it('deletes every id with the single-body shape by default', async () => {
    const { transport, bodies } = makeTransport([]);
    const results = await runQueue(transport, IDS.slice(0, 2), fastOptions());

    expect(results.map(result => result.status)).toEqual(['deleted', 'deleted']);
    expect(bodies).toEqual([{ chat_session_id: IDS[0] }, { chat_session_id: IDS[1] }]);
  });

  it('switches to the array shape when the API answers 422', async () => {
    let shapeSeen: string | undefined;
    const { transport, bodies } = makeTransport([
      () => ({ http: 422, code: 422, detail: [{ loc: 'body.chat_session_ids' }] }),
      () => ({ http: 200, code: 0 }),
    ]);

    const results = await runQueue(transport, [IDS[0]], fastOptions(), {
      onShapeDetected: shape => {
        shapeSeen = shape;
      },
    });

    expect(shapeSeen).toBe('array');
    expect(results[0].status).toBe('deleted');
    expect(bodies[0]).toEqual({ chat_session_id: IDS[0] });
    expect(bodies[1]).toEqual({ chat_session_ids: [IDS[0]] });
  });

  it('aborts the queue when the token is invalid', async () => {
    const { transport } = makeTransport([
      () => ({ http: 200, code: 0 }),
      () => ({ http: 200, code: 40003 }),
    ]);

    const results = await runQueue(transport, IDS, fastOptions());

    expect(results[0].status).toBe('deleted');
    expect(results[1].status).toBe('aborted');
    expect(results[2].status).toBe('skipped');
    expect(results[2].reason).toBe('ABORTED');
  });

  it('retries a 5xx response and then succeeds', async () => {
    const { transport } = makeTransport([
      () => ({ http: 503, code: 503 }),
      () => ({ http: 200, code: 0 }),
    ]);

    const results = await runQueue(transport, [IDS[0]], fastOptions());

    expect(results[0].status).toBe('deleted');
    expect(results[0].attempts).toBe(2);
  });

  it('treats exhausted network retries as a failure, not a crash', async () => {
    const transport: Transport = {
      async get<T>(): Promise<ApiResult<T>> {
        return { http: 200, code: 0 } as ApiResult<T>;
      },
      async post<T>(): Promise<ApiResult<T>> {
        throw new Error('ECONNRESET');
      },
    };

    const results = await runQueue(transport, [IDS[0]], fastOptions({ retries: 1 }));

    expect(results[0].status).toBe('failed');
    expect(results[0].reason).toContain('ECONNRESET');
  });
});
