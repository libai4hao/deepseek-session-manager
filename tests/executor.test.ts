import { describe, expect, it } from 'vitest';
import { reconcileDeletedResults, runQueue } from '../src/core/executor';
import { ApiFailure } from '../src/core/http';
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

describe('reconcileDeletedResults', () => {
  it('requires verification for both deleted and noop outcomes', () => {
    const results = [
      { id: 'a', status: 'deleted' as const, attempts: 1, ms: 1 },
      { id: 'b', status: 'noop' as const, attempts: 1, ms: 1 },
      { id: 'c', status: 'failed' as const, attempts: 1, ms: 1 },
      { id: 'd', status: 'noop' as const, attempts: 1, ms: 1 },
    ];

    expect(reconcileDeletedResults(results, [
      { id: 'a', stillThere: false },
      { id: 'b', stillThere: true },
      { id: 'd', stillThere: false },
    ]).map(result => [result.status, result.reason])).toEqual([
      ['deleted', undefined],
      ['failed', 'VERIFY_STILL_THERE'],
      ['failed', undefined],
      ['deleted', undefined],
    ]);
    expect(reconcileDeletedResults(results, undefined).every(result => result.status === 'failed')).toBe(true);
  });
});

describe('runQueue', () => {
  it('stops before a delete when final validation fails', async () => {
    const { transport, bodies } = makeTransport([]);
    const validated: string[] = [];
    const results = await runQueue(transport, IDS, fastOptions(), {
      beforeDelete: id => {
        validated.push(id);
        if (id === IDS[1]) throw new Error('session changed');
      },
    });

    expect(validated).toEqual(IDS.slice(0, 2));
    expect(bodies).toEqual([{ chat_session_id: IDS[0] }]);
    expect(results[1]).toMatchObject({ status: 'failed', attempts: 0 });
    expect(results[1].reason).toContain('PRE_DELETE_VALIDATION_FAILED');
    expect(results[2]).toMatchObject({ status: 'skipped', reason: 'ABORTED' });
  });

  it.each([503, 422])('revalidates before another POST after HTTP %i', async status => {
    let validations = 0;
    const bodies: unknown[] = [];
    const transport: Transport = {
      async get<T>(): Promise<ApiResult<T>> { return { http: 200, code: 0 } as ApiResult<T>; },
      async post<T>(_path: string, body: unknown): Promise<ApiResult<T>> {
        bodies.push(body);
        return { http: status, code: status } as ApiResult<T>;
      },
    };

    const results = await runQueue(transport, [IDS[0]], fastOptions({ retries: 1 }), {
      beforeDelete: () => {
        validations += 1;
        if (validations === 2) throw new Error('session changed during backoff');
      },
    });

    expect(validations).toBe(2);
    expect(bodies).toEqual([{ chat_session_id: IDS[0] }]);
    expect(results[0]).toMatchObject({ status: 'failed', attempts: 1 });
    expect(results[0].reason).toContain('PRE_DELETE_VALIDATION_FAILED');
  });

  it('does not touch the network in dry-run mode', async () => {
    const { transport, bodies } = makeTransport([]);
    const started: string[] = [];
    const results = await runQueue(transport, IDS, fastOptions({
      dryRun: true,
    }), {
      beforeDelete: () => { throw new Error('dry-run must not validate'); },
      onStart: id => { started.push(id); },
    });

    expect(bodies).toHaveLength(0);
    expect(started).toEqual(IDS);
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

  it('still sends the array shape when retries are zero', async () => {
    const { transport, bodies } = makeTransport([
      () => ({ http: 422, code: 422 }),
      () => ({ http: 200, code: 0 }),
    ]);

    const results = await runQueue(transport, [IDS[0]], fastOptions({ retries: 0 }));

    expect(bodies).toEqual([
      { chat_session_id: IDS[0] },
      { chat_session_ids: [IDS[0]] },
    ]);
    expect(results[0]).toMatchObject({ status: 'deleted', attempts: 2 });
  });

  it('does not charge a shape probe against the retry budget', async () => {
    let call = 0;
    const transport: Transport = {
      async get<T>(): Promise<ApiResult<T>> {
        return { http: 200, code: 0 } as ApiResult<T>;
      },
      async post<T>(): Promise<ApiResult<T>> {
        call += 1;
        if (call === 1) throw new Error('ECONNRESET');
        if (call === 2) return { http: 422, code: 422 } as ApiResult<T>;
        return { http: 200, code: 0 } as ApiResult<T>;
      },
    };

    const results = await runQueue(transport, [IDS[0]], fastOptions({ retries: 1 }));

    expect(call).toBe(3);
    expect(results[0]).toMatchObject({ status: 'deleted', attempts: 3 });
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

  it('aborts when the transport preserves an HTTP auth failure', async () => {
    let calls = 0;
    const transport: Transport = {
      async get<T>(): Promise<ApiResult<T>> { return { http: 200, code: 0 } as ApiResult<T>; },
      async post<T>(): Promise<ApiResult<T>> {
        calls += 1;
        throw new ApiFailure({ http: 401, code: 401 }, '接口响应不是合法 JSON');
      },
    };

    const results = await runQueue(transport, IDS, fastOptions());

    expect(calls).toBe(1);
    expect(results[0]).toMatchObject({ status: 'aborted', reason: 'AUTH_FAILED' });
    expect(results[1]).toMatchObject({ status: 'skipped', reason: 'ABORTED' });
    expect(results[2]).toMatchObject({ status: 'skipped', reason: 'ABORTED' });
  });

  it('keeps the forbidden cooldown for transport failures with HTTP status', async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const transport: Transport = {
      async get<T>(): Promise<ApiResult<T>> { return { http: 200, code: 0 } as ApiResult<T>; },
      async post<T>(): Promise<ApiResult<T>> {
        calls += 1;
        if (calls === 1) throw new ApiFailure({ http: 403, code: 403 }, '接口响应不是合法 JSON');
        return { http: 200, code: 0 } as ApiResult<T>;
      },
    };

    const results = await runQueue(transport, [IDS[0]], fastOptions({
      retries: 1,
      sleep: async ms => { sleeps.push(ms); },
    }));

    expect(calls).toBe(2);
    expect(sleeps).toEqual([30_000]);
    expect(results[0].status).toBe('deleted');
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

  it('does not sleep after the final failed network attempt', async () => {
    let sleeps = 0;
    const transport: Transport = {
      async get<T>(): Promise<ApiResult<T>> { return { http: 200, code: 0 } as ApiResult<T>; },
      async post<T>(): Promise<ApiResult<T>> { throw new Error('ECONNRESET'); },
    };
    await runQueue(transport, [IDS[0]], fastOptions({ retries: 0, sleep: async () => { sleeps += 1; } }));
    expect(sleeps).toBe(0);
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

  it('labels request timeouts separately from other network failures', async () => {
    const transport: Transport = {
      async get<T>(): Promise<ApiResult<T>> { return { http: 200, code: 0 } as ApiResult<T>; },
      async post<T>(): Promise<ApiResult<T>> {
        throw new Error('请求超时（30000ms）：/api/v0/chat_session/delete');
      },
    };

    const results = await runQueue(transport, [IDS[0]], fastOptions({ retries: 0 }));

    expect(results[0].status).toBe('failed');
    expect(results[0].reason).toMatch(/^TIMEOUT:/);
  });
});
