// apps/keeper/src/rewardBudgetRemit.ts
//
// #925 — reward-budget remittance automation.
//
// The #776 bridge lets Base fund each mirror's interaction-reward VPFI on
// demand (`RewardRemittanceFacet.remitRewardBudget`, which is `onlyCanonical`
// — it runs ON Base and sends TO a mirror `dstChainId`). Without this pass an
// operator must hand-remit; this drives it on the cron tick so mirrors stay
// funded ahead of their claim frontier (remit-before-broadcast, IncidentRunbook
// §2b).
//
// Discovery is cursor-free by design: `quoteRewardBudget` returns 0 for any
// non-finalized / already-remitted / no-slice day, so re-scanning a bounded
// recent window each tick is harmless and needs no persisted state. Sends are
// idempotent on-chain (already-sent days are skipped), so a retry is always
// safe.
//
// Gated twice: the global `KEEPER_ENABLED` AND an explicit `REWARD_REMIT_ENABLED`
// so the path stays dark until the operator has also authorized the keeper EOA
// on-chain (`setRewardRemittanceKeeper`, or ADMIN).

import { createPublicClient, http, type Abi, type Address, type PublicClient } from 'viem';
import {
  RewardRemittanceFacetABI,
  RewardReporterFacetABI,
  RewardAggregatorFacetABI,
  InteractionRewardsLensFacetABI,
} from '@vaipakam/contracts/abis';
import type { ChainConfig, Env } from './env';
import { getChainConfigs } from './env';
import { buildKeeperContext, isKeeperEnabled, type KeeperContext } from './keeper';

const REMIT_ABI = RewardRemittanceFacetABI as Abi;
const REPORTER_ABI = RewardReporterFacetABI as Abi;
const AGGREGATOR_ABI = RewardAggregatorFacetABI as Abi;
// `getInteractionCurrentDay` moved to the read-only lens facet (#1333).
const INTERACTION_ABI = InteractionRewardsLensFacetABI as Abi;

/** How many recent days to re-scan for un-remitted budget each tick. */
const DEFAULT_LOOKBACK_DAYS = 45;
/**
 * Per-send VPFI ceiling (the `perRemittanceCap` arg + the greedy batch bound).
 * Defaults to the SAME 50k VPFI as `ConfigureCcip.s.sol`'s `CCIP_RATE_CAPACITY`
 * default, so out-of-the-box the batch can never exceed the deployed lane
 * bucket and wedge on a rate-limit revert. Early high-APR days can have a
 * single-day slice above this (and above the 50k lane); the operator raises BOTH
 * the on-chain lane capacity and `REWARD_REMIT_LANE_CAP` together for those (see
 * #918). A day whose slice exceeds the cap is skipped with a loud log.
 */
const DEFAULT_LANE_CAP = 50_000n * 10n ** 18n;
/**
 * Codex #1426 r1 — bounded backscan behind the normal lookback for ARMED
 * days: a day gated by a missing commitment report can outlive the 45-day
 * lookback and would otherwise never be re-quoted once its report finally
 * completes. Matches the commitment pass's backscan horizon.
 */
const ARMED_BACKSCAN_DAYS = 90;

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

/**
 * Parse a wei amount, accepting BOTH a plain integer string and the scientific
 * `<mantissa>e<exp>` notation used in the README/wrangler docs (e.g. `50000e18`
 * — `BigInt()` alone throws on that). Non-positive / unparseable → fallback.
 */
function readBigint(env: Env, key: string, fallback: bigint): bigint {
  const raw = (env as unknown as Record<string, string | undefined>)[key]?.trim();
  if (!raw) return fallback;
  try {
    const m = raw.match(/^(\d+)e(\d+)$/i);
    const v = m ? BigInt(m[1]) * 10n ** BigInt(m[2]) : BigInt(raw);
    return v > 0n ? v : fallback;
  } catch {
    return fallback;
  }
}

export async function runRewardBudgetRemit(env: Env): Promise<void> {
  if (!isKeeperEnabled(env)) return;
  if (!flagOn(env, 'REWARD_REMIT_ENABLED')) return;

  for (const chain of getChainConfigs(env)) {
    try {
      await remitFromCanonical(env, chain);
    } catch (err) {
      console.error(`[keeper] rewardBudgetRemit chain=${chain.id} failed:`, err);
    }
  }
}

