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
  RewardRemittanceLensFacetABI,
  RewardReporterFacetABI,
  RewardAggregatorFacetABI,
  InteractionRewardsLensFacetABI,
} from '@vaipakam/contracts/abis';
import type { ChainConfig, Env } from './env';
import { getChainConfigs } from './env';
import { buildKeeperContext, passIsArmed, type KeeperContext } from './keeper';

const REMIT_ABI = RewardRemittanceFacetABI as Abi;
/** `getDayClosedByRemitId` lives on the read-only lens facet. */
const REMIT_LENS_ABI = RewardRemittanceLensFacetABI as Abi;

/**
 * Multicall3's canonical deterministic-deployment address, the same on every
 * chain the keeper touches.
 *
 * It has to be passed EXPLICITLY: every keeper client is built as
 * `createPublicClient({ transport: http(chain.rpc) })` with no `chain`, so viem
 * cannot look the address up from `chain.contracts.multicall3` and
 * `multicall()` throws `client chain not configured. multicallAddress is
 * required.` before it issues a single request (Codex #1924 r37). That threw
 * the batched probe below straight into its catch path, where every ambiguous
 * day reads as UNKNOWN — so the discriminator never actually discriminated and
 * operators would have had to clear the whole window by hand, every run.
 *
 * Supplying the address rather than attaching a chain object keeps the change
 * to this call site; the tree-wide clients are chainless by design.
 */
const MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11' as Address;
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
  if (!passIsArmed(env, 'rewardBudgetRemit', 'REWARD_REMIT_ENABLED')) return;

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

  let covered = 0;
  const attempted = mirrorIds.length;
  for (const mirrorId of mirrorIds) {
    try {
      if (await remitToMirror(publicClient, ctx, diamond, mirrorId, currentDay, lookback, laneCap, armedFromDay)) {
        covered += 1;
      }
    } catch (err) {
      // Benign reverts (RewardPoolCapExceeded near exhaustion, NotRewardRemitter
      // if the keeper isn't authorized yet, etc.) — log at info and continue.
      console.log(
        `[keeper] rewardBudgetRemit skipped Base->${mirrorId}: ${(err as Error).message}`,
      );
    }
  }
  // #1896 — POSITIVE coverage evidence, for the same reason the liquidator
  // emits one (see `logScanComplete` there). Every unhappy path in this pass
  // is a distinct marker — `chain=<id> failed:`, `skipped Base-><id>:`,
  // `REVERTED` — none of which shares a prefix, so "no error lines" was never
  // a checkable condition. This says how many destinations were actually
  // served out of how many were attempted — a number to compare, not an
  // absence to trust (Codex #1924 r17).
  // eslint-disable-next-line no-console
  console.log(
    `[keeper] rewardBudgetRemit coverage: ${covered}/${attempted} destination(s) completed`,
  );
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
): Promise<boolean> {
  // Returns TRUE only when this destination is SETTLED for this tick —
  // either remitted successfully, or genuinely nothing owed. FALSE on every
  // path that leaves days un-remitted (plan not stabilized, zero quote,
  // receipt timeout, reverted receipt). The caller's coverage counter is a
  // stand-down signal, and several of these paths log-and-return rather than
  // throwing, so counting attempts instead of outcomes reported A/A while
  // mirrors sat unfunded (Codex #1924 r18).
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
  if (window.length === 0) return true; // nothing owed

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
  // Codex #1426 r4/r6 — batch only a STABILIZED plan: loop until a quote
  // reports no oversized day (each filtering pass removes at least one, so
  // this terminates within the window length; tight recycled backing can
  // expose oversized days one per pass). If the safety cap trips before
  // stabilization, BAIL for this tick rather than batch from a plan whose
  // backing allocation still includes an excluded day — an unstabilized
  // batch would starve affordable later days every tick.
  const MAX_REPLAN_PASSES = 24;
  let droppedInReplan = 0;
  let stabilized = false;
  for (let pass = 0; pass < MAX_REPLAN_PASSES; pass++) {
    [perDay, closeable] = (await publicClient.readContract({
      address: diamond,
      abi: REMIT_ABI,
      functionName: 'quoteRemitDayPlans',
      args: [mirrorId, planWindow],
    })) as readonly [readonly bigint[], readonly boolean[]];
    const oversized: bigint[] = [];
    for (let i = 0; i < planWindow.length; i++) {
      if ((perDay[i] ?? 0n) > laneCap) {
        console.warn(
          `[keeper] rewardBudgetRemit day=${planWindow[i]} slice=${perDay[i]} > laneCap=${laneCap} mirror=${mirrorId} — raise the reward-budget CCIP lane capacity (#918); day excluded from planning`,
        );
        oversized.push(planWindow[i]);
      }
    }
    if (oversized.length === 0) {
      stabilized = true;
      break;
    }
    const drop = new Set(oversized.map((d) => d.toString()));
    // Days dropped during REPLANNING are still owed. `deferred` is computed
    // later from the filtered plan, so without carrying these forward a mixed
    // plan — one oversized day plus several sendable ones — sent the sendable
    // batch, finished with deferred === 0, and reported the destination
    // settled while the oversized day stayed unfunded (Codex #1924 r21).
    droppedInReplan += oversized.length;
    planWindow = planWindow.filter((d) => !drop.has(d.toString()));
    if (planWindow.length === 0) {
      // NOT settled (Codex #1924 r19). Reaching here means every owed day was
      // dropped for exceeding the lane cap — the days are still un-remitted
      // and the warning above is an explicit call for operator attention.
      // Returning true would count this destination as covered and let manual
      // funding stand down over mirrors that received nothing.
      return false;
    }
  }
  if (!stabilized) {
    console.warn(
      `[keeper] rewardBudgetRemit mirror=${mirrorId} plan did not stabilize within ${MAX_REPLAN_PASSES} passes — skipping this tick (raise the lane capacity per #918)`,
    );
    return false;
  }

  // Greedily batch the un-remitted days, keeping the total under the lane
  // cap. Close-only days (closeable, zero amount) ride along for free.
  const batch: bigint[] = [];
  let total = 0n;
  // Days that are ACTIONABLE but did not make this tick's batch. This is the
  // discriminator the coverage signal turns on, and getting it wrong has now
  // gone both ways: r19 treated an empty batch as always-unsettled, which made
  // the steady state (every day already remitted, so every entry comes back
  // amount=0 / closeable=false) report 0/A forever and put the stand-down
  // permanently out of reach. An empty batch is settled ONLY when nothing was
  // left behind (Codex #1924 r20).
  let deferred = droppedInReplan;
  for (let i = 0; i < planWindow.length; i++) {
    const slice = perDay[i] ?? 0n;
    if (slice === 0n) {
      // Zero-amount and not closeable = nothing to do for this day. Already
      // remitted, or otherwise not eligible; NOT a deferral.
      if (closeable[i]) batch.push(planWindow[i]);
      continue;
    }
    if (slice > laneCap) {
      deferred += 1; // appeared oversized on the final pass
      continue;
    }
    if (total + slice > laneCap) {
      // Cap reached: this day and EVERY later actionable one wait for a
      // later tick. Counting only this one would under-report (r20).
      for (let k = i; k < planWindow.length; k++) {
        const rest = perDay[k] ?? 0n;
        if (rest > 0n) deferred += 1;
      }
      break;
    }
    batch.push(planWindow[i]);
    total += slice;
  }
  // A zero-amount, non-closeable day is AMBIGUOUS: `quoteRemitDayPlans`
  // returns exactly that both for a day already remitted AND for one that is
  // still owed but gated — an armed day awaiting its commitment report, or a
  // recycled day without backing (Codex #1924 r34). Treating them alike let
  // the coverage marker report A/A while source funding was still owed.
  //
  // `getDayClosedByRemitId` is the discriminator: 0 means the day is still
  // open. Only the ambiguous days are queried, so the cost is bounded by how
  // many of them there are — and in the steady state, where every day really
  // is closed, this is exactly the set that would otherwise have been silently
  // counted as covered.
  const ambiguous = planWindow.filter((_, i) => (perDay[i] ?? 0n) === 0n && !closeable[i]);
  // ONE subrequest, not one per day (Codex #1924 r36). The default window is
  // 45 days and in steady state EVERY already-closed day lands here, so the
  // sequential loop this replaces issued up to 45 subrequests per mirror —
  // against a 50-subrequest free-tier ceiling that the setup reads and the
  // plan quote have already eaten into. A second mirror would simply not be
  // processed. Adding an unbounded per-day loop to the Worker that #1896
  // exists to bring back under its limits was the wrong instinct; multicall
  // makes the whole probe one call.
  const openDays: bigint[] = [];
  if (ambiguous.length > 0) {
    try {
      const results = (await publicClient.multicall({
        contracts: ambiguous.map((dayId) => ({
          address: diamond,
          abi: REMIT_LENS_ABI,
          functionName: 'getDayClosedByRemitId',
          args: [mirrorId, dayId],
        })),
        multicallAddress: MULTICALL3_ADDRESS,
        allowFailure: true,
      })) as { status: 'success' | 'failure'; result?: unknown }[];
      ambiguous.forEach((dayId, i) => {
        const r = results[i];
        // A failed probe is UNKNOWN, and unknown is reported rather than
        // assumed closed.
        if (r?.status !== 'success' || r.result === 0n) openDays.push(dayId);
      });
    } catch (err) {
      console.warn(
        `[keeper] rewardBudgetRemit Base->${mirrorId} closure probe failed: ${(err as Error).message}`,
      );
      openDays.push(...ambiguous);
    }
  }
  if (openDays.length > 0) {
    // REPORTED, not folded into `deferred` (Codex #1924 r35). An open day here
    // is one of two things and this pass cannot tell them apart: an obligation
    // still gated (awaiting its commitment report, or unbacked), or a day that
    // simply gave this mirror no slice — the latter is never closed by
    // anything, so counting it as owed would hold coverage below A/A on every
    // tick until it left the scan window, and the stand-down would never be
    // reachable. That is the false-red the r34 fix introduced by treating both
    // as owed.
    //
    // So the ambiguity is surfaced rather than guessed at: the operator has
    // the day ids and can check whether any carries a real obligation. Same
    // shape as the other signals here — report what is observable, do not
    // infer what is not.
    console.warn(
      `[keeper] rewardBudgetRemit Base->${mirrorId} ${openDays.length} finalized day(s) neither remitted nor closed: ${openDays.join(',')} — gated obligation or zero budget for this mirror; verify before treating coverage as complete`,
    );
  }

  if (batch.length === 0) {
    if (deferred === 0) return true; // genuinely nothing actionable owed
    console.warn(
      `[keeper] rewardBudgetRemit Base->${mirrorId} no day fits laneCap=${laneCap} this tick — ${deferred} actionable day(s) still owed`,
    );
    return false;
  }

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
    return false;
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
    return false;
  }
  if (receipt.status !== 'success') {
    // Broadcast succeeded but the tx reverted on-chain (e.g. a manual/admin
    // remit or a pool-cap change won the race between quote and inclusion).
    console.warn(
      `[keeper] rewardBudgetRemit Base->${mirrorId} tx=${hash} REVERTED (status=${receipt.status}) — days re-evaluated next tick`,
    );
    return false;
  }
  console.log(
    `[keeper] rewardBudgetRemit Base->${mirrorId} days=${batch.length} total=${total} fee=${fee} tx=${hash}`,
  );
  if (deferred > 0) {
    // The send succeeded, but only for a PREFIX of the plan — the cap cut the
    // rest, and those finalized obligations are still unfunded. A successful
    // tx is not the same as a settled destination (Codex #1924 r20).
    console.warn(
      `[keeper] rewardBudgetRemit Base->${mirrorId} partial: ${deferred} actionable day(s) deferred to a later tick`,
    );
    return false;
  }
  // SOURCE-ACCEPTED, NOT DELIVERED (Codex #1924 r22).
  //
  // A successful Base receipt means CCIP accepted the message, not that the
  // mirror received it. `IncidentRunbook`'s reward-remittance section records
  // the failure mode explicitly: delivery can park or revert on the mirror —
  // a paused receiver, say — while the days are ALREADY marked remitted on
  // Base. The next tick cannot repair it (`remitRewardBudget` returns
  // `NothingToRemit` for those days); recovery is a manual CCIP
  // re-execution. So users on that mirror can have no claim backing while
  // this pass reports success.
  //
  // This function cannot observe the destination, so it does not claim to:
  // `true` here means "nothing left owed AT THE SOURCE". The stand-down
  // checklist owns the rest, and says so — mirror-side confirmation is a
  // separate check, not something the coverage counter can imply.
  return true;
}
