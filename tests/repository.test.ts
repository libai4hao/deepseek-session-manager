import { describe, expect, it } from 'vitest';
import { listSessions } from '../src/core/repository';
import type { ApiResult, Transport } from '../src/core/types';

function transportFor(pages: Array<Record<string, unknown>>): Transport {
  return {
    async get<T>(): Promise<ApiResult<T>> {
      const page = pages.shift();
      if (!page) throw new Error('unexpected page request');
      return { http: 200, code: 0, data: page } as ApiResult<T>;
    },
    async post<T>(): Promise<ApiResult<T>> { return { http: 200, code: 0 } as ApiResult<T>; },
  };
}

describe('listSessions pagination safety', () => {
  it('does not return a partial list when maxPages is exhausted', async () => {
    const transport = transportFor([
      { chat_sessions: [{ id: 'a', updated_at: 3, seq_id: 3 }], has_more: true, next_cursor: 2 },
      { chat_sessions: [{ id: 'b', updated_at: 2, seq_id: 2 }], has_more: true, next_cursor: 1 },
    ]);
    await expect(listSessions(transport, { maxPages: 2 })).rejects.toThrow(/最大页数/);
  });

  it('returns all pages when the final page confirms completion', async () => {
    const transport = transportFor([
      { chat_sessions: [{ id: 'a', updated_at: 3, seq_id: 3 }], has_more: true, next_cursor: 2 },
      { chat_sessions: [{ id: 'b', updated_at: 2, seq_id: 2 }], has_more: false },
    ]);
    const sessions = await listSessions(transport, { maxPages: 2 });
    expect(sessions.map(session => session.id)).toEqual(['a', 'b']);
  });

  it('refuses to loop when the server keeps returning the same page', async () => {
    const page = { chat_sessions: [{ id: 'a', updated_at: 3, seq_id: 3 }], has_more: true, next_cursor: 3 };
    const transport = transportFor([page, page, page]);
    await expect(listSessions(transport, { maxPages: 10 })).rejects.toThrow(/游标未推进/);
  });
});
