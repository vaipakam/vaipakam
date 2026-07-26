// apps/keeper/src/commitmentReport.ts
//
// #1222 M3 B2-d1 — mirror→Base commitment-report automation.
//
// On an ARMED day `D`, each mirror must report its per-side day-`D`
// claimable-liability aggregate to Base (`RewardCommitmentFacet`): Base's
// ShareOfPool remittance for `(D, chain)` WAITS for that report (the B2-d2
// remit gate — a late report delays, never zeroes). The report is only
// computable AFTER Base finalizes + broadcasts day `D` (the caps + funding
// stamp it prices from are finalize outputs — design doc §2b), so this pass
// runs on the MIRROR side and per day does, in order:
//
//   1. wait for the day's funding stamp AND the mirror's own interest close
//      (`chainReportSentAt`) — the on-chain send gate requires both;
//   2. walk the GLOBAL reward-entry id sequence from the on-chain
//      per-(day, side) cursor (`getRewardEntriesRange`), filter the entries
//      that cover the day on that side, and feed them to
//      `submitCommitmentBatch` in ascending id order. The unit is the ENTRY
//      (transfer-invariant — Codex #1425 r1), so no user discovery, no
//      indexer dependency: the chain's own sequential entry ids are the
//      complete enumeration, and ids are creation-ordered so the walk stops
//      at the first entry with `startDay > D`;
//   3. once demand conservation completes (`isDayCommitmentReady`), quote via
//      `quoteCommitmentReportFee` and dispatch `sendCommitmentReport`.
//
// Discovery is cursor-free across ticks: a resolved day (complete + sent)
// reads as "conservation == totals && !ready" and is skipped; the on-chain
// entry cursor makes double-submission impossible, so a crashed tick resumes
// safely. Days older than the lookback window are NOT abandoned (Codex #1425
// r1): the pass walks backward from the window's floor while days remain
// unresolved (bounded), so an outage longer than the lookback still heals.
//
// Gated twice: the global `KEEPER_ENABLED` AND an explicit
// `REWARD_COMMIT_ENABLED`, because `submitCommitmentBatch` is
// KEEPER_ROLE-gated on-chain (anti-grief) and arming the pass before the
// keeper EOA holds the role would just burn reverts every tick.

import { createPublicClient, http, type Abi, type Address, type PublicClient } from 'viem';
import {
  RewardCommitmentFacetABI,
  RewardReporterFacetABI,
  RewardAggregatorFacetABI,
  InteractionRewardsLensFacetABI,
} from '@vaipakam/contracts/abis';
import type { ChainConfig, Env } from './env';
import { getChainConfigs } from './env';
import { buildKeeperContext, isKeeperEnabled, type KeeperContext } from './keeper';

const COMMIT_ABI = RewardCommitmentFacetABI as Abi;
const REPORTER_ABI = RewardReporterFacetABI as Abi;
const AGGREGATOR_ABI = RewardAggregatorFacetABI as Abi;
const LENS_ABI = InteractionRewardsLensFacetABI as Abi;

/** How many recent days to re-scan for un-reported commitments each tick. */
const DEFAULT_LOOKBACK_DAYS = 14;
/** How far past the lookback floor the unresolved-day walk may extend. */
const MAX_BACKSCAN_DAYS = 90;
/** Entry ids per submitCommitmentBatch tx (bounded calldata / gas). */
const MAX_IDS_PER_BATCH = 200;
/** Batch txs per invocation across all days (bounded invocation work). */
const MAX_BATCHES_PER_TICK = 8;
/** Entry-range page size (the lens view clamps at 500 anyway). */
const PAGE_SIZE = 500n;
/**
 * Entry-range pages read per invocation across all days. A truncated walk is
 * safe (ascending order + the on-chain cursor resume), but log it — silent
 * caps read as full coverage.
 */
const MAX_PAGES_PER_TICK = 20;

const ZERO_ADDR = '0x0000000000000000000000000000000000000000' as Address;

type RewardEntryView = {
  user: Address;
  loanId: bigint;
  startDay: number;
  endDay: number;
  side: number;
  processed: boolean;
  forfeited: boolean;
  closed: boolean;
  perDayNumeraire18: bigint;
};

function flagOn(env: Env, key: string): boolean {
  const v = (env as unknown as Record<string, string | undefined>)[key];
  return v === 'true' || v === '1';
}

