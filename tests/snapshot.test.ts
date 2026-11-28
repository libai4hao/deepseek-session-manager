import { describe, expect, it } from 'vitest';

import { assertUsableBackups, buildSnapshot, snapshotFileName, snapshotMatchesMeta, validateSnapshot } from '../src/core/snapshot';

describe('snapshot files', () => {
  it('does not collide when two session ids share the same prefix', () => {
    const base = { title: 'Same title', pinned: false, updatedAt: 1_700_000_000 };
    expect(snapshotFileName({ ...base, id: 'abcdefgh-1' })).not.toBe(
      snapshotFileName({ ...base, id: 'abcdefgh-2' }),
    );
  });

  it('uses a lossless full id in filenames', () => {
    const base = { title: 'Same title', pinned: false, updatedAt: 1_700_000_000 };
    const underscored = snapshotFileName({ ...base, id: '_abcdefgh' });
    const plain = snapshotFileName({ ...base, id: 'abcdefgh' });

    expect(underscored).not.toBe(plain);
    expect(underscored).toContain('5f6162636465666768');
    expect(plain).toContain('6162636465666768');
  });

  it('accepts a reusable snapshot only for the same current version', () => {
    const snapshot = validateSnapshot({
      schema: 'dsx.snapshot.v1', id: 'a', title: 'title', pinned: false, updatedAt: 10,
      capturedAt: '2026-01-01T00:00:00.000Z', messageCount: 0, messages: [],
    });
    const meta = { id: 'a', title: 'title', pinned: false, updatedAt: 10 };

    expect(snapshotMatchesMeta(snapshot, meta)).toBe(true);
    expect(snapshotMatchesMeta(snapshot, { ...meta, updatedAt: 11 })).toBe(false);
    expect(snapshotMatchesMeta(snapshot, { ...meta, id: 'b' })).toBe(false);
  });

  it('rejects incomplete snapshots', () => {
    expect(() => validateSnapshot({ schema: 'dsx.snapshot.v1', id: 'a' })).toThrow(/结构无效/);
  });

  it('accepts a complete empty snapshot', () => {
    expect(validateSnapshot({
      schema: 'dsx.snapshot.v1',
      id: 'a',
      title: 'empty',
      pinned: false,
      updatedAt: 1,
      capturedAt: '2026-01-01T00:00:00.000Z',
      messageCount: 0,
      messages: [],
    }).id).toBe('a');
  });

  it('keeps the title out of the file name when masking', () => {
    const meta = { id: 'abcdefgh', title: 'Confidential Q3 plan', pinned: false, updatedAt: 1_700_000_000 };
    const masked = snapshotFileName(meta, { maskTitle: true });

    expect(masked).not.toContain('Confidential');
    expect(masked).toContain('_session_');
    expect(snapshotFileName({ ...meta, id: 'abcdefff' }, { maskTitle: true })).not.toBe(masked);
  });

  it('refuses to treat an empty capture as a usable backup before deleting', () => {
    const meta = { id: 'a', title: 'empty', pinned: false, updatedAt: 1 };

    expect(() => assertUsableBackups([buildSnapshot(meta, [])])).toThrow(/快照为空/);
    expect(() =>
      assertUsableBackups([
        buildSnapshot(meta, [
          { messageId: 1, role: 'user', insertedAt: 1, fragments: [{ type: 'text', content: 'hi' }] },
        ]),
      ]),
    ).not.toThrow();
  });
});
