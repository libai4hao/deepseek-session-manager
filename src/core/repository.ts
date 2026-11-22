import { ApiFailure } from './http';
import type { ChatMessage, SessionMeta, Transport } from './types';

const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_MAX_PAGES = 200;

function num(value: unknown, fallback = 0): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toMeta(raw: Record<string, unknown>): SessionMeta | undefined {
  const id = raw['id'];
  if (typeof id !== 'string' || !id) return undefined;

  const title = raw['title'];
  return {
    id,
    title: typeof title === 'string' && title ? title : '(无标题)',
    pinned: raw['pinned'] === true,
    updatedAt: num(raw['updated_at']),
    seqId: raw['seq_id'] === undefined || raw['seq_id'] === null ? undefined : num(raw['seq_id']),
  };
}

/**
 * `fetch_page` has two cursor dialects in the wild:
 *   new: ?count=N&before_seq_id=<seq>, response carries next_cursor / has_more
 *   old: ?lte_cursor.pinned=false&lte_cursor.updated_at=<ts>
 * We start with `count` only, then pick a dialect from the first response.
 */
export async function listSessions(
  transport: Transport,
  options: { pageSize?: number; maxPages?: number } = {},
): Promise<SessionMeta[]> {
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;

  const sessionsOut: SessionMeta[] = [];
  const seen = new Set<string>();
  let cursor: number | null = null;
  let mode: 'seq' | 'time' | null = null;

  if (!Number.isSafeInteger(pageSize) || pageSize < 1) throw new Error('pageSize 必须为正整数');
  if (!Number.isSafeInteger(maxPages) || maxPages < 1) throw new Error('maxPages 必须为正整数');
  let completed = false;
  for (let page = 0; page < maxPages; page += 1) {
    let path = `/api/v0/chat_session/fetch_page?count=${pageSize}`;
    if (cursor !== null && mode !== null) {
      path +=
        mode === 'seq'
          ? `&before_seq_id=${cursor}`
          : `&lte_cursor.updated_at=${cursor}`;
    }

    const result = await transport.get<Record<string, unknown>>(path);
    const biz = result.data;

    if (result.http !== 200 || result.code !== 0 || !biz) {
      throw new ApiFailure(result, `会话列表接口异常（http=${result.http}, code=${result.code}）`);
    }

    const batch = Array.isArray(biz['chat_sessions'])
      ? (biz['chat_sessions'] as Array<Record<string, unknown>>)
      : [];

    for (const item of batch) {
      const meta = toMeta(item);
      if (meta && !seen.has(meta.id)) {
        seen.add(meta.id);
        sessionsOut.push(meta);
      }
    }

    if (biz['has_more'] !== true || batch.length === 0) { completed = true; break; }

    let candidate: number | undefined;

    const nextCursor = biz['next_cursor'];
    if (nextCursor !== undefined && nextCursor !== null) {
      mode = 'seq';
      candidate = num(nextCursor);
    } else {
      const seqIds = batch
        .map(item => num(item['seq_id'], Number.NaN))
        .filter(value => Number.isFinite(value));

      if (seqIds.length > 0) {
        mode = 'seq';
        candidate = Math.min(...seqIds);
      } else {
        const times = batch
          .map(item => num(item['updated_at'], Number.NaN))
          .filter(value => Number.isFinite(value));

        if (times.length === 0) {
          throw new Error('分页响应声明 has_more=true，但缺少可用游标；拒绝返回不完整会话列表');
        }
        mode = 'time';
        candidate = Math.min(...times);
      }
    }

    if (candidate === cursor) {
      throw new Error(`分页游标未推进（${mode}: ${candidate}）；拒绝在重复页面上空转并返回不完整列表`);
    }

    cursor = candidate;
  }

  if (!completed) {
    throw new Error(`会话分页达到最大页数 ${maxPages}，仍无法确认列表完整；已拒绝返回部分结果`);
  }
  return sessionsOut;
}

function toMessage(raw: Record<string, unknown>): ChatMessage {
  const fragments = Array.isArray(raw['fragments'])
    ? (raw['fragments'] as Array<Record<string, unknown>>)
    : [];

  return {
    messageId: num(raw['message_id']),
    role: typeof raw['role'] === 'string' ? (raw['role'] as string) : 'UNKNOWN',
    insertedAt: num(raw['inserted_at']),
    fragments: fragments.map(fragment => ({
      type: String(fragment['type'] ?? ''),
      content: String(fragment['content'] ?? ''),
    })),
  };
}

export async function getMessages(transport: Transport, sessionId: string): Promise<ChatMessage[]> {
  const path = `/api/v0/chat/history_messages?chat_session_id=${encodeURIComponent(sessionId)}&cache_version=4`;
  const result = await transport.get<Record<string, unknown>>(path);
  const biz = result.data;

  if (result.http !== 200 || result.code !== 0 || !biz) {
    throw new ApiFailure(result, `会话消息接口异常（http=${result.http}, code=${result.code}）`);
  }

  const messages = Array.isArray(biz['chat_messages'])
    ? (biz['chat_messages'] as Array<Record<string, unknown>>)
    : [];

  return messages.map(toMessage);
}

/** Tolerant account fingerprint: the payload shape is not documented. */
export async function getAccountId(transport: Transport): Promise<string | undefined> {
  const result = await transport.get<Record<string, unknown>>('/api/v0/users/current');
  const data = result.data;

  for (const key of ['id', 'user_id', 'uid', 'email']) {
    const value = data?.[key];
    if (typeof value === 'string' && value) return value;
  }
  return undefined;
}

export async function verifyDeleted(
  transport: Transport,
  ids: string[],
): Promise<Array<{ id: string; stillThere: boolean }>> {
  const remaining = new Set((await listSessions(transport)).map(session => session.id));
  return ids.map(id => ({ id, stillThere: remaining.has(id) }));
}
