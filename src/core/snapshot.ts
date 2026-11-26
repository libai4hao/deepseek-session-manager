import type { ChatMessage, SessionMeta } from './types';

export interface SnapshotMessage {
  messageId: number;
  role: string;
  insertedAt: number;
  type: string;
  content: string;
}

export interface Snapshot {
  schema: 'dsx.snapshot.v1';
  id: string;
  title: string;
  pinned: boolean;
  updatedAt: number;
  capturedAt: string;
  messageCount: number;
  messages: SnapshotMessage[];
}

export function validateSnapshot(value: unknown): Snapshot {
  const snapshot = value as Partial<Snapshot> | null;
  if (
    !snapshot ||
    snapshot.schema !== 'dsx.snapshot.v1' ||
    typeof snapshot.id !== 'string' ||
    !snapshot.id ||
    typeof snapshot.title !== 'string' ||
    typeof snapshot.pinned !== 'boolean' ||
    typeof snapshot.updatedAt !== 'number' ||
    !Number.isFinite(snapshot.updatedAt) ||
    typeof snapshot.capturedAt !== 'string' ||
    !Array.isArray(snapshot.messages) ||
    snapshot.messageCount !== snapshot.messages.length
  ) {
    throw new Error('快照结构无效');
  }

  for (const message of snapshot.messages) {
    if (
      !message ||
      typeof message.messageId !== 'number' ||
      !Number.isFinite(message.messageId) ||
      typeof message.role !== 'string' ||
      typeof message.insertedAt !== 'number' ||
      !Number.isFinite(message.insertedAt) ||
      typeof message.type !== 'string' ||
      typeof message.content !== 'string'
    ) {
      throw new Error('快照消息结构无效');
    }
  }

  return snapshot as Snapshot;
}

export function snapshotIdForFileName(id: string): string {
  return Array.from(new TextEncoder().encode(id), byte => byte.toString(16).padStart(2, '0')).join('');
}

export function snapshotMatchesMeta(snapshot: Snapshot, meta: SessionMeta): boolean {
  return snapshot.id === meta.id && snapshot.updatedAt === meta.updatedAt;
}

export function buildSnapshot(
  meta: SessionMeta,
  messages: ChatMessage[],
  capturedAt: Date = new Date(),
): Snapshot {
  const flattened: SnapshotMessage[] = messages.flatMap(message =>
    message.fragments.map(fragment => ({
      messageId: message.messageId,
      role: message.role,
      insertedAt: message.insertedAt,
      type: fragment.type,
      content: fragment.content,
    })),
  );

  return {
    schema: 'dsx.snapshot.v1',
    id: meta.id,
    title: meta.title,
    pinned: meta.pinned,
    updatedAt: meta.updatedAt,
    capturedAt: capturedAt.toISOString(),
    messageCount: flattened.length,
    messages: flattened,
  };
}

export function snapshotFileName(meta: SessionMeta): string {
  const slug =
    meta.title
      .replace(/[\\/:*?"<>|\s]+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_|_$/g, '')
      .slice(0, 40) || 'untitled';

  const safeId = snapshotIdForFileName(meta.id);
  const date = new Date(meta.updatedAt * 1000).toISOString().slice(0, 10).replace(/-/g, '');
  return `${date}_${slug}_${safeId}.json`;
}

export function summarizeSnapshot(snapshot: Snapshot): string {
  const first = snapshot.messages[0]?.content ?? '';
  const last = snapshot.messages[snapshot.messages.length - 1]?.content ?? '';
  return [
    `会话：${snapshot.title}`,
    `消息片段：${snapshot.messageCount}`,
    `首段：${first.slice(0, 80)}`,
    `末段：${last.slice(0, 80)}`,
  ].join('\n');
}