async function remitFromCanonical(env: Env, chain: ChainConfig): Promise<void> {
  const publicClient = createPublicClient({ transport: http(chain.rpc) });
  const diamond = chain.diamond as Address;

  // `remitRewardBudget` is Base-only; find the canonical chain and remit from it.
  const cfg = (await publicClient.readContract({
    address: diamond,
    abi: REPORTER_ABI,
    functionName: 'getRewardReporterConfig',
  })) as readonly [Address, number, number, boolean, bigint];
  const localChainId = Number(cfg[1]);
  const isCanonical = cfg[3];
  if (!isCanonical) return;

  const [currentDay, active] = (await publicClient.readContract({
    address: diamond,
    abi: INTERACTION_ABI,
    functionName: 'getInteractionCurrentDay',
  })) as readonly [bigint, boolean];
  if (!active || currentDay <= 1n) return; // no finalized (day < currentDay) yet

  const ctx = buildKeeperContext(env, chain, publicClient);
  if (!ctx || !ctx.wallet.account) return;

  // Mirror list comes from the ON-CHAIN reward topology (the expected reward
  // sources minus Base itself), NOT from getChainConfigs — funding a mirror is a
  // Base-side call that never touches a mirror RPC, so a mirror must not be
  // silently skipped just because its keeper RPC binding happens to be down.
  const expected = (await publicClient.readContract({
    address: diamond,
    abi: AGGREGATOR_ABI,
    functionName: 'getExpectedSourceChainIds',
  })) as readonly number[];
  const mirrorIds = expected.map(Number).filter((id) => id !== localChainId);
  if (mirrorIds.length === 0) return;

  const lookback = readNumber(env, 'REWARD_REMIT_LOOKBACK_DAYS', DEFAULT_LOOKBACK_DAYS);
  const laneCap = readBigint(env, 'REWARD_REMIT_LANE_CAP', DEFAULT_LANE_CAP);

  // Armed-day window extension (Codex #1426 r1): armed days carry the
  // commitment gate + close-only semantics, so their un-closed tail must
  // stay in scope beyond the plain lookback (bounded by the backscan cap).
  const commitState = (await publicClient.readContract({
    address: diamond,
    abi: AGGREGATOR_ABI,
    functionName: 'getGovernorCommitState',
  })) as readonly [bigint, bigint, bigint, bigint];
  const armedFromDay = commitState[0];

  for (const mirrorId of mirrorIds) {
    try {
      await remitToMirror(publicClient, ctx, diamond, mirrorId, currentDay, lookback, laneCap, armedFromDay);
    } catch (err) {
      // Benign reverts (RewardPoolCapExceeded near exhaustion, NotRewardRemitter
      // if the keeper isn't authorized yet, etc.) — log at info and continue.
      console.log(
        `[keeper] rewardBudgetRemit skipped Base->${mirrorId}: ${(err as Error).message}`,
      );
    }
  }
}

