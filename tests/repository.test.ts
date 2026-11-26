import { describe, expect, it } from 'vitest';
import { getMessages, listSessions } from '../src/core/repository';
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

  it('rejects an empty page that still claims more results', async () => {
    const transport = transportFor([{ chat_sessions: [], has_more: true }]);
    await expect(listSessions(transport)).rejects.toThrow(/空页/);
  });

  it('rejects a missing pagination flag or session array', async () => {
    await expect(listSessions(transportFor([{ chat_sessions: [] }]))).rejects.toThrow(/has_more/);
    await expect(listSessions(transportFor([{ has_more: false }]))).rejects.toThrow(/chat_sessions/);
  });

  it('rejects invalid declared cursors instead of silently changing dialect', async () => {
    await expect(listSessions(transportFor([
      { chat_sessions: [{ id: 'a', updated_at: 3, seq_id: 3 }], has_more: true, next_cursor: 'bad' },
    ]))).rejects.toThrow(/next_cursor/);
    await expect(listSessions(transportFor([
      { chat_sessions: [{ id: 'a', updated_at: 3, seq_id: false }], has_more: true },
    ]))).rejects.toThrow(/seq_id/);
  });

  it('falls back to the time cursor when seq ids are null', async () => {
    const paths: string[] = [];
    const pages = [
      { chat_sessions: [{ id: 'a', updated_at: 3, seq_id: null }], has_more: true },
      { chat_sessions: [{ id: 'b', updated_at: 2, seq_id: null }], has_more: false },
    ];
    const transport: Transport = {
      async get<T>(path: string): Promise<ApiResult<T>> {
        paths.push(path);
        return { http: 200, code: 0, data: pages.shift() } as ApiResult<T>;
      },
      async post<T>(): Promise<ApiResult<T>> {
        return { http: 200, code: 0 } as ApiResult<T>;
      },
    };

    await listSessions(transport);

    expect(paths[1]).toContain('lte_cursor.updated_at=3');
    expect(paths[1]).not.toContain('before_seq_id=0');
  });
});

describe('getMessages validation', () => {
  it('accepts an explicitly empty message array', async () => {
    const transport = transportFor([{ chat_messages: [] }]);
    await expect(getMessages(transport, 'session-1')).resolves.toEqual([]);
  });

  it('rejects missing or malformed message arrays', async () => {
    await expect(getMessages(transportFor([{}]), 'session-1')).rejects.toThrow(/chat_messages/);
    await expect(getMessages(transportFor([{ chat_messages: [null] }]), 'session-1')).rejects.toThrow(/chat_messages/);
    await expect(getMessages(transportFor([{ chat_messages: [{ fragments: 'bad' }] }]), 'session-1')).rejects.toThrow(/fragments/);
    await expect(getMessages(transportFor([{ chat_messages: [{ message_id: 1, role: 'user', inserted_at: 1 }] }]), 'session-1')).rejects.toThrow(/fragments/);
  });

  it('rejects a nonzero business code', async () => {
    const transport: Transport = {
      async get<T>(): Promise<ApiResult<T>> {
        return { http: 200, code: 0, bizCode: 1, data: { chat_messages: [] } } as ApiResult<T>;
      },
      async post<T>(): Promise<ApiResult<T>> {
        return { http: 200, code: 0 } as ApiResult<T>;
      },
    };

    await expect(getMessages(transport, 'session-1')).rejects.toThrow(/业务码/);
  });
});
