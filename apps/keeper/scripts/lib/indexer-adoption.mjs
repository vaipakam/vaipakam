/**
 * The indexer's ADOPTED Diamond per chain, defined once (#2569 r1).
 *
 * Two readers must agree on what "the indexer has adopted this Diamond"
 * means, and both read it from here:
 *   - the one-time copy (`scripts/keeper-cutover.mjs`), which seeds the
 *     keeper's own epoch record with the Diamond the copied rows belong to;
 *   - the keeper's epoch check on every tick (`src/keeperEpoch.ts`), which
 *     resets a chain's private rows only once the indexer has moved to the
 *     same Diamond.
 *
 * A row in `indexer_deployment` is an adoption only once its `reset_pending`
 * is ZERO. The indexer records a new Diamond FIRST, with the flag set, then
 * clears the retired Diamond's chain-scoped rows, and clears the flag LAST
 * (`apps/indexer/src/deploymentEpoch.ts`). In between, the shared rows the
 * keeper's passes join to still belong to the old Diamond, so a reader that
 * looked at `diamond` alone would take a half-adopted epoch for a settled one
 * and read the new Diamond's ids against the old one's rows.
 *
 * This module has no Node dependency, so the Worker bundle (`src/`) and the
 * scripts can both import it.
 */

/** Every chain's record, for the copy. */
export const INDEXER_DEPLOYMENTS_SQL = 'SELECT chain_id, diamond, reset_pending FROM indexer_deployment';
/** One chain's record, for the tick (one bind: the chain id). */
export const INDEXER_DEPLOYMENT_SQL = 'SELECT diamond, reset_pending FROM indexer_deployment WHERE chain_id = ?';

/**
 * The Diamond a record has adopted, lowercased — or `null` for no record, a
 * record whose reset is still pending, or a malformed one. Null is never
 * "adopt the configured Diamond": the callers decline on it.
 */
export function indexerAdopted(row) {
  if (row === null || row === undefined || typeof row !== 'object') return null;
  if (typeof row.diamond !== 'string' || row.diamond === '') return null;
  return Number(row.reset_pending) === 0 ? row.diamond.toLowerCase() : null;
}
