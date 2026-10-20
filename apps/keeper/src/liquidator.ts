/**
 * apps/keeper — autonomous liquidator pass.
 *
 * Splits the liquidation responsibility out of `runWatcher` (which is
 * now subscription-driven notifications only) into its own
 * comprehensive scan: every cron tick, per chain, **iterate ALL active
 * loans** — not just the subscribed-user subset the notification pass
 * walks — and submit `triggerLiquidation` for every one whose HF has
 * crossed 1.0. Pre-split (before this file), the keeper only ever
 * liquidated loans owned by users who had set up Telegram/Push
 * thresholds; a loan whose owner hadn't subscribed never got an HF
 * check and never got an autonomous liquidation attempt, relying on
 * third-party MEV bots to take the loss-share. That's a real gap as
 * the depth-tiered-LTV ramp raises borrow ceilings — a thinner
 * cushion at liquidation means the Vaipakam keeper needs to be the
 * one that catches every loan, not occasionally.
 *
 * Per tick, per chain:
 *   1. `getActiveLoansCount` (O(1)); short-circuit when zero.
 *   2. Page `getActiveLoansPaginated` for the full loan id list.
 *   3. **Batch-read `calculateHealthFactor` via Multicall3** — one
 *      eth_call per page of ids instead of N sequential eth_calls.
 *      Cuts the per-chain HF scan from `N × RPC_RTT` to one or two
 *      RPC roundtrips even on busy chains. Loans already seen to be
 *      illiquid are left out: they have no health factor and never
 *      gain one (#2579).
 *   4. Filter loans with `hf < 1e18` (autonomously liquidatable),
 *      sort ascending by HF — the most at-risk goes first when the
 *      per-tick submit cap is hit, so a thinner cushion still gets
 *      first claim on the keeper's gas budget.
 *   5. Attempt `triggerLiquidation` (via `maybeAutonomousLiquidate`)
 *      up to `MAX_LIQUIDATIONS_PER_TICK`. Losing the race to another
 *      keeper / MEV bot reverts the second tx — fine; the loan is
 *      liquidated either way.
 *
 * Gating: `isKeeperEnabled` only — same as the matcher / liquidity-
 * confidence relay. The watcher's notification pass stays unconditional.
 */

import { createPublicClient, http, type Abi, type Address } from 'viem';
import { classifyHfReadFailure, hasNoHealthFactorByDesign } from './hfRevert';
import { MetricsFacetABI, RiskFacetABI } from '@vaipakam/contracts/abis';
import type { ChainConfig, Env } from './env';
import type { PassTick } from './passSchedule';
import { batchedRead } from './batchRead';
import { HF_LIQUIDATION_THRESHOLD } from './hfLine';
import { getChainConfigs } from './env';
import { readCutoffMs, runIndex } from './runWindow';
import { pagedWalk } from './rotate';
import { maybeAutonomousLiquidate, passIsArmed, resetKeeperDedupe } from './keeper';
import { recordHfBandNotifications, type HfReading } from './hfBandNotifications';

const METRICS_ABI: Abi = MetricsFacetABI as Abi;
const RISK_ABI: Abi = RiskFacetABI as Abi;

/** Pagination size for `getActiveLoansPaginated`. */
const SCAN_PAGE = 200n;
/** Multicall batch size for `calculateHealthFactor` reads — keeps each
 *  HTTP body bounded while still folding a busy book into a handful of
 *  RPC roundtrips. */
const HF_MULTICALL_CHUNK = 100;
/** Hard cap on `triggerLiquidation` submissions per tick per chain —
 *  bounds the keeper EOA's gas budget so a sudden cluster of underwater
 *  loans can't burn the whole allowance in one cron pass. */
const MAX_LIQUIDATIONS_PER_TICK = 12;
/** HF below which the loan is autonomously liquidatable on-chain. Defined
 *  in `hfLine.ts`, which every pass that must agree on it imports. */
export { HF_LIQUIDATION_THRESHOLD } from './hfLine';

