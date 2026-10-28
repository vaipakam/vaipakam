/**
 * apps/keeper — periodic-interest settler pass.
 *
 * Settles the overdue period of a periodic-interest loan by submitting the
 * permissionless `RepayPeriodicFacet.settlePeriodicInterest(loanId,
 * sellAmount, adapterCalls)` once the period's grace is over, so a lender on a cadence
 * loan is paid the period's interest even when nobody else calls it. The
 * contract's previews are the rule; nothing here re-derives grace, the
 * shortfall or the sale size.
 *
 * Two paths, as the contract has them:
 *
 *   - **Stamp** — the borrower already paid the period's interest
 *     (shortfall zero). The call only moves the checkpoint forward and
 *     resets the period's paid counter, with a zero sale size and an empty
 *     try-list. It pays the
 *     keeper nothing; it is sent so the period accounting does not fall
 *     behind the calendar.
 *   - **Sale** — a positive shortfall. The sale is sized by the contract to
 *     need (`ForcedSaleFacet.previewForcedSale(loanId, PeriodicSettlement)`,
 *     #2795): the least collateral whose worst-case proceeds cover the
 *     shortfall plus the largest charges. The contract accepts a sale size
 *     anywhere from that `sell` to the plan's `maxSell` (#2796); the route
 *     is quoted for the middle of that range (`forcedSaleQuoteAmount`, the
 *     rule the app and the other keeper passes share), and that amount is
 *     sent as the call's `sellAmount`. A preview with nothing to sell is not
 *     sent.
 *
 * Per run, bounded like the grace-default pass (one chain by turns, one
 * pinned window of its active list, one attempt):
 *
 *   1. The master switch (`getPeriodicInterestEnabled`): while it is off no
 *      period can be settled, and the run says so and stops.
 *   2. `previewPeriodicSettle` for each loan of the window at the pinned
 *      block; a loan on a cadence whose `canSettleNow` is true is due.
 *   3. One owner per loan. A loan that is under water belongs to the HF
 *      liquidator, and one past its maturity grace to the grace-default
 *      pass: each closes the whole loan, which settles the period too, and
 *      two passes deciding about one loan race two transactions. This pass
 *      leaves both alone, at the early read and again at the gate.
 *   4. The final gate, at ONE fresh block: the owner rule again, the plan
 *      again (a quote that has left the accepted range would revert
 *      `ForcedSaleQuoteOutOfRange`, and a period that turned from stamp to
 *      sale or back needs a different call), and a simulation of the exact
 *      call. The simulation is the authority:
 *      a settlement whose every route fails REVERTS (`PeriodicSettleSwapFailed`)
 *      rather than falling back, so a successful simulation is a sale that
 *      takes at that block.
 *   5. Submit in the account's submission slot. The receipt is not awaited;
 *      the next run's preview says whether it landed.
 *
 * What stays uncovered is the gap between the gate and inclusion: the
 * contract sizes the range again at inclusion. Quoting the middle of the
 * range leaves room either side for accrual and a small price move, but a
 * move large enough to take the quote out of the range makes the call
 * revert, costing the keeper the gas and moving nothing. No read from
 * off-chain closes it.
 *
 * Gated by KEEPER_ENABLED + PERIODIC_SETTLE_ENABLED. The pass sells a
 * borrower's collateral, so it gets its own flag and is dark until an owner
 * arms it.
 */

