import { describe, expect, it } from 'vitest';

import { snapshotFileName, validateSnapshot } from '../src/core/snapshot';

describe('snapshot files', () => {
  it('does not collide when two session ids share the same prefix', () => {
    const base = { title: 'Same title', pinned: false, updatedAt: 1_700_000_000 };
    expect(snapshotFileName({ ...base, id: 'abcdefgh-1' })).not.toBe(
      snapshotFileName({ ...base, id: 'abcdefgh-2' }),
    );
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
});