/**
 * Active loans known to revert `IlliquidLoanNoRiskMath`, per chain and
 * Diamond (#2579).
 *
 * Such a loan has no health factor and never will: `calculateHealthFactor`
 * refuses it from the liquidity of its two assets as STAMPED on the loan when
 * it opened (`collateralLiquidity` / `principalLiquidity`), and nothing writes
 * those stamps afterwards. So reading it again every tick only spends a read
 * on an answer already known, and the scan leaves it out once it is known.
 *
 * KNOWN MEANS FINAL (#2579 r1). The scan reads the latest block, which a
 * reorg can replace, and with it the loan that owned an id: the id can then
 * belong to a liquid loan. Skipping it on the strength of the orphaned
 * reading would hide that loan from liquidation for as long as the process
 * lives. So an id is remembered only once the chain's FINALIZED block also
 * says it is illiquid ({@link rememberIlliquidAtFinality}). A finalized
 * loan record cannot be replaced, and its stamps cannot change, so the fact
 * then holds for the life of the loan. Until then the loan is read every tick
 * like any other.
 *
 * Keyed by Diamond as well as chain because loan ids restart on a fresh
 * Diamond. Pruned to the active list whenever the whole list was read
 * (including an empty one), so a closed loan is forgotten. A restart forgets
 * everything, and the first scan after it learns the set again with one read
 * per illiquid loan. A zero-collateral rental (`InvalidLoan`) is NOT
 * remembered: it, too, has no health factor, but its reason is the loan's
 * current collateral amount rather than a stamp, so it is read each tick.
 */
const knownIlliquid = new Map<string, Set<bigint>>();

function knownIlliquidLoans(chainId: number, diamond: Address): Set<bigint> {
  const key = `${chainId}:${diamond.toLowerCase()}`;
  let set = knownIlliquid.get(key);
  if (set === undefined) {
    set = new Set();
    knownIlliquid.set(key, set);
  }
  return set;
}

export async function runLiquidator(env: Env, tick: PassTick): Promise<void> {
  if (!passIsArmed(env, 'liquidator')) return;
  // Reset the in-isolate dedupe set so a previously-attempted loan can
  // be retried this tick. Lived in `runWatcher` pre-split; lives here
  // now because this pass owns the liquidation surface.
  resetKeeperDedupe();
  // Two phases (Codex #1300 r1+r2): EVERY chain's scan + liquidation
  // submits complete first; the derived HF-band inbox writes (#1213 PR
  // 2b) run only after the whole liquidation sweep. The chain loop is
  // serial, so a D1 stall inside an earlier chain's band pass would
  // otherwise delay LATER chains' scans and submits — notification
  // storage must never sit anywhere on the liquidation critical path.
  //
  // Chains run side by side (#2572 r5, `runWindow.ts` rule 1): one deadline
  // covers the pass, so in series a slow chain would spend the window of every
  // chain after it. Each chain has its own RPC and its own nonce lane.
  const bandQueue: { chain: ChainConfig; readings: HfReading[] }[] = [];
  const run = runIndex(tick, 60_000);
  await Promise.all(
    getChainConfigs(env).map(async (chain) => {
      try {
        const readings = await liquidatePassForChain(env, chain, tick.deadlineMs, run);
        bandQueue.push({ chain, readings });
      } catch (err) {
        console.error(
          `[keeper] runLiquidator chain=${chain.name} err=${String(err).slice(0, 250)}`,
        );
      }
    }),
  );
  for (const { chain, readings } of bandQueue) {
    await hfBandPass(env, chain, readings);
  }
}

/** Scan + submit for one chain. Returns EVERY successful HF reading
 *  (empty on the early-exit paths) so `runLiquidator`'s second phase
 *  can run the HF-band inbox pass after ALL chains' submits — a
 *  zero-readings return still gets a prune-only band pass (Codex
 *  #1300 r1: the last at-risk loan closing is exactly when the active
 *  set goes empty). */