import {
  createPublicClient,
  encodeFunctionData,
  http,
  type Abi,
  type Address,
  type PublicClient,
  type WalletClient,
} from 'viem';
import {
  DefaultedFacetABI,
  DIAMOND_ABI_VIEM,
  NumeraireConfigFacetABI,
  RepayPeriodicFacetABI,
} from '@vaipakam/contracts/abis';
import { isRevert, revertErrorName } from '@vaipakam/lib/contractRevert';
import {
  FORCED_SALE_KIND,
  forcedSaleQuoteAccepted,
  forcedSaleQuoteAmount,
  readForcedSalePlan,
  readForcedSaleSurface,
  type ForcedSalePlan,
} from '@vaipakam/lib/routeBuilder';
import { describeFailure } from '@vaipakam/lib/errorDescription';
import type { AdapterCall } from '@vaipakam/lib/swapRoutes';
import type { ChainConfig, Env } from './env';
import { getChainConfigs } from './env';
import { buildKeeperContext, passIsArmed } from './keeper';
import { deadlineFetch, PastRunDeadline, readPhaseClient, settledChunkedRead } from './batchRead';
import { boundedCall } from './passReader';
import { readCutoffMs } from './runWindow';
import { createSubrequestBudget } from './subrequestBudget';
import { orchestrateServerQuotes, type ServerOrchestrationResult } from './serverQuotes';
import type { PassTick } from './passSchedule';
import { readActiveWindow, scanCutoffs, type ScanCutoffs, type ScanWindow } from './activeLoanWindow';
import { hfStanding, LEFT_TO_LIQUIDATOR, readLoan, readsBy, surfaceSkipReason, type GraceLoan, type Skipped } from './closeOut';
import { attemptErrorReason, keeperTxPending, sendInSubmissionSlot } from './keeperSend';
import { pickBatch } from './rotate';

const PERIODIC_ABI: Abi = RepayPeriodicFacetABI as Abi;
const DEFAULTED_ABI: Abi = DefaultedFacetABI as Abi;
const NUMERAIRE_CONFIG_ABI: Abi = NumeraireConfigFacetABI as Abi;

/** `previewPeriodicSettle` reads per aggregate, so one eth_call never grows
 *  with the active-loan count. */
const READ_CHUNK = 100;

/** Candidates attempted per run. A sale attempt costs about as much as a
 *  grace-default one (route build, quotes, gate reads, simulation, send). */
export const MAX_ATTEMPTS_PER_RUN = 1;

/** Requests one run may make, all told — a HARD cap on the run's transport,
 *  the grace-default pass's rule and figure (graceDefault.ts). A run that
 *  reaches it stops before sending and says so. */
export const SUBREQUEST_BUDGET = 40;

/** The pass's cadence, in seconds. The scheduler reads it from here, and the
 *  rotation moves one batch per run of it. Every loan this pass acts on is
 *  already past a grace window measured in days, so a quarter hour is not
 *  material; every 5-minute residue is already taken by a staggered pass. */
export const PASS_CADENCE_SEC = 15 * 60;
const ROTATION_STEP_MS = PASS_CADENCE_SEC * 1000;

/** `ForcedSaleFacet.ForcedSaleKind.PeriodicSettlement`. */
export const FORCED_SALE_KIND_PERIODIC = FORCED_SALE_KIND.PeriodicSettlement;

/** LibVaipakam.AssetType.ERC20. */
const ASSET_TYPE_ERC20 = 0;

export const LEFT_TO_GRACE_DEFAULT_PASS = 'loan-defaultable (left to the grace-default pass)';

/** The skip reason for a run the subrequest cap cut short. */
export const BUDGET_SPENT = `subrequest-budget-spent (cap ${SUBREQUEST_BUDGET}; tried again on a later visit)`;

export type { ForcedSalePlan };

/** What happened to one candidate — the log line, and what tests assert. */
export type PeriodicSettleOutcome =
  | { kind: 'submitted'; tx: string; path: 'stamp' | 'sale'; sell: bigint; calls: number }
  | { kind: 'unconfirmed'; tx: string; path: 'stamp' | 'sale'; sell: bigint; calls: number; reason: string }
  | { kind: 'skipped'; reason: string };

/** Everything one loan's attempt needs, injected so the decision is testable
 *  without an RPC. */
export interface PeriodicSettleDeps {
  client: PublicClient;
  wallet: WalletClient;
  diamond: Address;
  chainId: number;
  /** The run deadline (#2572), enforced at the send's turn. */
  notAfterMs: number;
  /** When the attempt's reads stop (`runWindow.ts` rule 3): the run deadline
   *  less the send reserve (`readCutoffMs`). */
  readCutoff: number;
  /** Builds the try-list for a sale of `sell` of the collateral, making no
   *  request (RPC or quote) at or after `cutoff`, the attempt's read cutoff. */
  buildRoute: (loan: GraceLoan, sell: bigint, cutoff: number) => Promise<ServerOrchestrationResult>;
}

