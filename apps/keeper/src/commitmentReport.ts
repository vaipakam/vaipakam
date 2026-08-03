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
//   2. walk the GLOBAL reward-entry id sequence, filter the entries that
//      cover the day on that side, and feed them to `submitCommitmentBatch`
//      in ascending id order. The unit is the ENTRY (transfer-invariant —
//      Codex #1425 r1), so no user discovery and no positional drift: the
//      chain's own sequential entry ids are the complete enumeration, and
//      ids are creation-ordered so the walk stops at the first entry with
//      `startDay > D`;
//   3. once demand conservation completes (`isDayCommitmentReady`), quote via
//      `quoteCommitmentReportFee` and dispatch `sendCommitmentReport`.
//
// Statelessness is bridged through the shared D1 (Codex #1425 r2, schema in
// apps/indexer/migrations/0043): a per-(day, side) SCAN FRONTIER persists
// progress across arbitrarily long non-covering id gaps (the on-chain cursor
// only advances on submissions, so a stateless walk would otherwise re-read
// the same pages forever), invalidated automatically when the on-chain
// cursor moves backward (operator resetCommitmentAccumulation); and a
// per-(chain, day) RESOLVED marker lets finished days be skipped with zero
// RPC reads. The pass scans its FULL bounded day range every tick — days can
// resolve out of order, so one resolved day is never treated as proof that
// every earlier day resolved (Codex #1425 r2) — with the range floor at
// `armedFromDay`, bounded by lookback + backscan caps.
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
import { buildKeeperContext, passIsArmed, type KeeperContext } from './keeper';
import {
  getCommitmentScanState,
  getOpenReconciledDays,
  markCommitmentDayResolved,
  markReconciledDayConsumed,
  putCommitmentScanFrontier,
} from './db';

const COMMIT_ABI = RewardCommitmentFacetABI as Abi;
const REPORTER_ABI = RewardReporterFacetABI as Abi;
const AGGREGATOR_ABI = RewardAggregatorFacetABI as Abi;
const LENS_ABI = InteractionRewardsLensFacetABI as Abi;