async function liquidatePassForChain(
  env: Env,
  chain: ChainConfig,
  /** This run's deadline (#2572): no liquidation is signed after it. */
  deadlineMs: number,
  /** This run's index ({@link runIndex}), which picks the page the scan starts at. */
  run = 0,
): Promise<HfReading[]> {
  // The scan stops here, leaving the liquidations it found time to be sent
  // (#2572 r5, `runWindow.ts` rule 3). A scan cut short acts on what it read
  // and is not reported complete.
  const readCutoff = readCutoffMs(deadlineMs);
  const client = createPublicClient({ transport: http(chain.rpc) });
  const diamond = chain.diamond as Address;

  // PIN THE WHOLE SCAN TO ONE BLOCK (Codex #1924 r20).
  //
  // `activeLoanIdsList` is maintained by swap-and-pop
  // (`LibMetricsHooks._removeFromActiveLoanList`): removing an entry moves the
  // LAST id into the freed slot. So if a loan on an earlier page closes while
  // we are paging, the tail loan moves backwards — behind the cursor — and is
  // never returned by any page. Every read succeeds, `pagesComplete` stays
  // true, and a still-active loan is silently missing from the scan. Reading
  // a mutable list across several calls does not produce a snapshot, however
  // healthy each individual call looks.
  //
  // One `eth_blockNumber` per chain per tick buys a consistent view for the
  // count, every page, and every HF read. It is an I/O wait rather than CPU,
  // so it does not work against #1896's budget.
  let pinnedBlock: bigint;
  try {
    pinnedBlock = await client.getBlockNumber();
  } catch (err) {
    console.error(
      `[keeper] liquidator chain=${chain.name} getBlockNumber failed: ${String(err).slice(0, 200)}`,
    );
    return [];
  }

  let total: bigint;
  try {
    total = (await client.readContract({
      address: diamond,
      abi: METRICS_ABI,
      functionName: 'getActiveLoansCount',
      blockNumber: pinnedBlock,
    })) as bigint;
  } catch (err) {
    console.error(
      `[keeper] liquidator chain=${chain.name} getActiveLoansCount failed: ${String(err).slice(0, 200)}`,
    );
    return [];
  }
  if (total === 0n) {
    // A healthy chain with nothing to do STILL emits completion (Codex #1924
    // r18). The stand-down checklist counts one line per resolved chain, so
    // suppressing it here would make a perfectly good chain indistinguishable
    // from an unscanned one and strand manual coverage indefinitely. The
    // count-read FAILURE above stays silent on purpose — that one genuinely
    // did not scan.
    // No active loan, so nothing remembered can still be active.
    knownIlliquidLoans(chain.id, diamond).clear();
    logScanComplete(chain, 0, 0, 0, 0);
    return [];
  }

  // Page the loan-id list.
  const ids: bigint[] = [];
  // A page failure breaks pagination but leaves earlier pages in `ids`, so
  // the scan continues over a PARTIAL loan set. That must not be reported as
  // complete: the loans in the pages never fetched were never checked, and
  // the stand-down checklist would let manual coverage stop over them
  // (Codex #1924 r18). Tracked explicitly rather than inferred from
  // `ids.length`, which is non-empty in exactly this case.
  let pagesComplete = true;
  // Loans in an order that starts at a loan that moves each run (#2572 r5/r7,
  // rule 2, `pagedWalk`), so a scan the cutoff stops early, in the paging or
  // in the HF reads below, still reaches every loan over successive runs. A
  // start that moved a page at a time left a page's tail unreached whenever a
  // run stopped inside its first page. Every page is read at the pinned
  // block, so the order does not change what a full scan sees.
  for (const { cursor: off, limit } of pagedWalk(total, SCAN_PAGE, run)) {
    if (Date.now() >= readCutoff) {
      console.log(
        `[keeper] liquidator chain=${chain.name} read cutoff reached during paging; acting on ${ids.length} loan(s) read, the rest next run`,
      );
      pagesComplete = false;
      break;
    }
    let page: readonly bigint[];
    try {
      page = (await client.readContract({
        address: diamond,
        abi: METRICS_ABI,
        functionName: 'getActiveLoansPaginated',
        args: [off, limit],
        blockNumber: pinnedBlock,
      })) as readonly bigint[];
    } catch (err) {
      console.error(
        `[keeper] liquidator chain=${chain.name} page off=${off} failed: ${String(err).slice(0, 200)}`,
      );
      pagesComplete = false;
      break;
    }
    if (page.length === 0) continue;
    ids.push(...page);
  }
  // Loans with no health factor by design are left out of the reads once
  // they are known to have none (#2579). See `knownIlliquidLoans`.
  const illiquid = knownIlliquidLoans(chain.id, diamond);
  if (pagesComplete) {
    // The whole active list was read, so a remembered id missing from it has
    // closed. Forget it, which keeps the memory the size of the live book.
    const active = new Set(ids);
    for (const id of illiquid) if (!active.has(id)) illiquid.delete(id);
  }
  if (ids.length === 0) {
    if (pagesComplete) logScanComplete(chain, 0, 0, 0, 0);
    return [];
  }
  const candidates = ids.filter((id) => !illiquid.has(id));

  // Batch-read HF via Multicall3 (deployed at the canonical address on
  // every viem-known chain), through the keeper's one batched reader, which
  // falls back to serial reads when the aggregate call itself is rejected.
  //
  // EVERY successful reading is kept (`readings`), not just the
  // liquidatable subset: the HF-band inbox pass (#1213 PR 2b) reuses
  // the full-book scan to detect 1.5/1.2/1.05 band crossings. Illiquid
  // loans revert `IlliquidLoanNoRiskMath` and land in the failure
  // bucket — exactly the design split (calendar rows cover them).
  const readings: HfReading[] = [];
  // Loans in the scan that have no health factor by design: the remembered
  // illiquid ones skipped above, plus any read this run that reverted for that
  // reason. Stated on the completion line so it accounts for every active loan.
  let noHealthFactor = ids.length - candidates.length;
  // Loans whose HF could not be evaluated for a reason that is NOT the
  // by-design illiquid revert. A short `readings` alone does not mean a gap —
  // illiquid loans revert `IlliquidLoanNoRiskMath` and are meant to land in
  // the failure bucket (calendar rows cover them). But an RPC-level failure
  // on a multicall entry, or in the serial fallback, means a RISK-BEARING
  // loan went unevaluated, and the completion marker must not claim the chain
  // was scanned (Codex #1924 r19).
  let unevaluated = 0;
  // Read illiquid at the scan's block but not yet known to be so at finality.
  const seenIlliquid: bigint[] = [];
  for (let i = 0; i < candidates.length; i += HF_MULTICALL_CHUNK) {
    if (Date.now() >= readCutoff) {
      // Unread rather than failed, so not counted as unevaluated; the scan
      // is simply not complete, and the moving walk start reaches them later.
      pagesComplete = false;
      console.log(
        `[keeper] liquidator chain=${chain.name} read cutoff reached during HF reads; ${candidates.length - i} loan(s) left for the next run`,
      );
      break;
    }
    const chunk = candidates.slice(i, i + HF_MULTICALL_CHUNK);
    const contracts = chunk.map((id) => ({
      address: diamond,
      abi: RISK_ABI,
      functionName: 'calculateHealthFactor' as const,
      args: [id] as const,
    }));
    // `batchedRead` owns the batching rules this pass used to carry inline
    // (#2579): the explicit Multicall3 address a chainless client needs
    // (#1946), one `aggregate3` per chunk (`batchSize: 0`, #1965 r2), and
    // telling a rejected aggregate from the entries' own reverts, including in
    // a one-entry chunk.
    const results = await batchedRead(
      client,
      contracts,
      `liquidator chain=${chain.name} chunk ${i}/${candidates.length}`,
      pinnedBlock,
    );
    for (let j = 0; j < chunk.length; j++) {
      const r = results[j];
      if (r.status === 'success' && typeof r.result === 'bigint') {
        readings.push({ id: chunk[j], hf: r.result });
        continue;
      }
      const kind = classifyHfReadFailure(r?.error);
      if (kind === 'illiquid') seenIlliquid.push(chunk[j]);
      // Illiquid, or a zero-collateral rental: no health factor by design,
      // so its absence from `readings` is the design working. Only the rest
      // is a gap in the scan.
      if (hasNoHealthFactorByDesign(kind)) noHealthFactor += 1;
      else unevaluated += 1;
    }
  }
  if (unevaluated > 0) {
    console.error(
      `[keeper] liquidator chain=${chain.name} ${unevaluated}/${ids.length} loan(s) unevaluated (HF read failed) — scan incomplete`,
    );
  }
  // Only while the read window lasts: a loan not remembered now is simply
  // read again next run.
  if (Date.now() < readCutoff) {
    await rememberIlliquidAtFinality(client, chain, diamond, seenIlliquid, illiquid);
  }

  const atRisk = readings.filter((r) => r.hf < HF_LIQUIDATION_THRESHOLD);
  if (atRisk.length === 0) {
    if (pagesComplete && unevaluated === 0) logScanComplete(chain, readings.length, 0, 0, noHealthFactor);
    return readings;
  }
  // Lowest HF first — the keeper's gas budget goes to the most-at-risk
  // loans first when the submit cap is hit.
  atRisk.sort((a, b) => (a.hf < b.hf ? -1 : 1));

  let submits = 0;
  for (const r of atRisk) {
    if (submits >= MAX_LIQUIDATIONS_PER_TICK) {
      console.log(
        `[keeper] liquidator chain=${chain.name} submit cap reached (${MAX_LIQUIDATIONS_PER_TICK})`,
      );
      break;
    }
    // #2572 — past the run's deadline, every send would be refused at its
    // turn anyway; stop asking for quotes and leave the rest, lowest health
    // factor first again, to the next run's fresh reads.
    if (Date.now() >= deadlineMs) {
      console.log(
        `[keeper] liquidator chain=${chain.name} run deadline reached; ${atRisk.length - atRisk.indexOf(r)} at-risk loan(s) left for the next run`,
      );
      break;
    }
    const submitted = await maybeAutonomousLiquidate(env, chain, r.id, r.hf, client, deadlineMs);
    if (submitted) submits += 1;
  }
  if (pagesComplete && unevaluated === 0) {
    logScanComplete(chain, readings.length, atRisk.length, submits, noHealthFactor);
  }
  return readings;
}