export async function runPeriodicSettle(env: Env, tick: PassTick): Promise<void> {
  if (!passIsArmed(env, 'periodicSettle', 'PERIODIC_SETTLE_ENABLED')) return;
  const chains = getChainConfigs(env).filter((c) => c.diamond);
  if (chains.length === 0) return;
  // The tick's SCHEDULED time, not the clock, as in the grace-default pass:
  // a late delivery must not repeat or skip the previous run's work.
  const run = Math.floor((tick.scheduledTimeMs ?? Date.now()) / ROTATION_STEP_MS);
  const chain = chains[run % chains.length];
  const visit = Math.floor(run / chains.length);
  try {
    await processChain(env, chain, visit, tick.deadlineMs);
  } catch (err) {
    // Described, never stringified: a viem transport error carries the
    // request URL, and the RPC URLs carry API keys.
    console.error(`[keeper] periodicSettle chain=${chain.id} failed: ${describeFailure(err)}`);
  }
}

async function processChain(env: Env, chain: ChainConfig, visit: number, deadlineMs: number): Promise<void> {
  const budget = createSubrequestBudget(SUBREQUEST_BUDGET);
  const client = createPublicClient({
    transport: http(chain.rpc, { fetchFn: budget.fetch }),
  }) as PublicClient;
  const ctx = buildKeeperContext(env, chain, client, { notAfterMs: deadlineMs, fetchFn: budget.fetch });
  if (!ctx) return;
  const keeper = ctx.wallet.account?.address;
  if (!keeper) return;
  const spent = () => `requests=${budget.spent()}/${budget.limit}`;
  // The grace-default pass's stages (graceDefault.ts): the attempt's reads by
  // the read cutoff, the previews a stage reserve before, the window and the
  // master switch a stage reserve before those.
  const readCutoff = readCutoffMs(ctx.notAfterMs);

  let scan: Awaited<ReturnType<typeof findSettleable>>;
  try {
    scan = await findSettleable(client, ctx.diamond, chain.id, visit, scanCutoffs(readCutoff));
  } catch (err) {
    if (err instanceof PastRunDeadline) {
      console.log(`[keeper] periodicSettle chain=${chain.id} scan stopped: the active-loan window or the periodic-interest switch was not read by its stage cutoff ${spent()}`);
      return;
    }
    if (!budget.exhausted()) throw err;
    console.log(`[keeper] periodicSettle chain=${chain.id} scan stopped: ${BUDGET_SPENT} ${spent()}`);
    return;
  }
  if (scan.kind === 'disabled') {
    console.log(`[keeper] periodicSettle chain=${chain.id} periodic-interest-off (no period can be settled) ${spent()}`);
    return;
  }
  const { due, unread, window } = scan;
  const where = `chain=${chain.id} window=${window.index + 1}/${window.count} active=${window.total}`;
  if (unread.length > 0) {
    console.log(`[keeper] periodicSettle ${where} preview-unread loans=${unread.join(',')}`);
  }
  if (due.length === 0) {
    console.log(`[keeper] periodicSettle ${where} due=0 ${spent()}`);
    return;
  }

  const deps: PeriodicSettleDeps = {
    client,
    wallet: ctx.wallet,
    diamond: ctx.diamond,
    chainId: chain.id,
    notAfterMs: ctx.notAfterMs,
    readCutoff,
    // The route's reads and quotes are the attempt's: none starts past its cutoff.
    buildRoute: (loan, sell, cutoff) =>
      orchestrateServerQuotes(env, readPhaseClient(client, cutoff), {
        chainId: chain.id,
        diamond: ctx.diamond,
        sellToken: loan.collateralAsset,
        buyToken: loan.principalAsset,
        sellAmount: sell,
        txOrigin: keeper,
        fetchFn: deadlineFetch(budget.fetch, cutoff),
      }),
  };

  const { picked, deferred } = pickBatch(due, window.round, MAX_ATTEMPTS_PER_RUN);
  if (deferred.length > 0) {
    console.log(`[keeper] periodicSettle ${where} deferred-by-cap loans=${deferred.join(',')}`);
  }
  let attempted = 0;
  let submitted = 0;
  let unconfirmed = 0;
  for (const loanId of picked) {
    if (Date.now() >= readCutoff) {
      console.log(
        `[keeper] periodicSettle ${where} read cutoff reached; left for the next run loans=${picked.slice(picked.indexOf(loanId)).join(',')}`,
      );
      break;
    }
    attempted += 1;
    let outcome: PeriodicSettleOutcome;
    try {
      // eslint-disable-next-line no-await-in-loop
      outcome = await attemptPeriodicSettle(deps, loanId);
    } catch (err) {
      outcome = { kind: 'skipped', reason: attemptErrorReason(err) };
    }
    if (budget.exhausted() && outcome.kind === 'skipped') {
      outcome = { kind: 'skipped', reason: BUDGET_SPENT };
    }
    const sized = (o: { path: string; sell: bigint; calls: number }) =>
      `path=${o.path} sell=${o.sell} calls=${o.calls}`;
    if (outcome.kind === 'submitted') {
      submitted += 1;
      console.log(`[keeper] periodicSettle chain=${chain.id} loan=${loanId} submitted tx=${outcome.tx} ${sized(outcome)}`);
    } else if (outcome.kind === 'unconfirmed') {
      unconfirmed += 1;
      console.log(
        `[keeper] periodicSettle chain=${chain.id} loan=${loanId} send-unconfirmed tx=${outcome.tx} ${sized(outcome)}: ${outcome.reason} — may or may not have been broadcast; later runs hold while it is pending`,
      );
    } else {
      console.log(`[keeper] periodicSettle chain=${chain.id} loan=${loanId} skipped: ${outcome.reason}`);
    }
  }
  console.log(
    `[keeper] periodicSettle ${where} due=${due.length} picked=${picked.length} attempted=${attempted} submitted=${submitted} unconfirmed=${unconfirmed} ${spent()}`,
  );
}

