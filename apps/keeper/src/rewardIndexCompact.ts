// apps/keeper/src/rewardIndexCompact.ts
//
// #3097 — the REWARD-ENTRY INDEX COMPACTION, step 6 of `protocolUpkeep`: the
// keeper's call of `InteractionRewardsFacet.compactRewardEntryIndex(user,
// maxSteps)`.
//
// Each wallet's reward-entry index is meant to hold its UNSETTLED entries, so
// every per-user walk (the claim's legs, its funding need, the Claim Center
// countdown) costs what the wallet has live rather than its lifetime. A
// settled entry is retired from the index lazily: by the wallet's own claim,
// which examines at most 256 positions, and by the permissionless compactor.
// An entry settled by anything other than that claim (an expiry sweep, a
// forfeit settlement, a zero-priced retirement) stays in the index until one
// of the two runs. The compactor moves no value and only ever removes entries
// that are settled.
//
// Per chain, per run:
//
//   1. PARTIES — the next slice of the chain's loan parties from the shared
//      indexer's record (`db.ts` `listLoanPartiesAfter`: every lender and
//      borrower, original or current, and every holder a position ever had),
//      from a stored address that moves on each run and wraps at the end.
//      Every reward entry belongs to one of them: entries are opened for a
//      loan's sides and moved only to a position's holders.
//   2. LENGTH — each party's index length (`getUserRewardEntryIdsPage(user,
//      0, 0)`'s total). A party with an empty index is passed.
//   3. PREVIEW — `compactRewardEntryIndex(user, steps)` called on the current
//      state without sending (an `eth_call`, batched), where `steps` is the
//      index length capped at {@link COMPACT_MAX_STEPS}. Its own return value
//      says how many entries it would retire, so a party is due exactly when
//      that is above zero.
//   4. COMPACT — the call for each due party, simulated again by the sender
//      and sent only while the simulation still retires something. The run's
//      line names each party compacted, from its `RewardEntryIndexCompacted`
//      event.
//
// The contract's walk always starts at position 0. A party whose index is
// longer than one call examines and whose first {@link COMPACT_MAX_STEPS}
// positions hold no settled entry cannot be compacted by any bounded call;
// the line names it rather than reporting it clean.
//
// The stored address moves past every party whose reads came back and that
// was not left due: one due and not sent (the run's send budget or deadline)
// is read again next run.
//
// Gated by KEEPER_ENABLED + PROTOCOL_UPKEEP_ENABLED +
// REWARD_INDEX_COMPACT_ENABLED. Ships disarmed.

import { decodeEventLog, type Abi, type Address, type Hex, type PublicClient } from 'viem';
import { InteractionRewardsFacetABI, InteractionRewardsLensFacetABI } from '@vaipakam/contracts/abis';
import { settledChunkedRead } from './batchRead';
import { boundedCall } from './passReader';
import { shortErr } from './callErrors';
import { priorStageCutoffMs, readCutoffMs } from './runWindow';
import { nextScreenCursor } from './rewardSanctionsHold';
import type { ScanCursors } from './scanCursors';
import type { StepSender } from './stepSender';

export const REWARD_INDEX_ABI = [...(InteractionRewardsFacetABI as Abi), ...(InteractionRewardsLensFacetABI as Abi)] as Abi;

/** Loan parties one run reads. */
export const REWARD_INDEX_PAGE = 100;
/** Index positions one compaction examines at most. The contract's walk
 *  reads two storage words a position and rewrites the index for each entry
 *  it retires, so this bounds the call's gas. */
export const COMPACT_MAX_STEPS = 1000;
/** The stored address the next slice of parties starts after. */
export const REWARD_INDEX_AFTER_ITEM = 'reward-index-after';
const COMPACTED_EVENT = 'RewardEntryIndexCompacted';
/** Reads per aggregate; a preview walks the index, so fewer go together. */
const LENGTH_CHUNK = 100;
const PREVIEW_CHUNK = 25;

/** What the step reads and signs with. */
export interface RewardIndexDeps {
  /** Plain client; every read here carries its own cutoff. */
  readClient: PublicClient;
  sendDeadline: number;
  /** Where the batched reads start this run. */
  visit: number;
  cursors: ScanCursors;
  /** The chain's loan parties after `after` in address order, lowercased, at
   *  most `limit` (`db.ts` `listLoanPartiesAfter`). */
  parties: (after: string, limit: number) => Promise<string[]>;
}