/**
 * Adds to `memory` the loans in `seen` that the chain's FINALIZED block also
 * says are illiquid (#2579 r1; see {@link knownIlliquid} for why only final
 * facts are kept).
 *
 * One block read and one batched health-factor read, and only for loans the
 * scan has just seen revert illiquid and does not yet remember, so it costs a
 * read per illiquid loan once per process rather than every tick. A loan opened
 * after the finalized block reverts `InvalidLoan` there and is not remembered;
 * it is confirmed on a later run. Any failure here remembers nothing, which
 * only means the loan is read again next run.
 */
async function rememberIlliquidAtFinality(
  client: ReturnType<typeof createPublicClient>,
  chain: ChainConfig,
  diamond: Address,
  seen: readonly bigint[],
  memory: Set<bigint>,
): Promise<void> {
  if (seen.length === 0) return;
  let finalized: bigint;
  try {
    const block = await client.getBlock({ blockTag: 'finalized' });
    if (block.number === null) return;
    finalized = block.number;
  } catch (err) {
    console.log(
      `[keeper] liquidator chain=${chain.name} finalized block unavailable; ${seen.length} illiquid loan(s) stay in the scan: ${String(err).slice(0, 200)}`,
    );
    return;
  }
  for (let i = 0; i < seen.length; i += HF_MULTICALL_CHUNK) {
    const chunk = seen.slice(i, i + HF_MULTICALL_CHUNK);
    const results = await batchedRead(
      client,
      chunk.map((id) => ({
        address: diamond,
        abi: RISK_ABI,
        functionName: 'calculateHealthFactor' as const,
        args: [id] as const,
      })),
      `liquidator chain=${chain.name} finality check ${i}/${seen.length}`,
      finalized,
    );
    for (let j = 0; j < chunk.length; j++) {
      const r = results[j];
      if (r?.status === 'failure' && classifyHfReadFailure(r.error) === 'illiquid') {
        memory.add(chunk[j]);
      }
    }
  }
}

