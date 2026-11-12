/**
 * RW-31 — one wallet's lifetime claimed rewards on one network, from the
 * index (the world rail, RB-RAILS): every reward claim the wallet was paid,
 * whichever destination it chose (RW-26), and the part the index recorded as
 * delivered into the wallet's vault. Both are on the claim-day basis: the
 * UTC day the VPFI left the protocol's custody, never the reward day it was
 * earned on.
 *
 * The index states its totals only against a moment it has recorded every
 * claim up to; until then (or while it is still replaying the chain's
 * history) it answers with no totals and says why, and this reader passes
 * that on. An unreadable index is a failure the caller states, never a zero.
 */
import type { IndexerClient } from '../reads/world/indexerClient';
import { IndexerUnavailable } from '../reads/world/indexerClient';
import { wireBig, wireWhole } from '../reads/world/wire';

type Hex = `0x${string}`;

export type ClaimedTotals =
  | {
      kind: 'recorded';
      /** Every claim paid to the wallet, in VPFI base units. */
      claimed: bigint;
      /** The part recorded as credited to the wallet's vault. */
      vaultDelivered: bigint;
      /** UTC days on which a claim paid something. */
      claimDays: number;
      /** The latest such day, `YYYY-MM-DD`; null when none. */
      lastClaimDay: string | null;
      /** Every claim before this moment is counted (ms since epoch). */
      recordedBefore: number;
    }
  /** The index has not recorded a full history for this network yet. */
  | { kind: 'pending'; why: 'unrecorded' | 'replaying' };

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Reads the index's answer, or throws a shape failure. */
export function claimedTotalsFrom(body: Record<string, unknown>, wallet: Hex): ClaimedTotals {
  if (String(body.wallet).toLowerCase() !== wallet.toLowerCase()) throw new IndexerUnavailable('shape', 'The index did not read this wallet’s claims.');
  if (body.pending === 'unrecorded' || body.pending === 'replaying') return { kind: 'pending', why: body.pending };
  const t = body.totals as Record<string, unknown> | null | undefined;
  const at = typeof body.recordedBefore === 'string' ? Date.parse(body.recordedBefore) : NaN;
  if (body.pending !== null || !t || typeof t !== 'object' || !Number.isFinite(at)) {
    throw new IndexerUnavailable('shape', 'The index answered without lifetime totals.');
  }
  try {
    const claimed = wireBig(t.claimed);
    const vaultDelivered = wireBig(t.vaultDelivered);
    const claimDays = wireWhole(t.claimDays);
    const last = t.lastClaimDay;
    if (last !== null && (typeof last !== 'string' || !DAY.test(last))) throw new Error('no day');
    // The vault part is part of what was claimed; a larger one is not a
    // figure this screen can stand behind.
    if (vaultDelivered > claimed) throw new Error('vault part above the total');
    if ((claimDays === 0) !== (last === null)) throw new Error('days disagree');
    return { kind: 'recorded', claimed, vaultDelivered, claimDays, lastClaimDay: last, recordedBefore: at };
  } catch (e) {
    throw new IndexerUnavailable('shape', `The index’s lifetime totals could not be read: ${(e as Error).message}.`);
  }
}

/** The wallet's lifetime claimed rewards on `chainId`. Throws the index's own
 *  failure, or a shape failure. */
export async function readClaimedTotals(indexer: IndexerClient, chainId: number, wallet: Hex): Promise<ClaimedTotals> {
  const q = new URLSearchParams({ chainId: String(chainId), wallet: wallet.toLowerCase() });
  const body = await indexer.getJson<Record<string, unknown>>(`/rewards/claimed?${q.toString()}`);
  return claimedTotalsFrom(body, wallet);
}