/**
 * The window's loans whose period may be settled now, everything read at
 * one pinned block: on a cadence, and `canSettleNow` (Active, the period's
 * grace over). `disabled` when the master switch is off, since no period
 * can be settled then whatever the previews say. The window and the switch
 * are read by `cutoffs.window` or not at all (`PastRunDeadline`); the
 * previews stop at `cutoffs.reads`, keeping the chunks they finished, and a
 * loan whose chunk was not read is reported unread.
 */
export async function findSettleable(
  client: PublicClient,
  diamond: Address,
  chainId: number,
  visit: number,
  cutoffs: ScanCutoffs,
): Promise<
  | { kind: 'disabled' }
  | { kind: 'scanned'; due: bigint[]; unread: bigint[]; window: ScanWindow }
> {
  const { ids, blockNumber, window } = await readActiveWindow(client, diamond, visit, cutoffs.window);
  const enabled = (await boundedCall(cutoffs.window, 'the periodic-interest switch', () =>
    client.readContract({
      address: diamond,
      abi: NUMERAIRE_CONFIG_ABI,
      functionName: 'getPeriodicInterestEnabled',
      blockNumber,
    }),
  )) as boolean;
  if (!enabled) return { kind: 'disabled' };
  // No serial retry, for the scan's bound (graceDefault.ts): a chunk not read
  // is reported unread and read again on a later visit, which starts at a
  // different chunk (the window's own visit count).
  const results = await settledChunkedRead(
    client,
    ids,
    READ_CHUNK,
    (id) => ({ address: diamond, abi: PERIODIC_ABI, functionName: 'previewPeriodicSettle', args: [id] }),
    `periodicSettle chain=${chainId} previewPeriodicSettle`,
    cutoffs.reads,
    window.round,
    blockNumber,
  );
  const due: bigint[] = [];
  const unread: bigint[] = [];
  for (const id of ids) {
    const r = results.get(id);
    if (r?.status !== 'success') {
      unread.push(id);
      continue;
    }
    // (cadence, periodEndAt, graceEndsAt, expected, paidByBorrower, shortfall, canSettleNow)
    const row = r.result as readonly [number, bigint, bigint, bigint, bigint, bigint, boolean];
    if (Number(row[0]) !== 0 && row[6] === true) due.push(id);
  }
  return { kind: 'scanned', due, unread, window };
}