/** What the step did on one chain. */
export interface RewardIndexReport {
  /** Why it did nothing this run, when it did nothing. */
  off: string | null;
  /** Parties read, and those with a non-empty index. */
  parties: number;
  indexed: number;
  /** Parties whose index the preview would shorten: `0x…: 3 of 40`. */
  due: string[];
  /** Compactions that landed, from their event: `0x…: 3 retired, 37 left`. */
  compacted: string[];
  /** Parties whose index is longer than one call examines and whose examined
   *  positions hold no settled entry: not known to be clean. */
  outOfReach: string[];
  /** Parties whose length or preview read did not come back. */
  unread: number;
  /** Compactions that landed whose event was not read. */
  landedUnread: string[];
}

export function emptyRewardIndexReport(): RewardIndexReport {
  return { off: null, parties: 0, indexed: 0, due: [], compacted: [], outOfReach: [], unread: 0, landedUnread: [] };
}

/** The step's figures for the run's line. */
export function describeRewardIndex(r: RewardIndexReport | null): string[] {
  if (r === null) return ['reward-index-compact=off (REWARD_INDEX_COMPACT_ENABLED not armed)'];
  if (r.off !== null) return [`reward-index-compact=not worked (${r.off})`];
  return [
    `reward-index-parties=${r.parties} read, ${r.indexed} with entries`,
    `reward-index-due=${r.due.join('; ') || 'none'}`,
    ...(r.compacted.length > 0 ? [`reward-index-compacted=${r.compacted.join('; ')}`] : []),
    ...(r.outOfReach.length > 0 ? [`reward-index-out-of-reach=${r.outOfReach.join(',')} (longer than ${COMPACT_MAX_STEPS} positions with none settled in them; any settled entry further down is beyond one call)`] : []),
    ...(r.unread > 0 ? [`reward-index-unread=${r.unread} parties`] : []),
    ...(r.landedUnread.length > 0 ? [`reward-index-event-unread=${r.landedUnread.join(',')}`] : []),
  ];
}

/** What a compaction retired, from its `RewardEntryIndexCompacted` event for
 *  `user`; null when the receipt carries none. Exported for tests. */
