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
//   1. wait for the day's funding stamp to land (`getChainDayRecycledFunding`
//      — the on-chain send gate would revert before it anyway);
//   2. feed `submitCommitmentBatch` with each participating user's FULL
//      day-`D` entry set (users strictly ascending — the on-chain cursor is
//      the dedup, `getCommitmentAccumulation` is the resume point). The
//      mirror recomputes every figure from its own storage, so this pass can
//      delay the report but never distort it;
//   3. once demand conservation completes (`isDayCommitmentReady`), quote via
//      `quoteCommitmentReportFee` and dispatch `sendCommitmentReport`.
//
// Candidate users come from the shared D1 `loans` table (lender ∪ borrower of
// loans overlapping the window) — deliberately NOT the on-chain active-loan
// list, which drops loans that closed after day `D` and would leave demand
// conservation permanently short (the same wrong-set flaw that sank the B2-c
// paged report, Codex #1422). The D1 set is a SUPERSET; exact day coverage is
// filtered per user against the on-chain entry windows, and a user with no
// covering entries is simply skipped (no cursor consumption).
//
// Discovery is cursor-free across ticks: completed/sent days read as
// "conservation == totals" and are skipped; the on-chain accumulation cursor
// makes re-submission of a user impossible, so a crashed tick resumes safely.
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
/** Users per submitCommitmentBatch tx (bounded calldata / gas). */
const MAX_USERS_PER_BATCH = 40;
/** Batch txs per invocation across all days (bounded invocation work). */
const MAX_BATCHES_PER_TICK = 8;
/**
 * Candidate addresses whose entry sets are read per invocation. A truncated
 * scan is safe (ascending order + the on-chain cursor resume), but log it —
 * silent caps read as full coverage.
 */
const MAX_CANDIDATES_PER_TICK = 300;

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

  // Lazy, once per chain per tick: the candidate superset from D1. The
  // window margin generously covers every loan that could hold a day-`D`
  // entry for any day in the lookback (exact coverage is filtered on-chain).
  let candidates: Address[] | null = null;
  const sinceSec = Math.floor(Date.now() / 1000) - (lookback + 15) * 86_400;

  let batchBudget = MAX_BATCHES_PER_TICK;

  for (let d = from; d < currentDay && batchBudget > 0; d++) {
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

      // The day's funding stamp is the on-chain precondition for both the
      // batch path (Δ pricing) and the send — nothing to do before it lands.
      const funding = (await publicClient.readContract({
        address: diamond,
        abi: AGGREGATOR_ABI,
        functionName: 'getChainDayRecycledFunding',
        args: [d, localChainId],
      })) as { stamped: boolean };
      if (!funding.stamped) continue;

      const [, , totalLender, totalBorrower] = (await publicClient.readContract({
        address: diamond,
        abi: LENS_ABI,
        functionName: 'getInteractionDayEntry',
        args: [d, ZERO_ADDR],
      })) as readonly [bigint, bigint, bigint, bigint];

      for (const side of [0, 1] as const) {
        if (batchBudget <= 0) break;
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
          // Should be unreachable (the mirror recomputes from its own
          // storage); a mis-submission wedge is operator territory
          // (resetCommitmentAccumulation).
          console.warn(
            `[keeper] commitmentReport chain=${chain.id} day=${d} side=${side} conservation ${conservation} > total ${total} — needs operator resetCommitmentAccumulation`,
          );
          continue;
        }

        if (candidates === null) {
          candidates = await candidateUsers(env.DB, chain.id, sinceSec);
        }
        batchBudget = await submitSide(
          publicClient,
          ctx,
          diamond,
          chain.id,
          d,
          side,
          cursor,
          candidates,
          batchBudget,
        );
      }

      const readyNow = (await publicClient.readContract({
        address: diamond,
        abi: COMMIT_ABI,
        functionName: 'isDayCommitmentReady',
        args: [d],
      })) as boolean;
      if (readyNow) await sendReport(publicClient, ctx, diamond, d);
    } catch (err) {
      // Benign races (another tick submitted the same users → cursor revert,
      // stamp landing mid-scan, etc.) — log and let the next tick re-evaluate.
      console.log(
        `[keeper] commitmentReport chain=${chain.id} day=${d} skipped: ${(err as Error).message}`,
      );
    }
  }
}

