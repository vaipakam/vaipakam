/**
 * #3624 — the wallet's Auto-lend instructions on this network, as the
 * protocol lists them (`LenderIntentFacet.getLenderIntentsByOwner`): every
 * pair the wallet ever set one on, stopped ones included, with the money
 * waiting to be lent, the money lent now and the limits. Read at one block,
 * with that block's time, so an end date is judged as of the read.
 */
import type { PublicClient } from 'viem';
import { readIntentGates, type IntentSummary } from '../offers/intents';
import { fillPosture, INTENT, type FillPosture } from './autoLend';

type Hex = `0x${string}`;

/** How many instructions one read lists. */
export const MY_AUTOLEND_LIMIT = 50;

export interface MyAutoLend {
  intent: IntentSummary;
  active: boolean;
}

export interface MyAutoLendRead {
  rows: MyAutoLend[];
  total: bigint;
  at: bigint;
  /** Whether the network fills Auto-lend now, from the same gates a fill
   *  passes, read at the same block: a switch turned off after setup stops
   *  every new loan without changing any instruction. */
  posture: FillPosture;
}

export async function readMyAutoLend(c: PublicClient, diamond: Hex, owner: Hex): Promise<MyAutoLendRead> {
  const block = await c.getBlock({ blockTag: 'latest' });
  const [[rows, total], gates] = await Promise.all([
    c.readContract({
      address: diamond,
      abi: INTENT,
      functionName: 'getLenderIntentsByOwner',
      args: [owner, 0n, BigInt(MY_AUTOLEND_LIMIT)],
      blockNumber: block.number,
    }) as Promise<readonly [readonly MyAutoLend[], bigint]>,
    readIntentGates(c, diamond, block.number),
  ]);
  return { rows: rows.map((r) => ({ intent: r.intent, active: r.active })), total, at: block.timestamp, posture: fillPosture(gates) };
}

/** Where one instruction stands: lending; ended (active, but its end date
 *  leaves no day-long loan, the same rule the protocol's feed applies); or
 *  stopped (cancelled). */
export type AutoLendState = 'active' | 'ended' | 'stopped';

const DAY = 86_400n;

export function autoLendState(r: MyAutoLend, at: bigint): AutoLendState {
  if (!r.active) return 'stopped';
  if (r.intent.lendUntil !== 0n && r.intent.lendUntil < at + DAY) return 'ended';
  return 'active';
}

/** Lending first, then ended, then stopped; within each, the most waiting
 *  money first. */
export function sortMyAutoLend(rows: readonly MyAutoLend[], at: bigint): MyAutoLend[] {
  const rank: Record<AutoLendState, number> = { active: 0, ended: 1, stopped: 2 };
  return [...rows].sort((a, b) => {
    const d = rank[autoLendState(a, at)] - rank[autoLendState(b, at)];
    if (d !== 0) return d;
    return a.intent.availableCapital === b.intent.availableCapital ? 0 : a.intent.availableCapital > b.intent.availableCapital ? -1 : 1;
  });
}

/**
 * #3664 — how much of the money behind the wallet's Auto-lend is lent, per
 * lending asset. Amounts in different assets are never added together: no
 * total is formed across assets without a price, so each asset stands alone.
 *
 * `lent` is the principal out on loans now; `waiting` is the money set aside
 * in the wallet's own vault that is not lent. Part of the waiting money can
 * sit behind a setting that will not lend it (stopped, or past its end date):
 * that part is `idle`, counted in `waiting` and named on its own, so the share
 * never reads as if the rest were all on offer.
 */
export interface ShareLent {
  lendingAsset: Hex;
  lent: bigint;
  waiting: bigint;
  /** The part of `waiting` behind a stopped or ended setting. */
  idle: bigint;
  /** Lent as basis points of lent plus waiting; null when both are zero. */
  shareBps: number | null;
  /** How many of the listed settings lend this asset. */
  settings: number;
}

export function shareLentByAsset(rows: readonly MyAutoLend[], at: bigint): ShareLent[] {
  const by = new Map<string, ShareLent>();
  for (const r of rows) {
    const i = r.intent;
    const k = i.lendingAsset.toLowerCase();
    const s = by.get(k) ?? { lendingAsset: i.lendingAsset, lent: 0n, waiting: 0n, idle: 0n, shareBps: null, settings: 0 };
    s.lent += i.livePrincipal;
    s.waiting += i.availableCapital;
    if (autoLendState(r, at) !== 'active') s.idle += i.availableCapital;
    s.settings += 1;
    by.set(k, s);
  }
  const out = [...by.values()].map((s) => {
    const all = s.lent + s.waiting;
    // Rounded down, so a share is never shown higher than it is.
    return { ...s, shareBps: all === 0n ? null : Number((s.lent * 10_000n) / all) };
  });
  // Amounts in different assets do not compare, so the order is the list's own.
  return out.filter((s) => s.lent + s.waiting > 0n);
}