/** Primary recent-day window re-scanned each tick. */
const DEFAULT_LOOKBACK_DAYS = 14;
/** How far past the lookback floor the unresolved-day range extends. */
const MAX_BACKSCAN_DAYS = 90;
/** Entry ids per submitCommitmentBatch tx (bounded calldata / gas). */
const MAX_IDS_PER_BATCH = 200;
/** Batch txs per invocation across all days (bounded invocation work). */
const MAX_BATCHES_PER_TICK = 8;
/** Entry-range page size (the lens view clamps at 500 anyway). */
const PAGE_SIZE = 500n;
/**
 * Entry-range pages read per invocation across all days. Truncation is safe:
 * the persisted scan frontier resumes exactly where the walk stopped.
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

function readNumber(env: Env, key: string, fallback: number): number {
  const raw = (env as unknown as Record<string, string | undefined>)[key];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export async function runCommitmentReport(env: Env): Promise<void> {
  if (!passIsArmed(env, 'commitmentReport', 'REWARD_COMMIT_ENABLED')) return;

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

  // FULL bounded range every tick (Codex #1425 r2): floor at armedFromDay,
  // capped at lookback + backscan days below currentDay. Days can resolve
  // out of order, so no "first resolved day" short-circuit — instead,
  // resolved days are D1-marked and skipped with zero RPC reads.
  const lookback = readNumber(env, 'REWARD_COMMIT_LOOKBACK_DAYS', DEFAULT_LOOKBACK_DAYS);
  const span = BigInt(lookback + MAX_BACKSCAN_DAYS);
  let from = currentDay > span ? currentDay - span : 1n;
  if (from < armedFromDay) from = armedFromDay;
  if (from > armedFromDay && from === currentDay - span) {
    console.warn(
      `[keeper] commitmentReport chain=${chain.id} day range floored at ${from} by the ${lookback}+${MAX_BACKSCAN_DAYS}-day cap — anything older and unresolved needs operator attention`,
    );
  }

  // #1222 M3 B2-d2 (P7) — reconcile rediscovery: union in reconciled
  // (day, this-chain) pairs the indexer persisted from Base's
  // CommitmentRemitEligibilityReconciled events, so an operator-reconciled
  // OLD day outside the bounded window still gets its (bookkeeping) report.
  // r6 — reconcile rows are namespaced by the emitting canonical DIAMOND
  // (same-chain redeploys overlap on day ids). Resolve it from the chain
  // configs; without a configured Base RPC binding the rediscovery union
  // is skipped (the bounded window still runs).
  const baseCfg = getChainConfigs(env).find((c) => c.id === baseChainId);
  const baseDiamond = baseCfg?.diamond;
  const reconciled = baseDiamond
    ? await getOpenReconciledDays(env.DB, baseChainId, baseDiamond, chain.id)
    : [];
  const reconciledSet = new Set(reconciled);
  const dayList: bigint[] = [];
  for (let d = from; d < currentDay; d++) dayList.push(d);
  let stateFrom = Number(from);
  for (const rd of reconciled) {
    if (rd >= Number(armedFromDay) && rd < Number(from)) {
      dayList.push(BigInt(rd));
      if (rd < stateFrom) stateFrom = rd;
    }
  }

  const { resolved, scans } = await getCommitmentScanState(
    env.DB,
    chain.id,
    stateFrom,
    Number(currentDay),
  );

  const budget: TickBudget = { batches: MAX_BATCHES_PER_TICK, pages: MAX_PAGES_PER_TICK };

  for (const d of dayList) {
    if (budget.batches <= 0 || budget.pages <= 0) break;
    if (resolved.has(Number(d))) {
      // A reconciled rediscovery whose report is already dispatched is
      // terminal — retire the D1 row so the union stays bounded.
      if (reconciledSet.has(Number(d)) && baseDiamond) {
        await markReconciledDayConsumed(
          env.DB, baseChainId, baseDiamond, chain.id, Number(d),
        );
      }
      continue; // zero-RPC skip
    }
    try {
      const ready = (await publicClient.readContract({
        address: diamond,
        abi: COMMIT_ABI,
        functionName: 'isDayCommitmentReady',
        args: [d],
      })) as boolean;
      if (ready) {
        await sendReport(publicClient, ctx, diamond, d);
      } else {
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
          await submitSide(
            env,
            publicClient,
            ctx,
            diamond,
            chain.id,
            d,
            side,
            cursor,
            scans.get(`${Number(d)}:${side}`),
            budget,
          );
        }

        const readyNow = (await publicClient.readContract({
          address: diamond,
          abi: COMMIT_ABI,
          functionName: 'isDayCommitmentReady',
          args: [d],
        })) as boolean;
        if (readyNow) await sendReport(publicClient, ctx, diamond, d);
      }

      // Resolution probe: the explicit on-chain dispatch flag. Marked days
      // are skipped with zero reads forever after.
      if (await isDayResolved(publicClient, diamond, d)) {
        await markCommitmentDayResolved(env.DB, chain.id, Number(d));
        if (reconciledSet.has(Number(d)) && baseDiamond) {
          await markReconciledDayConsumed(
            env.DB, baseChainId, baseDiamond, chain.id, Number(d),
          );
        }
      }
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
 * A day is RESOLVED only when its report is EXPLICITLY dispatched
 * (`isCommitmentReportSent` — Codex #1425 r3: "complete but not ready" is
 * NOT proof of dispatch, since readiness also folds in the messenger
 * wiring; an un-wired mirror's complete-unsent day would read identically
 * and a resolved marker is permanent).
 */
async function isDayResolved(
  publicClient: PublicClient,
  diamond: Address,
  d: bigint,
): Promise<boolean> {
  return (await publicClient.readContract({
    address: diamond,
    abi: COMMIT_ABI,
    functionName: 'isCommitmentReportSent',
    args: [d],
  })) as boolean;
}

/**
 * Walk the global entry-id sequence for `(day, side)`, submitting ascending
 * batches of covering entries. The scan resumes from the D1-persisted
 * frontier (everything below it is submitted or verified non-covering) so
 * arbitrarily long non-covering gaps cost each page read exactly once
 * (Codex #1425 r2); the frontier is discarded when the on-chain cursor
 * moved backward (operator reset — earlier submissions were wiped and must
 * be rescanned). Ids are creation-ordered and `startDay` is stamped from
 * the registration day, so the walk stops at the first entry with
 * `startDay > day`.
 */
