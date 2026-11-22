import { describe, expect, it } from 'vitest';
import { buildIndex, guardLink } from '../src/core/guard';
import type { SessionMeta } from '../src/core/types';

const sessions: SessionMeta[] = [
  { id: 'a'.repeat(36), title: '开会记录', pinned: false, updatedAt: 100 },
  { id: 'b'.repeat(36), title: '置顶的文档', pinned: true, updatedAt: 200 },
];

const index = buildIndex(sessions);

describe('guardLink', () => {
  it('passes an existing, unpinned session', () => {
    const outcome = guardLink({ raw: 'x', kind: 'session', id: 'a'.repeat(36) }, index, { protectPinned: true });
    expect(outcome.ok).toBe(true);
    expect(outcome.meta?.title).toBe('开会记录');
  });

  it('rejects an unknown id instead of blind-firing a delete', () => {
    const outcome = guardLink({ raw: 'x', kind: 'session', id: 'c'.repeat(36) }, index, { protectPinned: true });
    expect(outcome.ok).toBe(false);
    expect(outcome.code).toBe('NOT_FOUND');
  });

  it('protects pinned sessions by default', () => {
    const outcome = guardLink({ raw: 'x', kind: 'session', id: 'b'.repeat(36) }, index, { protectPinned: true });
    expect(outcome.ok).toBe(false);
    expect(outcome.code).toBe('PINNED_PROTECTED');
  });

  it('allows pinned sessions when protection is off', () => {
    const outcome = guardLink({ raw: 'x', kind: 'session', id: 'b'.repeat(36) }, index, { protectPinned: false });
    expect(outcome.ok).toBe(true);
  });

  it('rejects share links', () => {
    const outcome = guardLink({ raw: 'x', kind: 'share', reason: '分享页只读' }, index, { protectPinned: true });
    expect(outcome.ok).toBe(false);
    expect(outcome.code).toBe('NOT_OWNED');
  });
});
