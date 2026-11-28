/**
 * Shared batch ceiling: one command or one click must never be able to delete an
 * unbounded number of sessions. The CLI and the userscript both enforce it.
 */
export const HARD_BATCH_LIMIT = 50;

export function exceedsBatchLimit(count: number): boolean {
  return count > HARD_BATCH_LIMIT;
}
