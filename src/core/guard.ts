import type { GuardCode, ParsedLink, SessionMeta } from './types';

export interface GuardOutcome {
  ok: boolean;
  code?: GuardCode;
  detail?: string;
  meta?: SessionMeta;
}

export function buildIndex(sessions: SessionMeta[]): Map<string, SessionMeta> {
  return new Map(sessions.map(session => [session.id, session]));
}

/**
 * The only gate between "someone pasted a link" and "we delete a conversation".
 * A missing id is a hard no: we never blind-fire a delete to see what happens.
 */
export function guardLink(
  link: ParsedLink,
  index: Map<string, SessionMeta>,
  options: { protectPinned: boolean } = { protectPinned: true },
): GuardOutcome {
  if (link.kind !== 'session' || !link.id) {
    return { ok: false, code: 'NOT_OWNED', detail: link.reason ?? `链接不可删除（${link.kind}）` };
  }

  const meta = index.get(link.id);
  if (!meta) {
    return {
      ok: false,
      code: 'NOT_FOUND',
      detail: '本账号会话列表中不存在（可能已删除，或属于其他账号）',
    };
  }

  if (options.protectPinned && meta.pinned) {
    return { ok: false, code: 'PINNED_PROTECTED', detail: '置顶会话受保护，默认不删除' };
  }

  return { ok: true, meta };
}