async function remitToMirror(
  publicClient: PublicClient,
  ctx: KeeperContext,
  diamond: Address,
  mirrorId: number,
  currentDay: bigint,
  lookback: number,
  laneCap: bigint,
  armedFromDay: bigint,
): Promise<void> {
  // Candidate window of recent finalized days (strictly < currentDay).
  // Codex #1426 r1: when the program is armed, extend the floor down to
  // the armed range (bounded by the backscan cap) so a day whose
  // commitment report completes only after the plain lookback expired is
  // still re-quoted, and a zero-clamp day's close-only batch still runs.
  let from = currentDay > BigInt(lookback) ? currentDay - BigInt(lookback) : 1n;
  if (armedFromDay !== 0n && armedFromDay < from) {
    const span = BigInt(lookback + ARMED_BACKSCAN_DAYS);
    const floor = currentDay > span ? currentDay - span : 1n;
    const armedFloor = armedFromDay > floor ? armedFromDay : floor;
    if (armedFloor > armedFromDay) {
      console.warn(
        `[keeper] rewardBudgetRemit mirror=${mirrorId} armed window floored at ${armedFloor} by the ${lookback}+${ARMED_BACKSCAN_DAYS}-day cap — anything older and un-closed needs operator attention`,
      );
    }
    if (armedFloor < from) from = armedFloor;
  }
  const window: bigint[] = [];
  for (let d = from; d < currentDay; d++) window.push(d);
  if (window.length === 0) return;

  // Codex #1426 r1 — plan through the batch planner view, not the plain
  // amount quote: a gate-passing armed day whose clamp lands at ZERO moves
  // no VPFI but must still be submitted so it terminally closes and its
  // finalize-time commitments retire (an amount-only quote cannot
  // distinguish it from a gated/closed day).
  //
  // Codex #1426 r2/r3 — the planner allocates the recycled-BACKING budget
  // sequentially across the whole window, so a day this loop then drops
  // for exceeding the lane cap has still consumed backing that a later day
  // could have used; with an identical full-window plan every tick, that
  // later day would stay non-closeable forever. Re-plan WITHOUT the
  // dropped oversized days (bounded: each pass removes at least one day,
  // and oversized days are rare operator-attention cases).
  let planWindow: bigint[] = window;
  let perDay: readonly bigint[] = [];
  let closeable: readonly boolean[] = [];
  // Codex #1426 r4 — the arrays must always describe the FINAL planWindow:
  // loop until a quote reports no oversized day (each filtering pass
  // removes at least one, so this terminates in ≤ window-length passes;
  // the cap only bounds pathological churn, and a capped exit still
  // re-quotes so indices never misalign).
  const MAX_REPLAN_PASSES = 8;
  for (let pass = 0; ; pass++) {
    [perDay, closeable] = (await publicClient.readContract({
      address: diamond,
      abi: REMIT_ABI,
      functionName: 'quoteRemitDayPlans',
      args: [mirrorId, planWindow],
    })) as readonly [readonly bigint[], readonly boolean[]];
    if (pass >= MAX_REPLAN_PASSES) break;
    const oversized: bigint[] = [];
    for (let i = 0; i < planWindow.length; i++) {
      if ((perDay[i] ?? 0n) > laneCap) {
        console.warn(
          `[keeper] rewardBudgetRemit day=${planWindow[i]} slice=${perDay[i]} > laneCap=${laneCap} mirror=${mirrorId} — raise the reward-budget CCIP lane capacity (#918); day excluded from planning`,
        );
        oversized.push(planWindow[i]);
      }
    }
    if (oversized.length === 0) break;
    const drop = new Set(oversized.map((d) => d.toString()));
    planWindow = planWindow.filter((d) => !drop.has(d.toString()));
    if (planWindow.length === 0) return;
  }

  // Greedily batch the un-remitted days, keeping the total under the lane
  // cap. Close-only days (closeable, zero amount) ride along for free.
  const batch: bigint[] = [];
  let total = 0n;
  for (let i = 0; i < planWindow.length; i++) {
    const slice = perDay[i] ?? 0n;
    if (slice === 0n) {
      if (closeable[i]) batch.push(planWindow[i]);
      continue;
    }
    if (slice > laneCap) continue; // appeared oversized on the final pass
    if (total + slice > laneCap) break; // fill the rest on a later tick
    batch.push(planWindow[i]);
    total += slice;
  }
  if (batch.length === 0) return;

  // Exact CCIP fee for THIS batch (the keeper EOA can't call the messenger's
  // quote directly — only the Diamond handler can; that's what this view wraps).
  // `quotedTotal` is the VPFI the send would actually move.
  const [fee, quotedTotal] = (await publicClient.readContract({
    address: diamond,
    abi: REMIT_ABI,
    functionName: 'quoteRemittanceFee',
    args: [mirrorId, batch],
  })) as readonly [bigint, bigint];
  // A race (another tick / a manual-admin remit) can consume the selected days
  // between `quoteRewardBudget` above and here, or the messenger/VPFI wiring can
  // be unset — either way `quoteRemittanceFee` returns total 0. Submitting the
  // now-stale batch would revert (NothingToRemit / config guard) and burn keeper
  // gas every tick, so skip and re-evaluate on the next tick.
  if (quotedTotal === 0n && total > 0n) {
    console.log(
      `[keeper] rewardBudgetRemit Base->${mirrorId} batch=${batch.length} — quote total 0 (raced or wiring unset); skipping`,
    );
    return;
  }
  // A close-only batch (every day clamped to zero) legitimately quotes 0:
  // nothing is dispatched on-chain, the fee is 0, and the send just closes
  // the days + retires their commitments. If it races an admin close the
  // send reverts NothingToRemit, caught benignly below.

  const hash = await ctx.wallet.writeContract({
    address: diamond,
    abi: REMIT_ABI,
    functionName: 'remitRewardBudget',
    args: [mirrorId, batch, laneCap],
    value: fee,
    chain: undefined,
    account: ctx.wallet.account ?? null,
  } as never);
  // Wait for the tx to mine BEFORE returning: `remitRewardBudget` marks the
  // (chain, day) pairs only when mined, so a still-pending tx would let a later
  // remit (in this or a subsequent tick) re-quote the same state. Cross-tick
  // overlap (a tx pending past the 1-min cron interval) can still race, but that
  // is harmless by construction: the on-chain marks make a duplicate remit a
  // safe no-op that reverts `NothingToRemit` — no double-fund, no loss — caught
  // at info below. This is the same on-chain-idempotency safety model every
  // other keeper pass relies on for cross-invocation dedup.
  // Bound the wait (viem defaults to 180s) — mirrors are processed sequentially
  // and the cron fires every minute, so an unbounded wait on one slow/dropped tx
  // would starve later mirrors and burn the invocation's wall-time. 30s matches
  // the matcher pass. On timeout we bail this mirror; the on-chain marks make the
  // next tick's re-quote safe (a duplicate reverts NothingToRemit).
  let receipt;
  try {
    receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 30_000 });
  } catch {
    console.warn(
      `[keeper] rewardBudgetRemit Base->${mirrorId} tx=${hash} receipt wait timed out — continuing; next tick re-evaluates`,
    );
    return;
  }
  if (receipt.status !== 'success') {
    // Broadcast succeeded but the tx reverted on-chain (e.g. a manual/admin
    // remit or a pool-cap change won the race between quote and inclusion).
    console.warn(
      `[keeper] rewardBudgetRemit Base->${mirrorId} tx=${hash} REVERTED (status=${receipt.status}) — days re-evaluated next tick`,
    );
    return;
  }
  console.log(
    `[keeper] rewardBudgetRemit Base->${mirrorId} days=${batch.length} total=${total} fee=${fee} tx=${hash}`,
  );
}
