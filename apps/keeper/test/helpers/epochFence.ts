/**
 * The epoch fence (`src/epochFence.ts`) is armed by the tick, for the
 * process, and refuses every effect while unarmed. A test that drives a send,
 * an alert or a pass directly arms it here first, as the tick would: a fence
 * that HOLDS for `chains` (the indexer settled on each one's Diamond), or one
 * whose indexer has `moved` elsewhere.
 */
import { armEpochFenceWith, configuredDiamonds, type IndexerAdoptionRow } from '../../src/epochFence';
import type { ChainConfig } from '../../src/env';

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
