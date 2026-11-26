import { describe, expect, it } from 'vitest';

import { decryptSnapshot, encryptedFileName, encryptedSnapshotFileName, encryptSnapshot, validateEncryptedSnapshot } from '../src/cli/snapshot-crypto';
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

  it('keeps titles out of encrypted filenames and uses the full session id', () => {
    const name = encryptedSnapshotFileName({
      id: 'abcdefgh-1111-2222-3333-444444444444',
      title: '内部讨论：季度预算',
      pinned: false,
      updatedAt: snapshot.updatedAt,
    });
    expect(name).not.toContain('内部讨论');
    expect(name).toContain('61626364656667682d313131312d323232322d333333332d3434343434343434343434');
  });

  it('rejects arbitrary nonempty ciphertext as an envelope', () => {
    expect(() => validateEncryptedSnapshot('ciphertext')).toThrow(/结构无效/);
  });

  it('rejects truncated tags, noncanonical base64, wrong lengths, and mismatched KDF metadata', () => {
    const envelope = encryptSnapshot(snapshot, 'pw', Buffer.alloc(16, 1));

    expect(() => validateEncryptedSnapshot({
      ...envelope,
      cipher: { ...envelope.cipher, tag: envelope.cipher.tag.slice(0, -4) },
    })).toThrow(/tag/);
    expect(() => validateEncryptedSnapshot({
      ...envelope,
      cipher: { ...envelope.cipher, iv: `${envelope.cipher.iv}\n` },
    })).toThrow(/iv/);
    expect(() => validateEncryptedSnapshot({
      ...envelope,
      kdf: { ...envelope.kdf, salt: Buffer.alloc(8).toString('base64') },
    })).toThrow(/salt/);
    expect(() => validateEncryptedSnapshot({
      ...envelope,
      kdf: { ...envelope.kdf, N: envelope.kdf.N / 2 },
    })).toThrow(/结构无效/);
  });

  it('rejects an invalid encryption salt length', () => {
    expect(() => encryptSnapshot(snapshot, 'pw', Buffer.alloc(8))).toThrow(/16 字节/);
  });
});
