import { describe, expect, it } from 'vitest';

import { decryptSnapshot, encryptedFileName, encryptSnapshot } from '../src/core/snapshot-crypto';
import type { Snapshot } from '../src/core/snapshot';

const snapshot: Snapshot = {
  schema: 'dsx.snapshot.v1',
  id: '7d76209a-4092-47be-bfb0-cae33b520507',
  title: '内部讨论：季度预算',
  pinned: false,
  updatedAt: 1_760_000_000,
  capturedAt: '2026-11-22T00:00:00.000Z',
  messageCount: 1,
  messages: [{ messageId: 1, role: 'user', insertedAt: 1, type: 'text', content: 'secret-plaintext-marker' }],
};

describe('snapshot encryption', () => {
  it('round-trips with the right password', () => {
    const envelope = encryptSnapshot(snapshot, 'correct horse battery staple');
    expect(decryptSnapshot(envelope, 'correct horse battery staple')).toEqual(snapshot);
  });

  it('rejects a wrong password', () => {
    const envelope = encryptSnapshot(snapshot, 'right');
    expect(() => decryptSnapshot(envelope, 'wrong')).toThrow();
  });

  it('leaks neither title nor content in the envelope', () => {
    const serialized = JSON.stringify(encryptSnapshot(snapshot, 'pw'));
    expect(serialized).not.toContain('季度预算');
    expect(serialized).not.toContain('secret-plaintext-marker');
    expect(serialized).toContain('dsx.snapshot.enc.v1');
  });

  it('names encrypted files distinctly', () => {
    expect(encryptedFileName('20261122_t_7d76209a.json')).toBe('20261122_t_7d76209a.enc.json');
  });
});
