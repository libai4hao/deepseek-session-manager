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

  const date = new Date(meta.updatedAt * 1000).toISOString().slice(0, 10).replace(/-/g, '');
  return `${date}_${slug}_${meta.id.slice(0, 8)}.json`;
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