/**
 * #1896 — POSITIVE evidence that this chain was actually scanned.
 *
 * Every other line this pass emits on the unhappy paths is a FAILURE marker,
 * and the failures are caught at four different depths — `getActiveLoansCount`,
 * a page fetch, a multicall chunk, and `runLiquidator`'s own per-chain catch.
 * Each returns or breaks, the pass finishes normally, and `timedPass` logs
 * `done in Nms` regardless. So "the tick looked clean" was never checkable by
 * absence: an operator would have to know the complete set of failure strings,
 * and that set grows silently whenever a new failure path is added. Three
 * successive attempts to write the stand-down condition as a list of markers
 * NOT to see were each incomplete (Codex #1924 r15, r16, r17).
 *
 * This line inverts it. One per chain, emitted only where the scan genuinely
 * completed, so the check becomes "count these against the resolved chain set"
 * — the same shape as the per-tick `chains resolved:` line, and verifiable
 * without knowing anything about how the pass can fail.
 */
function logScanComplete(
  chain: ChainConfig,
  scanned: number,
  atRisk: number,
  submitted: number,
  /** Active loans with no health factor by design (illiquid, or a
   *  zero-collateral rental), so `scanned + noHealthFactor` is the whole book. */
  noHealthFactor: number,
): void {
  // eslint-disable-next-line no-console
  console.log(
    `[keeper] liquidator chain=${chain.name} scan complete: scanned=${scanned} atRisk=${atRisk} submitted=${submitted} noHealthFactor=${noHealthFactor}`,
  );
}

/** Fail-open wrapper around the band pass — belt-and-braces on top of
 *  the module's own catch, so no failure shape can escape into the
 *  liquidator's per-chain error handling. */
async function hfBandPass(
  env: Env,
  chain: ChainConfig,
  readings: HfReading[],
): Promise<void> {
  try {
    // Both bindings, by name: band state is keeper-private (KEEPER_DB),
    // the inbox rows and the loans it resolves are shared (DB) — #2450.
    await recordHfBandNotifications(
      env,
      chain.id,
      readings,
      Math.floor(Date.now() / 1000),
    );
  } catch (err) {
    console.error(
      `[keeper] hf-band pass chain=${chain.name} failed (fail-open): ${String(err).slice(0, 200)}`,
    );
  }
}
