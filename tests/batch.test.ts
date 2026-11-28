import { describe, expect, it } from 'vitest';

import { HARD_BATCH_LIMIT, exceedsBatchLimit } from '../src/core/batch';

describe('single-run batch ceiling', () => {
  it('caps one run at 50 sessions', () => {
    expect(HARD_BATCH_LIMIT).toBe(50);
    expect(exceedsBatchLimit(HARD_BATCH_LIMIT)).toBe(false);
    expect(exceedsBatchLimit(HARD_BATCH_LIMIT + 1)).toBe(true);
  });
});