async function submitSide(
  env: Env,
  publicClient: PublicClient,
  ctx: KeeperContext,
  diamond: Address,
  chainId: number,
  day: bigint,
  side: 0 | 1,
  cursor: bigint,
  persisted: { scanNext: bigint; lastCursor: bigint } | undefined,
  budget: TickBudget,
): Promise<void> {
  // Reset detection: cursor moved backward vs the frontier's snapshot.
  const frontierValid = persisted !== undefined && cursor >= persisted.lastCursor;
  let nextId = cursor + 1n;
  if (frontierValid && persisted.scanNext > nextId) nextId = persisted.scanNext;

  let pending: bigint[] = [];
  let frontierReached = false;
  // Highest id actually submitted THIS invocation — persisted as
  // `last_cursor` so reset detection compares against the POST-batch chain
  // state (Codex #1425 r3: persisting the pre-batch read let a reset that
  // landed right after our batches masquerade as the pre-batch cursor).
  let lastSubmitted = cursor;

  const flush = async (): Promise<boolean> => {
    if (pending.length === 0) return true;
    const batch = pending.slice(0, MAX_IDS_PER_BATCH);
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
      // Keep the batch in `pending` — the frontier persisted below must not
      // advance past unsubmitted covering ids.
      console.warn(
        `[keeper] commitmentReport chain=${chainId} day=${day} side=${side} batch tx=${hash} REVERTED — resumes from the on-chain cursor / frontier next tick`,
      );
      return false;
    }
    pending = pending.slice(MAX_IDS_PER_BATCH);
    lastSubmitted = batch[batch.length - 1];
    console.log(
      `[keeper] commitmentReport chain=${chainId} day=${day} side=${side} submitted ${batch.length} entries tx=${hash}`,
    );
    return true;
  };

  let aborted = false;
  while (!frontierReached && !aborted && budget.pages > 0) {
    budget.pages--;
    const page = (await publicClient.readContract({
      address: diamond,
      abi: LENS_ABI,
      functionName: 'getRewardEntriesRange',
      args: [nextId, PAGE_SIZE],
    })) as readonly RewardEntryView[];

    let consumed = 0;
    for (let i = 0; i < page.length; i++) {
      const e = page[i];
      const id = nextId + BigInt(i);
      // Zeroed struct ⇒ past the end of the allocated sequence.
      if (e.user === ZERO_ADDR && e.perDayNumeraire18 === 0n && e.endDay === 0) {
        frontierReached = true;
        break;
      }
      const start = BigInt(e.startDay === 0 ? 1 : e.startDay);
      // Creation-ordered: nothing at or beyond this id can cover `day`.
      if (start > day) {
        frontierReached = true;
        break;
      }
      consumed = i + 1;
      if (Number(e.side) === side && e.endDay > 0 && day >= start && day < BigInt(e.endDay)) {
        pending.push(id);
      }
    }
    nextId += BigInt(consumed);

    while (pending.length >= MAX_IDS_PER_BATCH && budget.batches > 0) {
      if (!(await flush())) {
        aborted = true;
        break;
      }
    }
    if (!aborted && pending.length >= MAX_IDS_PER_BATCH && budget.batches <= 0) {
      aborted = true; // batch budget out with work left — resume next tick
    }
  }

  while (!aborted && pending.length > 0 && budget.batches > 0) {
    if (!(await flush())) aborted = true;
  }

  // Persist the frontier: everything below it is submitted or verified
  // non-covering. If covering ids remain unsubmitted (budget out / revert),
  // the frontier must sit AT the lowest unsubmitted covering id. The cursor
  // snapshot is the POST-batch value (`lastSubmitted`), so a later operator
  // reset — which rewinds the on-chain cursor below it — is always detected
  // and invalidates the frontier.
  const frontier = pending.length > 0 ? pending[0] : nextId;
  try {
    await putCommitmentScanFrontier(env.DB, chainId, Number(day), side, frontier, lastSubmitted);
  } catch (err) {
    console.warn(
      `[keeper] commitmentReport chain=${chainId} day=${day} side=${side} frontier persist failed (rescan next tick): ${(err as Error).message}`,
    );
  }
  if (aborted || (!frontierReached && budget.pages <= 0)) {
    console.log(
      `[keeper] commitmentReport chain=${chainId} day=${day} side=${side} paused (budgets) — frontier=${frontier} persisted, resumes next tick`,
    );
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