/** One loan: owner rule, plan, route, final gate (owner rule, plan,
 *  simulation), submit. Never sends when a step cannot establish its answer,
 *  and reads nothing past the run's read cutoff. */
export async function attemptPeriodicSettle(
  deps: PeriodicSettleDeps,
  loanId: bigint,
): Promise<PeriodicSettleOutcome> {
  const judged = await readsBy(deps.readCutoff, deps.client, (reads) => judgePeriodicSettle(deps, reads, loanId));
  if (judged.kind === 'skipped') return judged;
  const { path, sell, calls } = judged;
  const sent = await sendInSubmissionSlot(
    deps.wallet,
    deps.chainId,
    deps.notAfterMs,
    deps.diamond,
    encodeFunctionData({ abi: PERIODIC_ABI, functionName: 'settlePeriodicInterest', args: [loanId, sell, calls] }),
  );
  return sent.kind === 'submitted'
    ? { kind: 'submitted', tx: sent.tx, path, sell, calls: calls.length }
    : { kind: 'unconfirmed', tx: sent.tx, path, sell, calls: calls.length, reason: sent.reason };
}

/** A settlement the reads judged sendable, and what it was judged on. */
interface JudgedSettle {
  kind: 'send';
  path: 'stamp' | 'sale';
  sell: bigint;
  calls: readonly AdapterCall[];
}

/** The attempt's read phase: owner rule, plan, route, final gate. Every read
 *  goes through `client`, the cutoff-bound one `readsBy` gives. */