function readNumber(env: Env, key: string, fallback: number): number {
  const raw = (env as unknown as Record<string, string | undefined>)[key];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export async function runCommitmentReport(env: Env): Promise<void> {
  if (!isKeeperEnabled(env)) return;
  if (!flagOn(env, 'REWARD_COMMIT_ENABLED')) return;

  for (const chain of getChainConfigs(env)) {
    try {
      await reportFromMirror(env, chain);
    } catch (err) {
      console.error(`[keeper] commitmentReport chain=${chain.id} failed:`, err);
    }
  }
}

/** Shared per-invocation work budgets (batch txs + range-page reads). */
type TickBudget = { batches: number; pages: number };

async function reportFromMirror(env: Env, chain: ChainConfig): Promise<void> {
  const publicClient = createPublicClient({ transport: http(chain.rpc) });
  const diamond = chain.diamond as Address;

  // Mirror-only: the canonical chain never sends a commitment report, and a
  // single-chain deploy (baseChainId 0) has no mesh at all.
  const cfg = (await publicClient.readContract({
    address: diamond,
    abi: REPORTER_ABI,
    functionName: 'getRewardReporterConfig',
  })) as readonly [Address, number, number, boolean, bigint];
  const localChainId = Number(cfg[1]);
  const baseChainId = Number(cfg[2]);
  const isCanonical = cfg[3];
  if (isCanonical || baseChainId === 0) return;

  const [currentDay, active] = (await publicClient.readContract({
    address: diamond,
    abi: LENS_ABI,
    functionName: 'getInteractionCurrentDay',
  })) as readonly [bigint, boolean];
  if (!active || currentDay <= 1n) return;

  // Unarmed program: no gate on Base, nothing to report (the on-chain send
  // guard agrees). `governorCommitArmedFromDay` reaches mirrors via the V2
  // broadcast, so this read is local.
  const commitState = (await publicClient.readContract({
    address: diamond,
    abi: AGGREGATOR_ABI,
    functionName: 'getGovernorCommitState',
  })) as readonly [bigint, bigint, bigint, bigint];
  const armedFromDay = commitState[0];
  if (armedFromDay === 0n) return;

  const ctx = buildKeeperContext(env, chain, publicClient);
  if (!ctx || !ctx.wallet.account) return;

  const lookback = readNumber(env, 'REWARD_COMMIT_LOOKBACK_DAYS', DEFAULT_LOOKBACK_DAYS);
  let from = currentDay > BigInt(lookback) ? currentDay - BigInt(lookback) : 1n;
  if (from < armedFromDay) from = armedFromDay;

  // Codex #1425 r1 — an outage longer than the lookback must not orphan a
  // day Base's remit gate is waiting for: extend the window backward while
  // days remain unresolved (bounded), stopping at the first resolved day.
  let extended = 0;
  while (
    from > armedFromDay &&
    extended < MAX_BACKSCAN_DAYS &&
    !(await isDayResolved(publicClient, diamond, localChainId, from - 1n))
  ) {
    from -= 1n;
    extended++;
  }
  if (extended >= MAX_BACKSCAN_DAYS) {
    console.warn(
      `[keeper] commitmentReport chain=${chain.id} backscan hit ${MAX_BACKSCAN_DAYS}-day cap at day=${from} — older unresolved days need operator attention`,
    );
  }

  const budget: TickBudget = { batches: MAX_BATCHES_PER_TICK, pages: MAX_PAGES_PER_TICK };

  for (let d = from; d < currentDay && budget.batches > 0; d++) {
    try {
      const ready = (await publicClient.readContract({
        address: diamond,
        abi: COMMIT_ABI,
        functionName: 'isDayCommitmentReady',
        args: [d],
      })) as boolean;
      if (ready) {
        await sendReport(publicClient, ctx, diamond, d);
        continue;
      }

      // On-chain preconditions for both the batch path (Δ pricing) and the
      // send (final totals): the day's funding stamp AND the local close.
      const funding = (await publicClient.readContract({
        address: diamond,
        abi: AGGREGATOR_ABI,
        functionName: 'getChainDayRecycledFunding',
        args: [d, localChainId],
      })) as { stamped: boolean };
      if (!funding.stamped) continue;
      const closedAt = (await publicClient.readContract({
        address: diamond,
        abi: REPORTER_ABI,
        functionName: 'getChainReportSentAt',
        args: [d],
      })) as bigint;
      if (closedAt === 0n) continue;

      const [, , totalLender, totalBorrower] = (await publicClient.readContract({
        address: diamond,
        abi: LENS_ABI,
        functionName: 'getInteractionDayEntry',
        args: [d, ZERO_ADDR],
      })) as readonly [bigint, bigint, bigint, bigint];

      for (const side of [0, 1] as const) {
        if (budget.batches <= 0 || budget.pages <= 0) break;
        const total = side === 0 ? totalLender : totalBorrower;
        const [cursor, , conservation] = (await publicClient.readContract({
          address: diamond,
          abi: COMMIT_ABI,
          functionName: 'getCommitmentAccumulation',
          args: [d, side],
        })) as readonly [bigint, bigint, bigint];
        // Complete (also true for already-sent days) — nothing to submit.
        if (conservation === total) continue;
        if (conservation > total) {
          // Should be unreachable (figures are mirror-recomputed); an
          // id-skipping mis-submission wedge is operator territory
          // (resetCommitmentAccumulation).
          console.warn(
            `[keeper] commitmentReport chain=${chain.id} day=${d} side=${side} conservation ${conservation} > total ${total} — needs operator resetCommitmentAccumulation`,
          );
          continue;
        }
        await submitSide(publicClient, ctx, diamond, chain.id, d, side, cursor, budget);
      }

      const readyNow = (await publicClient.readContract({
        address: diamond,
        abi: COMMIT_ABI,
        functionName: 'isDayCommitmentReady',
        args: [d],
      })) as boolean;
      if (readyNow) await sendReport(publicClient, ctx, diamond, d);
    } catch (err) {
      // Benign races (a competing tick advanced the cursor, the stamp landing
      // mid-scan, etc.) — log and let the next tick re-evaluate.
      console.log(
        `[keeper] commitmentReport chain=${chain.id} day=${d} skipped: ${(err as Error).message}`,
      );
    }
  }
}

/**
 * A day is RESOLVED when its report is out: stamped + locally closed +
 * conservation equal to the totals on both sides + not ready (ready would
 * mean complete-but-unsent). Unstamped / not-yet-closed days count as
 * unresolved so the backscan keeps retrying them once upstream events land.
 */
async function isDayResolved(
  publicClient: PublicClient,
  diamond: Address,
  localChainId: number,
  d: bigint,
): Promise<boolean> {
  const funding = (await publicClient.readContract({
    address: diamond,
    abi: AGGREGATOR_ABI,
    functionName: 'getChainDayRecycledFunding',
    args: [d, localChainId],
  })) as { stamped: boolean };
  if (!funding.stamped) return false;
  const closedAt = (await publicClient.readContract({
    address: diamond,
    abi: REPORTER_ABI,
    functionName: 'getChainReportSentAt',
    args: [d],
  })) as bigint;
  if (closedAt === 0n) return false;
  const [, , totalLender, totalBorrower] = (await publicClient.readContract({
    address: diamond,
    abi: LENS_ABI,
    functionName: 'getInteractionDayEntry',
    args: [d, ZERO_ADDR],
  })) as readonly [bigint, bigint, bigint, bigint];
  for (const side of [0, 1] as const) {
    const [, , conservation] = (await publicClient.readContract({
      address: diamond,
      abi: COMMIT_ABI,
      functionName: 'getCommitmentAccumulation',
      args: [d, side],
    })) as readonly [bigint, bigint, bigint];
    if (conservation !== (side === 0 ? totalLender : totalBorrower)) return false;
  }
  const ready = (await publicClient.readContract({
    address: diamond,
    abi: COMMIT_ABI,
    functionName: 'isDayCommitmentReady',
    args: [d],
  })) as boolean;
  return !ready; // complete AND sent
}

/**
 * Walk the global entry-id sequence from `cursor + 1`, submitting ascending
 * batches of the entries that cover `(day, side)`. Ids are creation-ordered
 * and `startDay` is stamped from the registration day, so the walk stops at
 * the first entry with `startDay > day` (nothing later can cover the day).
 * Gap entries that do not cover are re-read on later ticks until the day
 * resolves — a bounded, transient cost (the day's id range is fixed).
 */
async function submitSide(
  publicClient: PublicClient,
  ctx: KeeperContext,
  diamond: Address,
  chainId: number,
  day: bigint,
  side: 0 | 1,
  cursor: bigint,
  budget: TickBudget,
): Promise<void> {
  let pending: bigint[] = [];
  let nextId = cursor + 1n;
  let frontierReached = false;

  const flush = async (): Promise<boolean> => {
    if (pending.length === 0) return true;
    const batch = pending.slice(0, MAX_IDS_PER_BATCH);
    pending = pending.slice(MAX_IDS_PER_BATCH);
    const hash = await ctx.wallet.writeContract({
      address: diamond,
      abi: COMMIT_ABI,
      functionName: 'submitCommitmentBatch',
      args: [day, side, batch],
      chain: undefined,
      account: ctx.wallet.account ?? null,
    } as never);
    // Sequential batches share the ascending cursor — each must mine before
    // the next is even valid. Bounded wait, matching the remit pass.
    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 30_000 });
    budget.batches--;
    if (receipt.status !== 'success') {
      console.warn(
        `[keeper] commitmentReport chain=${chainId} day=${day} side=${side} batch tx=${hash} REVERTED — next tick resumes from the on-chain cursor`,
      );
      return false;
    }
    console.log(
      `[keeper] commitmentReport chain=${chainId} day=${day} side=${side} submitted ${batch.length} entries tx=${hash}`,
    );
    return true;
  };

  while (!frontierReached && budget.pages > 0) {
    budget.pages--;
    const page = (await publicClient.readContract({
      address: diamond,
      abi: LENS_ABI,
      functionName: 'getRewardEntriesRange',
      args: [nextId, PAGE_SIZE],
    })) as readonly RewardEntryView[];

    for (let i = 0; i < page.length; i++) {
      const e = page[i];
      const id = nextId + BigInt(i);
      // Zeroed struct ⇒ past the end of the allocated sequence.
      if (e.user === ZERO_ADDR && e.perDayNumeraire18 === 0n && e.endDay === 0) {
        frontierReached = true;
        break;
      }
      // Creation-ordered: nothing at or beyond this id can cover `day`.
      if (BigInt(e.startDay === 0 ? 1 : e.startDay) > day) {
        frontierReached = true;
        break;
      }
      const start = BigInt(e.startDay === 0 ? 1 : e.startDay);
      if (Number(e.side) === side && e.endDay > 0 && day >= start && day < BigInt(e.endDay)) {
        pending.push(id);
      }
    }
    nextId += BigInt(page.length);

    while (pending.length >= MAX_IDS_PER_BATCH && budget.batches > 0) {
      if (!(await flush())) return;
    }
    if (budget.batches <= 0) {
      console.log(
        `[keeper] commitmentReport chain=${chainId} day=${day} side=${side} batch budget exhausted — resumes next tick`,
      );
      return;
    }
  }
  if (!frontierReached && budget.pages <= 0) {
    console.warn(
      `[keeper] commitmentReport chain=${chainId} day=${day} side=${side} page budget exhausted mid-walk — resumes next tick`,
    );
  }
  while (pending.length > 0 && budget.batches > 0) {
    if (!(await flush())) return;
  }
}

async function sendReport(
  publicClient: PublicClient,
  ctx: KeeperContext,
  diamond: Address,
  day: bigint,
): Promise<void> {
  const fee = (await publicClient.readContract({
    address: diamond,
    abi: COMMIT_ABI,
    functionName: 'quoteCommitmentReportFee',
    args: [day],
  })) as bigint;

  const hash = await ctx.wallet.writeContract({
    address: diamond,
    abi: COMMIT_ABI,
    functionName: 'sendCommitmentReport',
    args: [day],
    value: fee,
    chain: undefined,
    account: ctx.wallet.account ?? null,
  } as never);
  try {
    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 30_000 });
    if (receipt.status !== 'success') {
      console.warn(
        `[keeper] commitmentReport send day=${day} tx=${hash} REVERTED — re-evaluated next tick (send is CEI-retryable)`,
      );
      return;
    }
    console.log(`[keeper] commitmentReport day=${day} SENT fee=${fee} tx=${hash}`);
  } catch {
    console.warn(
      `[keeper] commitmentReport send day=${day} tx=${hash} receipt wait timed out — next tick re-checks isDayCommitmentReady`,
    );
  }
}