/**
 * Distinct lender ∪ borrower addresses of loans on `chainId` whose lifetime
 * overlaps the scan window — a SUPERSET of every user who can hold a
 * day-covering reward entry in the lookback (terminal loans stay included:
 * a loan closed after day `D` still owes a day-`D` commitment unit).
 * Ascending by address value, matching the on-chain cursor order.
 */
async function candidateUsers(
  db: D1Database,
  chainId: number,
  sinceSec: number,
): Promise<Address[]> {
  const res = await db
    .prepare(
      `SELECT DISTINCT u FROM (
         SELECT lender AS u FROM loans
           WHERE chain_id = ?1 AND (terminal_at IS NULL OR terminal_at >= ?2)
         UNION
         SELECT borrower AS u FROM loans
           WHERE chain_id = ?1 AND (terminal_at IS NULL OR terminal_at >= ?2)
       )`,
    )
    .bind(chainId, sinceSec)
    .all<{ u: string }>();
  const users = (res.results ?? []).map((r) => r.u.toLowerCase() as Address);
  users.sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0));
  return users;
}

/**
 * Submit ascending user batches for `(day, side)` starting strictly above
 * `cursor`. Each user ships their FULL set of day-covering entries (the
 * on-chain per-user cap applies to the whole rawPay, so a user must never be
 * split across batches). Returns the remaining batch budget.
 */
async function submitSide(
  publicClient: PublicClient,
  ctx: KeeperContext,
  diamond: Address,
  chainId: number,
  day: bigint,
  side: 0 | 1,
  cursor: bigint,
  candidates: Address[],
  batchBudget: number,
): Promise<number> {
  const users: Address[] = [];
  const entryIds: bigint[][] = [];
  let scanned = 0;

  for (const user of candidates) {
    if (BigInt(user) <= cursor) continue;
    if (scanned >= MAX_CANDIDATES_PER_TICK) {
      console.warn(
        `[keeper] commitmentReport chain=${chainId} day=${day} side=${side} candidate scan truncated at ${MAX_CANDIDATES_PER_TICK} — remainder resumes next tick`,
      );
      break;
    }
    scanned++;
    if (users.length >= MAX_USERS_PER_BATCH * batchBudget) break;

    const [entries, ids] = (await Promise.all([
      publicClient.readContract({
        address: diamond,
        abi: LENS_ABI,
        functionName: 'getUserRewardEntries',
        args: [user],
      }),
      publicClient.readContract({
        address: diamond,
        abi: LENS_ABI,
        functionName: 'getUserRewardEntryIds',
        args: [user],
      }),
    ])) as [readonly RewardEntryView[], readonly bigint[]];

    // Mirror of the on-chain window rule (LibCommitmentReport._userRawPay):
    // start = startDay || 1; covers iff start <= day < endDay. Open entries
    // (endDay 0) never cover — production always stamps a forward endDay.
    const covering: bigint[] = [];
    entries.forEach((e, i) => {
      const start = BigInt(e.startDay === 0 ? 1 : e.startDay);
      if (
        Number(e.side) === side &&
        e.endDay > 0 &&
        day >= start &&
        day < BigInt(e.endDay)
      ) {
        covering.push(ids[i]);
      }
    });
    if (covering.length === 0) continue; // skipped users don't consume the cursor

    users.push(user);
    entryIds.push(covering);
  }
  if (users.length === 0) return batchBudget;

  for (let i = 0; i < users.length && batchBudget > 0; i += MAX_USERS_PER_BATCH) {
    const chunkUsers = users.slice(i, i + MAX_USERS_PER_BATCH);
    const chunkIds = entryIds.slice(i, i + MAX_USERS_PER_BATCH);
    const hash = await ctx.wallet.writeContract({
      address: diamond,
      abi: COMMIT_ABI,
      functionName: 'submitCommitmentBatch',
      args: [day, side, chunkUsers, chunkIds],
      chain: undefined,
      account: ctx.wallet.account ?? null,
    } as never);
    // Sequential batches share the ascending cursor — each must mine before
    // the next is even valid. Bounded wait, matching the remit pass.
    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 30_000 });
    if (receipt.status !== 'success') {
      console.warn(
        `[keeper] commitmentReport chain=${chainId} day=${day} side=${side} batch tx=${hash} REVERTED — next tick resumes from the on-chain cursor`,
      );
      return batchBudget - 1;
    }
    batchBudget--;
    console.log(
      `[keeper] commitmentReport chain=${chainId} day=${day} side=${side} submitted ${chunkUsers.length} users tx=${hash}`,
    );
  }
  return batchBudget;
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