async function judgePeriodicSettle(
  deps: PeriodicSettleDeps,
  client: PublicClient,
  loanId: bigint,
): Promise<JudgedSettle | Skipped> {
  const { wallet, diamond } = deps;
  const keeper = wallet.account?.address;
  if (!keeper) return { kind: 'skipped', reason: 'no-keeper-account' };

  // A send from an earlier run may still be unmined; the period then still
  // reads due, and a second settlement would revert once the first lands.
  const pending = await keeperTxPending(client, keeper);
  if (pending !== null) return { kind: 'skipped', reason: pending };

  const early = await ownerVerdict(client, diamond, loanId);
  if (early !== null) return { kind: 'skipped', reason: early };

  // A Diamond deployed before #2796 (the live testnets, until the
  // all-waves fresh deploy) has no plan and no sized settlement, so this
  // pass sends nothing there.
  let surface;
  try {
    surface = await readForcedSaleSurface({ client, diamond });
  } catch (err) {
    return { kind: 'skipped', reason: surfaceSkipReason(err) };
  }
  if (surface !== 'sized') return { kind: 'skipped', reason: 'surface=whole (a pre-#2796 Diamond has no sized settlement)' };

  const loan = await readLoan(client, diamond, loanId);
  const plan = await readPlan(client, diamond, loanId);

  let calls: readonly AdapterCall[] = [];
  let routeNote = '';
  // A stamp sells nothing; a sale sells the middle of the accepted range.
  let sell = 0n;
  if (plan.debt > 0n) {
    const quoted = forcedSaleQuoteAmount(plan);
    if (quoted === null) return { kind: 'skipped', reason: 'plan-sells-nothing' };
    sell = quoted;
    if (loan.collateralAssetType !== ASSET_TYPE_ERC20 || loan.assetType !== ASSET_TYPE_ERC20) {
      // The contract demands a try-list on a positive shortfall, and a swap
      // exists only between two ERC-20s.
      return { kind: 'skipped', reason: 'not-swappable (shortfall needs an ERC-20 to ERC-20 sale)' };
    }
    const route = await deps.buildRoute(loan, sell, deps.readCutoff);
    calls = route.calls;
    if (route.failed.length > 0) routeNote = ` (failed: ${route.failed.join(',')})`;
    if (calls.length === 0) {
      return { kind: 'skipped', reason: `no-route sell=${sell}${routeNote}` };
    }
  }
  const path: 'stamp' | 'sale' = plan.debt > 0n ? 'sale' : 'stamp';

  // THE FINAL GATE, pinned to one fresh block.
  const gateBlock = await client.getBlockNumber({ cacheTime: 0 });
  const [lateOwner, latePlan] = await Promise.all([
    ownerVerdict(client, diamond, loanId, gateBlock),
    readPlan(client, diamond, loanId, gateBlock),
  ]);
  if (lateOwner !== null) return { kind: 'skipped', reason: `gate:${lateOwner}` };
  if ((latePlan.debt > 0n) !== (path === 'sale')) {
    // A stamp became a sale or a sale a stamp: the call built is the wrong one.
    return { kind: 'skipped', reason: `gate:plan-changed (debt ${plan.debt}->${latePlan.debt})` };
  }
  if (path === 'sale' && !forcedSaleQuoteAccepted(latePlan, sell)) {
    // The range moves with accrual and price; a quote that has left it
    // would revert `ForcedSaleQuoteOutOfRange`, so it is quoted again next run.
    return {
      kind: 'skipped',
      reason: `gate:quote-out-of-range quoted=${sell} range=[${latePlan.sell},${latePlan.maxSell}]`,
    };
  }
  try {
    await client.simulateContract({
      address: diamond,
      abi: DIAMOND_ABI_VIEM,
      functionName: 'settlePeriodicInterest',
      args: [loanId, sell, calls],
      account: keeper,
      blockNumber: gateBlock,
    });
  } catch (err) {
    const name = revertErrorName(err);
    const why = name ?? (isRevert(err) ? 'reverted' : describeFailure(err));
    return { kind: 'skipped', reason: `gate:simulation ${why} path=${path} calls=${calls.length}${routeNote}` };
  }
  return { kind: 'send', path, sell, calls };
}

/** Null when the loan is this pass's to settle; otherwise whose it is. */
async function ownerVerdict(
  client: PublicClient,
  diamond: Address,
  loanId: bigint,
  blockNumber?: bigint,
): Promise<string | null> {
  const [hf, defaultable] = await Promise.all([
    hfStanding(client, diamond, loanId, blockNumber),
    readDefaultable(client, diamond, loanId, blockNumber),
  ]);
  if (typeof hf === 'object') return `hf-unread:${hf.unread}`;
  if (hf === 'under-water') return LEFT_TO_LIQUIDATOR;
  if (typeof defaultable === 'object') return `defaultable-unread:${defaultable.unread}`;
  return defaultable ? LEFT_TO_GRACE_DEFAULT_PASS : null;
}

async function readDefaultable(
  client: PublicClient,
  diamond: Address,
  loanId: bigint,
  blockNumber?: bigint,
): Promise<boolean | { unread: string }> {
  try {
    return (await client.readContract({
      address: diamond,
      abi: DEFAULTED_ABI,
      functionName: 'isLoanDefaultable',
      args: [loanId],
      blockNumber,
    })) as boolean;
  } catch (err) {
    return { unread: describeFailure(err) };
  }
}

/** The contract's sale range for this period; all zero when no sale is
 *  due. A missing price makes it revert, as the sale itself would. */
export async function readPlan(
  client: PublicClient,
  diamond: Address,
  loanId: bigint,
  blockNumber?: bigint,
): Promise<ForcedSalePlan> {
  return readForcedSalePlan({ client, diamond, loanId, kind: FORCED_SALE_KIND_PERIODIC, blockNumber });
}