export function compactedEvent(
  diamond: Address,
  user: Address,
  logs: readonly { address: Address; data: Hex; topics: readonly Hex[] }[],
): { retired: bigint; remaining: bigint } | null {
  for (const log of logs) {
    if (log.address.toLowerCase() !== diamond.toLowerCase()) continue;
    let ev;
    try {
      ev = decodeEventLog({ abi: REWARD_INDEX_ABI, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
    } catch {
      continue;
    }
    const a = ev.args as unknown as Record<string, unknown>;
    if (ev.eventName === COMPACTED_EVENT && String(a.user).toLowerCase() === user.toLowerCase()) {
      return { retired: BigInt(a.retired as bigint), remaining: BigInt(a.remaining as bigint) };
    }
  }
  return null;
}

const ADDRESS = /^0x[0-9a-f]{40}$/;
const retiredOf = (simulated: unknown): bigint | null => {
  if (!Array.isArray(simulated) || simulated.length < 2) return null;
  try {
    return BigInt(simulated[0] as bigint);
  } catch {
    return null;
  }
};

/** One chain's step. It never throws for running out of time: a stage that
 *  reaches its cutoff is reported, and the stored address stays at the first
 *  party not finished. */
export async function compactRewardIndexes(diamond: Address, sender: StepSender, deps: RewardIndexDeps): Promise<RewardIndexReport> {
  const out = emptyRewardIndexReport();
  // The previews by the read cutoff, which reserves the sends' time; the
  // lengths a stage reserve before that; the parties a stage reserve before
  // those (runWindow.ts rule 3).
  const previewCutoff = readCutoffMs(deps.sendDeadline);
  const lengthCutoff = priorStageCutoffMs(previewCutoff);
  const partyCutoff = priorStageCutoffMs(lengthCutoff);

  // 1. The parties.
  let after: string;
  let page: string[];
  try {
    const stored = await boundedCall(partyCutoff, 'the reward-index position', () => deps.cursors.get([REWARD_INDEX_AFTER_ITEM]));
    after = stored.get(REWARD_INDEX_AFTER_ITEM) ?? '';
    // One row past the slice, so the end of the cycle is known on its last page.
    page = (await boundedCall(partyCutoff, 'the loan parties', () => deps.parties(after, REWARD_INDEX_PAGE + 1))).map((a) => a.toLowerCase());
  } catch (err) {
    sender.noteUnread('reward-index', `the loan parties (${shortErr(err)})`);
    out.off = 'the loan parties were not read';
    return out;
  }
  const terminal = page.length <= REWARD_INDEX_PAGE;
  const slice = page.slice(0, REWARD_INDEX_PAGE);
  out.parties = slice.length;
  const users = slice.filter((a) => ADDRESS.test(a)) as Address[];

  // 2. Each party's index length.
  const lengths = await settledChunkedRead(
    deps.readClient,
    users,
    LENGTH_CHUNK,
    (u) => ({ address: diamond, abi: REWARD_INDEX_ABI, functionName: 'getUserRewardEntryIdsPage', args: [u, 0n, 0n] }),
    'protocolUpkeep reward-index lengths',
    lengthCutoff,
    deps.visit,
  );
  const total = new Map<string, bigint>();
  for (const u of users) {
    const x = lengths.get(u);
    if (x?.status === 'success' && Array.isArray(x.result)) total.set(u, BigInt((x.result as readonly unknown[])[1] as bigint));
  }
  const indexed = users.filter((u) => (total.get(u) ?? 0n) > 0n);
  out.indexed = indexed.length;
  const steps = (u: Address) => {
    const n = total.get(u) ?? 0n;
    return n < BigInt(COMPACT_MAX_STEPS) ? n : BigInt(COMPACT_MAX_STEPS);
  };

  // 3. The previews: the call itself, on the current state, not sent.
  const previews = await settledChunkedRead(
    deps.readClient,
    indexed,
    PREVIEW_CHUNK,
    (u) => ({ address: diamond, abi: REWARD_INDEX_ABI, functionName: 'compactRewardEntryIndex', args: [u, steps(u)] }),
    'protocolUpkeep reward-index previews',
    previewCutoff,
    deps.visit,
  );
  const due = new Set<string>();
  const read = new Set<string>();
  for (const u of users) {
    if (!total.has(u)) continue;
    if ((total.get(u) ?? 0n) === 0n) {
      read.add(u);
      continue;
    }
    const x = previews.get(u);
    const retired = x?.status === 'success' ? retiredOf(x.result) : null;
    if (retired === null) continue;
    read.add(u);
    if (retired > 0n) {
      due.add(u);
      out.due.push(`${u}: ${retired} of ${total.get(u)}`);
    } else if ((total.get(u) ?? 0n) > BigInt(COMPACT_MAX_STEPS)) {
      out.outOfReach.push(u);
    }
  }
  out.unread = users.length - read.size;
  if (out.unread > 0) sender.noteUnread('reward-index', `the index length or compaction preview of ${out.unread} loan part${out.unread === 1 ? 'y' : 'ies'}`);

  // 4. Compact each due party, while its simulation still retires something.
  const landed = new Set<string>();
  for (const u of users) {
    if (!due.has(u)) continue;
    if (sender.stopped) break;
    // eslint-disable-next-line no-await-in-loop
    const res = await sender.call('reward-index', u, 'compactRewardEntryIndex', [u, steps(u)], 0n, (sim) => (retiredOf(sim) ?? 0n) > 0n);
    if (res === 'idle') {
      landed.add(u); // another caller (or the wallet's claim) got there first
      continue;
    }
    if (res !== 'landed') continue;
    landed.add(u);
    const ev = sender.receipt === null ? null : compactedEvent(diamond, u, sender.receipt.logs as never);
    if (ev === null) out.landedUnread.push(u);
    else out.compacted.push(`${u}: ${ev.retired} retired, ${ev.remaining} left`);
  }

  // The stored address waits at the first party not finished: unread, or due
  // and not compacted this run. Written by the send deadline: it follows the
  // sends. Unwritten, the next run reads the same slice again.
  const finished = slice.map((a) => !ADDRESS.test(a) || (read.has(a) && (!due.has(a) || landed.has(a))));
  const next = nextScreenCursor(after, slice, finished, terminal);
  await boundedCall(deps.sendDeadline, 'the reward-index position', () => deps.cursors.put(REWARD_INDEX_AFTER_ITEM, next)).catch(() => undefined);
  return out;
}
