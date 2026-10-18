/**
 * The epoch fence (`src/epochFence.ts`) is armed by the tick, for the
 * process, and refuses every effect while unarmed. A test that drives a send,
 * an alert or a pass directly arms it here first, as the tick would: a fence
 * that HOLDS for `chains` (the indexer settled on each one's Diamond), or one
 * whose indexer has `moved` elsewhere.
 */
import { armEpochFenceWith, configuredDiamonds, type IndexerAdoptionRow } from '../../src/epochFence';
import type { ChainConfig } from '../../src/env';
import type { SqliteD1 } from './sqliteD1';

/** Arm a fence that holds: the indexer has settled on every chain's Diamond. */
export function armHeldFence(chains: readonly Pick<ChainConfig, 'id' | 'diamond'>[] = []): void {
  const want = configuredDiamonds(chains as readonly ChainConfig[]);
  const rows: IndexerAdoptionRow[] = [...want].map(([chain_id, diamond]) => ({ chain_id, diamond, reset_pending: 0 }));
  armEpochFenceWith(async () => rows, want);
}

/** Arm a fence whose indexer reads `rows` now, for `chains` — the moved case. */
export function armFenceReading(rows: readonly IndexerAdoptionRow[], chains: readonly Pick<ChainConfig, 'id' | 'diamond'>[]): void {
  armEpochFenceWith(async () => rows, configuredDiamonds(chains as readonly ChainConfig[]));
}

/**
 * The indexer has settled on `diamond` for `chainId` in the SHARED test
 * database (the row a guarded write's own EXISTS reads), and the fence is
 * armed to hold for it. What a tick establishes, for a test that writes.
 */
export function settleIndexer(shared: SqliteD1, chainId: number, diamond: string, resetPending = 0): void {
  shared.db
    .prepare(
      `INSERT INTO indexer_deployment (chain_id, diamond, deploy_block, adopted_at, reset_pending) VALUES (?, ?, 1, 1, ?)
       ON CONFLICT (chain_id) DO UPDATE SET diamond = excluded.diamond, reset_pending = excluded.reset_pending`,
    )
    .run(chainId, diamond, resetPending);
  armHeldFence([{ id: chainId, diamond }]);
}
