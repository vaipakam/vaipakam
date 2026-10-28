/**
 * apps/keeper — one bounded window of a chain's active-loan list, read at
 * one pinned block. Shared by the passes that walk the active list a window
 * per visit (the grace-default pass, the periodic-interest settler).
 *
 * Pinned because swap-and-pop on the active list can skip a loan
 * mid-pagination when a scan spans blocks — the liquidator's reason for
 * pinning, and the same here. Bounded because the run's subrequest
 * allowance is shared: a window costs at most `1 + 1 + ⌈SCAN_WINDOW ÷
 * SCAN_PAGE⌉` requests however large the book, and a larger book is walked
 * a window per visit.
 */

import type { Abi, Address, PublicClient } from 'viem';
import { MetricsFacetABI } from '@vaipakam/contracts/abis';
import { deadlineClient } from './batchRead';
import { boundedCall } from './passReader';
import { priorStageCutoffMs } from './runWindow';

const METRICS_ABI: Abi = MetricsFacetABI as Abi;

/** Pagination size for `getActiveLoansPaginated`. */
const SCAN_PAGE = 200n;

/** Active-list ids one run scans: two pages, so a window costs at most four
 *  requests (block, count, pages) before the pass's own per-loan reads. */
export const SCAN_WINDOW = 400;

/** Where a scan looked: window `index` of `count` over `total` active loans,
 *  on this window's `round`-th visit. */
export interface ScanWindow {
  index: number;
  count: number;
  total: number;
  /** How many times this window has been visited before: `visit ÷ count`.
   *  A pass rotating the window's candidates across visits rotates by this,
   *  never by the global visit. With `count` windows, the global visit steps
   *  by `count` between two visits to one window, so rotating by it advances
   *  a batch `count` steps at a time and can skip candidates for good. */
  round: number;
}

/** When a run's window scan stops: the per-loan reads a stage reserve before
 *  the read cutoff that bounds the pass's later reads, the window itself a
 *  stage reserve before those (`runWindow.ts` rule 3). */
export interface ScanCutoffs {
  window: number;
  reads: number;
}

/** The scan's cutoffs for a pass whose next stage reads until `nextStage`. */
export function scanCutoffs(nextStage: number): ScanCutoffs {
  const reads = priorStageCutoffMs(nextStage);
  return { window: priorStageCutoffMs(reads), reads };
}

/** The ids of window `visit mod count`, the block they were read at, and
 *  where the window sits. Successive visits walk the list and wrap. Every
 *  request stops at `cutoff`: one not started by then is refused and one
 *  still in flight is abandoned, so the window is read whole or the call
 *  throws `PastRunDeadline` (`runWindow.ts` rule 3). */
export function readActiveWindow(
  client: PublicClient,
  diamond: Address,
  visit: number,
  cutoff: number,
): Promise<{ ids: bigint[]; blockNumber: bigint; window: ScanWindow }> {
  return boundedCall(cutoff, 'the active-loan window', () => readWindow(deadlineClient(client, cutoff), diamond, visit));
}

async function readWindow(
  client: PublicClient,
  diamond: Address,
  visit: number,
): Promise<{ ids: bigint[]; blockNumber: bigint; window: ScanWindow }> {
  const blockNumber = await client.getBlockNumber({ cacheTime: 0 });
  const total = (await client.readContract({
    address: diamond,
    abi: METRICS_ABI,
    functionName: 'getActiveLoansCount',
    blockNumber,
  })) as bigint;
  const count = Math.max(1, Math.ceil(Number(total) / SCAN_WINDOW));
  const index = visit % count;
  const window: ScanWindow = { index, count, total: Number(total), round: Math.floor(visit / count) };
  const from = BigInt(index * SCAN_WINDOW);
  const to = from + BigInt(SCAN_WINDOW) < total ? from + BigInt(SCAN_WINDOW) : total;

  const ids: bigint[] = [];
  for (let cursor = from; cursor < to; cursor += SCAN_PAGE) {
    const limit = cursor + SCAN_PAGE > to ? to - cursor : SCAN_PAGE;
    // eslint-disable-next-line no-await-in-loop
    const page = (await client.readContract({
      address: diamond,
      abi: METRICS_ABI,
      functionName: 'getActiveLoansPaginated',
      args: [cursor, limit],
      blockNumber,
    })) as bigint[];
    ids.push(...page);
  }
  return { ids, blockNumber, window };
}
