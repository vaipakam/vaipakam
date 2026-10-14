/**
 * apps/keeper — time-based default pass (#2483).
 *
 * Closes out loans whose grace period has ended by submitting the
 * permissionless `DefaultedFacet.triggerDefault(loanId, adapterCalls)`, so a
 * lender who never opens the app is still closed out and only has to claim.
 * The lender's close-out card (#2474) sends the same transaction; this pass
 * applies the card's rules rather than a second set of its own.
 *
 * Per run — bounded, because the invocation's 50-subrequest allowance is
 * shared by every chain and every pass the tick launches:
 *
 *   1. ONE chain, taking turns by run index. Pin one block and read one
 *      SCAN_WINDOW of its active list at it; a larger book is walked a
 *      window per visit. Swap-and-pop on the active list can skip a loan
 *      mid-pagination when the scan spans blocks — the liquidator's reason
 *      for pinning, and the same here.
 *   2. Batch-read `isLoanDefaultable` at that block. The contract's own view
 *      is the eligibility rule; nothing here re-derives grace arithmetic.
 *   3. MAX_ATTEMPTS_PER_RUN candidates from the window, successive visits
 *      to it taking successive ones, so a loan that never closes cannot
 *      hold the front of the queue (`pickBatch`). All of it is derived from
 *      the scheduled tick, so nothing persists between isolates:
 *        a. Not the liquidator's. A loan that is also under water belongs
 *           to the HF liquidator, wholly — it runs every tick from the same
 *           keeper account, and two passes each deciding whether to close
 *           one loan race two terminal transactions however the decision
 *           is split. This pass does not act on it at all (#2487 tracks the
 *           collapsed, unquotable case the liquidator does not yet close).
 *        b. The sale interlock (#2078): `triggerDefault` does not inspect
 *           sale linkage, so closing a loan after a buyer accepted its
 *           lender-position sale strands the buyer's principal. An accepted
 *           sale, or a sale state the chain does not establish, skips.
 *        c. The try-list. Liquid ERC-20 collateral for an ERC-20 loan is
 *           quoted through the shared route builder for the loan's whole
 *           collateral. Anything else sends an empty list and lets the
 *           contract take its in-kind branch, or refuse.
 *        d. The final gate, everything at ONE fresh block: the health
 *           factor still on the side of the line step a judged it on, the
 *           sale state again, the collateral amount the quotes were made
 *           for (#2472 — after a top-up the adapter sells only the quoted
 *           amount and the rest lands in no one's claim), and the preview.
 *           `previewCloseOut` runs the call on `eth_simulateV1` and
 *           reads its logs, because a plain simulation SUCCEEDS into the
 *           full-collateral fallback when every route fails. Only a `sale`
 *           or an `other` ending (in-kind, collapsed LTV, internal match,
 *           rental) is sent. A route that would fall back is not: the spec
 *           wants a liquid forced close to make a real market attempt, and
 *           a route already known to fail is not one. The preview is in
 *           the gate, not before it, so the route is judged at the block
 *           the other reads are.
 *        e. Submit. The receipt is not awaited; the next tick's
 *           `isLoanDefaultable` read is what says whether it landed.
 *
 * Every defaultable loan is named in the log — attempted (with what
 * happened to it), deferred to a later batch, or unread — so `wrangler tail`
 * says why a past-grace loan is still Active.
 *
 * What stays uncovered is the gap between the final gate and inclusion: no
 * read from off-chain closes it. The on-chain guards that would are #2078
 * and #2472.
 *
 * Gated by KEEPER_ENABLED + GRACE_DEFAULT_ENABLED. The pass moves a
 * borrower's collateral, so it gets its own flag rather than riding the
 * keeper-wide one, and it is dark until that flag is armed.
 */

import {
  createPublicClient,
  encodeFunctionData,
  http,
  keccak256,
  type Abi,
  type Address,
  type PublicClient,
  type WalletClient,
  zeroAddress,
} from 'viem';
import {
  DefaultedFacetABI,
  DiamondLoupeFacetABI,
  LoanFacetABI,
  MetricsFacetABI,
  RiskFacetABI,
} from '@vaipakam/contracts/abis';
import { isRevert } from '@vaipakam/lib/contractRevert';
import { describeFailure } from '@vaipakam/lib/errorDescription';
import { previewCloseOut, type CloseOutPreview } from '@vaipakam/lib/routeBuilder';
import {
  BOUNDED_LISTING_SELECTOR,
  probeSaleHoldLive,
  saleHoldBlocksSettlement,
  type SaleListingHoldState,
} from '@vaipakam/lib/saleHold';
import type { AdapterCall } from '@vaipakam/lib/swapRoutes';
import type { ChainConfig, Env } from './env';
import { getChainConfigs } from './env';
import { buildKeeperContext, passIsArmed } from './keeper';
import { batchedRead } from './batchRead';
import { createSubrequestBudget, SubrequestBudgetExhausted } from './subrequestBudget';
import { HF_LIQUIDATION_THRESHOLD } from './liquidator';
import { orchestrateServerQuotes, type ServerOrchestrationResult } from './serverQuotes';
import type { PassTick } from './passSchedule';

const DEFAULTED_ABI: Abi = DefaultedFacetABI as Abi;
const LOUPE_ABI: Abi = DiamondLoupeFacetABI as Abi;
const LOAN_ABI: Abi = LoanFacetABI as Abi;
const METRICS_ABI: Abi = MetricsFacetABI as Abi;
const RISK_ABI: Abi = RiskFacetABI as Abi;

/** Pagination size for `getActiveLoansPaginated`. */
const SCAN_PAGE = 200n;

/** Active-list ids one run scans: two pages and four eligibility
 *  aggregates, so a run's scan costs at most eight subrequests (block,
 *  count, pages, aggregates) however large the book. A larger book is
 *  walked a window per visit. */
export const SCAN_WINDOW = 400;

/** `isLoanDefaultable` reads per aggregate — the liquidator's HF chunk size,
 *  so one eth_call never grows with the active-loan count. */
const READ_CHUNK = 100;

/** Candidates attempted per run. One attempt costs about eighteen
 *  requests plus two per enabled swap adapter (the roster is read one
 *  adapter at a time) plus the aggregator quotes. The CPU bench measures 28
 *  for a whole run (scan included) with three adapters. A longer roster can
 *  push an attempt past {@link SUBREQUEST_BUDGET}; the cap then stops it
 *  before the send. */
export const MAX_ATTEMPTS_PER_RUN = 1;

/** Requests one run may make, all told: the scan, the attempt (its route
 *  build and quotes included) and the send. A HARD cap, enforced on the
 *  run's transport rather than estimated per input: the inputs that drive
 *  cost (chains, the book, governance's adapter roster) are not this pass's
 *  to bound, and three review rounds found three of them. A run that
 *  reaches it stops before sending and says so; the loan is tried again on
 *  a later visit.
 *
 *  What it bounds is THIS pass's share. The invocation's 50 are shared by
 *  every pass due on the tick, and the other passes' requests are not
 *  counted here, so this cap cannot keep the invocation as a whole under
 *  the ceiling; the CPU bench shows several existing passes past it on
 *  their own. One budget per invocation, shared by every due pass, is
 *  #2490. */
export const SUBREQUEST_BUDGET = 40;

/** The pass's cadence, in ms — the rotation moves one batch per run.
 *  Mirrors `cadenceMinutes` in passSchedule.ts. */
const ROTATION_STEP_MS = 5 * 60_000;

/** LibVaipakam.AssetType.ERC20. */
const ASSET_TYPE_ERC20 = 0;

/** The loan fields this pass reads. */
export interface GraceLoan {
  assetType: number;
  collateralAssetType: number;
  collateralAsset: Address;
  collateralAmount: bigint;
  principalAsset: Address;
  lenderTokenId: bigint;
}

/** What happened to one candidate — the log line, and what tests assert. */
export type GraceDefaultOutcome =
  // `preview` is the ending the chain showed — `sale` is the only one that
  // swaps — and `calls` is the try-list sent, which an `other` ending (an
  // internal match, an in-kind close) may not use at all.
  | { kind: 'submitted'; tx: string; preview: CloseOutPreview; calls: number }
  // The signed transaction went to the RPC and no answer came back: it may
  // be in the mempool or may never have arrived. `tx` is its hash, computed
  // locally from the signed bytes, so an operator can look it up; the
  // next run's pending-transaction check settles it on-chain either way.
  | { kind: 'unconfirmed'; tx: string; preview: CloseOutPreview; calls: number; reason: string }
  | { kind: 'skipped'; reason: string };

/** Everything one loan's attempt needs, injected so the decision is
 *  testable without an RPC. */
export interface GraceDefaultDeps {
  client: PublicClient;
  wallet: WalletClient;
  diamond: Address;
  chainId: number;
  /** Builds the try-list for a sale of the loan's whole collateral. */
  buildRoute: (loan: GraceLoan) => Promise<ServerOrchestrationResult>;
}

export async function runGraceDefault(env: Env, tick?: PassTick): Promise<void> {
  if (!passIsArmed(env, 'graceDefault', 'GRACE_DEFAULT_ENABLED')) return;
  const chains = getChainConfigs(env).filter((c) => c.diamond);
  if (chains.length === 0) return;

  // The rotation reads the tick's SCHEDULED time, not the clock: a late
  // delivery must not land on the previous run's index and repeat its work
  // (or skip some). Only an invocation that is not a cron tick reads the
  // clock.
  const run = Math.floor((tick?.scheduledTimeMs ?? Date.now()) / ROTATION_STEP_MS);

  // ONE chain per run, and a bounded window of its active list: the
  // subrequest allowance is the invocation's — shared by every chain and
  // every pass the tick launches — so neither the number of chains nor the
  // size of a book may grow what one run costs. Chains take turns; on its
  // turn a chain's next window is scanned; within a window, successive
  // visits take successive candidates. Stateless: everything is derived
  // from the run index, so nothing persists between isolates.
  const chain = chains[run % chains.length];
  const visit = Math.floor(run / chains.length);
  try {
    await processChain(env, chain, visit);
  } catch (err) {
    // Described, never stringified: a viem transport error carries the
    // request URL, and this Worker's RPC URLs carry API keys.
    console.error(`[keeper] graceDefault chain=${chain.id} failed: ${describeFailure(err)}`);
  }
}

async function processChain(env: Env, chain: ChainConfig, visit: number): Promise<void> {
  // Every request below goes through this one budget — reads, quotes and
  // the wallet's send alike.
  const budget = createSubrequestBudget(SUBREQUEST_BUDGET);
  const client = createPublicClient({
    transport: http(chain.rpc, { fetchFn: budget.fetch }),
  }) as PublicClient;
  const ctx = buildKeeperContext(env, chain, client, budget.fetch);
  if (!ctx) return;
  const keeper = ctx.wallet.account?.address;
  if (!keeper) return;
  const spent = () => `requests=${budget.spent()}/${budget.limit}`;

  let scan: Awaited<ReturnType<typeof findDefaultable>>;
  try {
    scan = await findDefaultable(client, ctx.diamond, chain.id, visit);
  } catch (err) {
    if (!budget.exhausted()) throw err;
    console.log(`[keeper] graceDefault chain=${chain.id} scan stopped: ${BUDGET_SPENT} ${spent()}`);
    return;
  }
  const { defaultable: candidates, unread, window } = scan;
  const where = `chain=${chain.id} window=${window.index + 1}/${window.count} active=${window.total}`;
  if (unread.length > 0) {
    // Unread is not "not defaultable": name them, so a loan missing from the
    // attempts below is not mistaken for one the chain ruled out.
    console.log(`[keeper] graceDefault ${where} eligibility-unread loans=${unread.join(',')}`);
  }
  if (candidates.length === 0) {
    console.log(`[keeper] graceDefault ${where} defaultable=0`);
    return;
  }

  const deps: GraceDefaultDeps = {
    client,
    wallet: ctx.wallet,
    diamond: ctx.diamond,
    chainId: chain.id,
    buildRoute: (loan) =>
      orchestrateServerQuotes(env, client, {
        chainId: chain.id,
        diamond: ctx.diamond,
        sellToken: loan.collateralAsset,
        buyToken: loan.principalAsset,
        sellAmount: loan.collateralAmount,
        txOrigin: keeper,
        fetchFn: budget.fetch,
      }),
  };

  // This window's visit count, so each visit to it takes the next batch.
  const round = Math.floor(visit / window.count);
  const { picked, deferred } = pickBatch(candidates, round, MAX_ATTEMPTS_PER_RUN);
  if (deferred.length > 0) {
    // Named, not just counted: an operator asking why one loan is still
    // Active must be able to tell "waiting its turn" from "never seen".
    console.log(`[keeper] graceDefault ${where} deferred-by-cap loans=${deferred.join(',')}`);
  }
  let submitted = 0;
  let unconfirmed = 0;
  for (const loanId of picked) {
    let outcome: GraceDefaultOutcome;
    try {
      // eslint-disable-next-line no-await-in-loop
      outcome = await attemptGraceDefault(deps, loanId);
    } catch (err) {
      outcome = { kind: 'skipped', reason: `error:${describeFailure(err)}` };
    }
    // Whatever step the cap interrupted — a read that threw, or a route
    // build that swallowed its failures and came back empty — the attempt
    // was cut short, and that is what the log says. Nothing was sent: the
    // send would have needed a request the budget refused.
    if (budget.exhausted() && outcome.kind === 'skipped') {
      outcome = { kind: 'skipped', reason: BUDGET_SPENT };
    }
    if (outcome.kind === 'submitted') {
      submitted += 1;
      console.log(
        `[keeper] graceDefault chain=${chain.id} loan=${loanId} submitted tx=${outcome.tx} preview=${outcome.preview} calls=${outcome.calls}`,
      );
    } else if (outcome.kind === 'unconfirmed') {
      unconfirmed += 1;
      console.log(
        `[keeper] graceDefault chain=${chain.id} loan=${loanId} send-unconfirmed tx=${outcome.tx} preview=${outcome.preview} calls=${outcome.calls}: ${outcome.reason} — may or may not have been broadcast; later runs hold while it is pending`,
      );
    } else {
      console.log(
        `[keeper] graceDefault chain=${chain.id} loan=${loanId} skipped: ${outcome.reason}`,
      );
    }
  }
  console.log(
    `[keeper] graceDefault ${where} defaultable=${candidates.length} attempted=${picked.length} submitted=${submitted} unconfirmed=${unconfirmed} ${spent()}`,
  );
}

/** The skip reason for a run the subrequest cap cut short. */
export const BUDGET_SPENT = `subrequest-budget-spent (cap ${SUBREQUEST_BUDGET}; tried again on a later visit)`;

/** Where a scan looked: window `index` of `count` over `total` active loans. */
export interface ScanWindow {
  index: number;
  count: number;
  total: number;
}

/** Active loans past grace within one SCAN_WINDOW of the active list,
 *  everything read at one pinned block. `visit` picks the window, so
 *  successive visits walk the list and wrap. */
export async function findDefaultable(
  client: PublicClient,
  diamond: Address,
  chainId: number,
  visit = 0,
): Promise<{ defaultable: bigint[]; unread: bigint[]; window: ScanWindow }> {
  const blockNumber = await client.getBlockNumber({ cacheTime: 0 });
  const total = (await client.readContract({
    address: diamond,
    abi: METRICS_ABI,
    functionName: 'getActiveLoansCount',
    blockNumber,
  })) as bigint;
  const count = Math.max(1, Math.ceil(Number(total) / SCAN_WINDOW));
  const index = visit % count;
  const window: ScanWindow = { index, count, total: Number(total) };
  const from = BigInt(index * SCAN_WINDOW);
  const to = from + BigInt(SCAN_WINDOW) < total ? from + BigInt(SCAN_WINDOW) : total;

  const ids: bigint[] = [];
  for (let cursor = from; cursor < to; cursor += SCAN_PAGE) {
    const limit = cursor + SCAN_PAGE > to ? to - cursor : SCAN_PAGE;
    // eslint-disable-next-line no-await-in-loop
    const page = (await client.readContract({
      address: diamond,
      abi: METRICS_ABI,
      functionName: 'getActiveLoansPaginated',
      args: [cursor, limit],
      blockNumber,
    })) as bigint[];
    ids.push(...page);
  }
  const results: Awaited<ReturnType<typeof batchedRead>> = [];
  for (let i = 0; i < ids.length; i += READ_CHUNK) {
    // eslint-disable-next-line no-await-in-loop
    const part = await batchedRead(
      client,
      ids.slice(i, i + READ_CHUNK).map((id) => ({
        address: diamond,
        abi: DEFAULTED_ABI,
        functionName: 'isLoanDefaultable',
        args: [id],
      })),
      `graceDefault chain=${chainId} isLoanDefaultable`,
      blockNumber,
      // No serial retry: it would cost one subrequest per id, up to
      // SCAN_WINDOW of them, and break the scan's bound. A failed chunk is
      // reported as eligibility-unread and is read again on a later visit.
      'unread',
    );
    results.push(...part);
  }
  const defaultable: bigint[] = [];
  const unread: bigint[] = [];
  results.forEach((r, i) => {
    if (r.status !== 'success') unread.push(ids[i]);
    else if (r.result === true) defaultable.push(ids[i]);
  });
  return { defaultable, unread, window };
}

/** The candidates starting at `step mod length`. */
export function rotate<T>(items: readonly T[], step: number): T[] {
  if (items.length === 0) return [];
  const start = ((step % items.length) + items.length) % items.length;
  return [...items.slice(start), ...items.slice(0, start)];
}

/** This run's batch: `width` candidates starting `run × width` along the
 *  list, so consecutive runs take consecutive, non-overlapping batches and
 *  every candidate is attempted within ⌈length ÷ width⌉ runs while the set
 *  holds steady. Stateless, so nothing has to persist between isolates; a
 *  set that changes between runs can shift a loan by a batch, which delays
 *  it by a run rather than skipping it for good. */
export function pickBatch<T>(
  items: readonly T[],
  run: number,
  width: number,
): { picked: T[]; deferred: T[] } {
  if (items.length <= width) return { picked: [...items], deferred: [] };
  const ordered = rotate(items, run * width);
  return { picked: ordered.slice(0, width), deferred: ordered.slice(width) };
}

/** One loan: interlock, route, preview, final gate, submit. Never sends
 *  when any step cannot establish its answer. */
export async function attemptGraceDefault(
  deps: GraceDefaultDeps,
  loanId: bigint,
): Promise<GraceDefaultOutcome> {
  const { client, wallet, diamond } = deps;
  const keeper = wallet.account?.address;
  if (!keeper) return { kind: 'skipped', reason: 'no-keeper-account' };

  // A send from an earlier run may still be pending — on this loan, or on
  // another pass's. The loan then still reads Active and defaultable, and a
  // second `triggerDefault` would queue behind the first only to revert once
  // it lands. Nothing persists between runs, so the chain is asked: while
  // the keeper's pending nonce is ahead of its mined one, this run waits.
  const [pendingNonce, minedNonce] = await Promise.all([
    client.getTransactionCount({ address: keeper, blockTag: 'pending' }),
    client.getTransactionCount({ address: keeper, blockTag: 'latest' }),
  ]);
  if (pendingNonce > minedNonce) {
    return { kind: 'skipped', reason: `keeper-tx-pending (${pendingNonce - minedNonce} unmined)` };
  }

  const loan = await readLoan(client, diamond, loanId);

  // ONE OWNER PER LOAN. A past-grace loan that is also under water belongs
  // to the liquidator, wholly: it runs every tick from the same keeper
  // account, and two passes each deciding for themselves whether to close
  // one loan race two terminal transactions however the decision is split.
  // An earlier revision let this pass make the no-swap close for a
  // collapsed loan the liquidator had no route for; it could not know
  // whether the liquidator had found one, and every narrowing of that
  // exception left the same race (#2485 r2, r3, r5, r6). So this pass does
  // not act under water at all. The collapsed, unquotable, past-grace loan
  // that leaves is the liquidator's to close in kind (#2487); until then the
  // lender's close-out card closes it.
  const hf = await hfStanding(client, diamond, loanId);
  if (typeof hf === 'object') return { kind: 'skipped', reason: `hf-unread:${hf.unread}` };
  if (hf === 'under-water') return { kind: 'skipped', reason: LEFT_TO_LIQUIDATOR };

  const sale = await saleVerdict(client, diamond, loanId, loan.lenderTokenId, keeper);
  if (sale !== null) return { kind: 'skipped', reason: sale };

  // A swap is possible only between two ERC-20s; every other shape sends
  // the empty list, and the contract takes its in-kind or rental branch or
  // refuses (a liquid ERC-20 needs a route: `NoEnabledSwapRoute`).
  const swappable =
    loan.collateralAssetType === ASSET_TYPE_ERC20 && loan.assetType === ASSET_TYPE_ERC20;
  let calls: readonly AdapterCall[] = [];
  let routeNote = '';
  if (swappable) {
    const route = await deps.buildRoute(loan);
    calls = route.calls;
    if (route.failed.length > 0) routeNote = ` (failed: ${route.failed.join(',')})`;
  }

  // THE FINAL GATE, pinned to one fresh block: the liquidator boundary, the
  // sale state, the collateral the quotes were made for AND the preview,
  // judged together. The preview belongs here rather than before the gate:
  // pool liquidity, an adapter or a quote can change in the moments between,
  // and a route that would already fall back at the block the send is
  // judged against must not be sent on an earlier block's word.
  //
  // The health factor is read again because a price can cross the line
  // while the route is quoted, and a loan that crossed it is the
  // liquidator's from that moment.
  //
  // An empty list still previews: a liquid loan reverts, an illiquid or
  // collapsed one takes the in-kind branch, and only the chain knows which.
  const gateBlock = await client.getBlockNumber({ cacheTime: 0 });
  const [lateHf, lateSale, live, preview] = await Promise.all([
    hfStanding(client, diamond, loanId, gateBlock),
    saleVerdict(client, diamond, loanId, loan.lenderTokenId, keeper, gateBlock),
    readLoan(client, diamond, loanId, gateBlock),
    previewCloseOut({ client, diamond, account: keeper, loanId, calls, blockNumber: gateBlock }),
  ]);
  if (typeof lateHf === 'object') return { kind: 'skipped', reason: `gate:hf-unread:${lateHf.unread}` };
  if (lateHf === 'under-water') return { kind: 'skipped', reason: `gate:${LEFT_TO_LIQUIDATOR}` };
  if (lateSale !== null) return { kind: 'skipped', reason: `gate:${lateSale}` };
  if (swappable && live.collateralAmount !== loan.collateralAmount) {
    return { kind: 'skipped', reason: 'gate:collateral-changed' };
  }

  if (preview === 'fallback') {
    return { kind: 'skipped', reason: `preview=fallback calls=${calls.length}${routeNote}` };
  }
  if (preview === 'unknown') {
    // eth_simulateV1 unsupported, or the call reverts — e.g. a liquid loan
    // with no quotable venue (`NoEnabledSwapRoute`).
    return { kind: 'skipped', reason: `preview=unknown calls=${calls.length}${routeNote}` };
  }

  // Prepared and signed here, broadcast separately: a failure up to the
  // signature means nothing was sent, while a failure of the broadcast
  // itself leaves the outcome unknown — the RPC may have relayed the
  // transaction and lost the answer. The hash is known from the signed
  // bytes either way, so the log can name it.
  const account = wallet.account;
  if (!account) return { kind: 'skipped', reason: 'no-keeper-account' };
  const request = await wallet.prepareTransactionRequest({
    account,
    to: diamond,
    data: encodeFunctionData({ abi: DEFAULTED_ABI, functionName: 'triggerDefault', args: [loanId, calls] }),
    chain: undefined,
  } as never);
  // `chain: null`: the client is chainless, and the chain id the request
  // was prepared with (read from the RPC) is the one signed over.
  const serialized = await wallet.signTransaction({ ...(request as object), chain: null } as never);
  const tx = keccak256(serialized);
  try {
    await wallet.sendRawTransaction({ serializedTransaction: serialized });
  } catch (err) {
    // The cap refuses BEFORE any network call, so a refused broadcast is
    // one that definitely did not happen.
    if (refusedByBudget(err)) throw err;
    return { kind: 'unconfirmed', tx, preview, calls: calls.length, reason: describeFailure(err) };
  }
  return { kind: 'submitted', tx, preview, calls: calls.length };
}

/** Whether `err`, or anything in its cause chain, is the budget's refusal. */
function refusedByBudget(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e !== undefined && e !== null && depth < 8; depth += 1) {
    if (e instanceof SubrequestBudgetExhausted) return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

async function readLoan(
  client: PublicClient,
  diamond: Address,
  loanId: bigint,
  blockNumber?: bigint,
): Promise<GraceLoan> {
  return (await client.readContract({
    address: diamond,
    abi: LOAN_ABI,
    functionName: 'getLoanDetails',
    args: [loanId],
    blockNumber,
  })) as GraceLoan;
}

/** Null when the sale state permits a close-out; otherwise the reason not
 *  to send. A probe that throws is a reason too — never a pass. */
async function saleVerdict(
  client: PublicClient,
  diamond: Address,
  loanId: bigint,
  lenderTokenId: bigint,
  keeper: Address,
  blockNumber?: bigint,
): Promise<string | null> {
  let state: SaleListingHoldState;
  try {
    state = await probeSaleHoldLive(client, diamond, loanId, lenderTokenId, keeper, blockNumber);
  } catch (err) {
    return `sale-unread:${describeFailure(err)}`;
  }
  if (saleHoldBlocksSettlement(state)) return `sale-${state}`;
  if (state === 'none') return null;
  // A listing stands (live or ended). The classifier's reading of it holds
  // only on a Diamond that routes the bounded-listing lifecycle; a legacy
  // one shares the error names with different meanings.
  try {
    const facet = (await client.readContract({
      address: diamond,
      abi: LOUPE_ABI,
      functionName: 'facetAddress',
      args: [BOUNDED_LISTING_SELECTOR],
      blockNumber,
    })) as Address;
    return facet === zeroAddress ? 'sale-legacy-listing' : null;
  } catch (err) {
    return `sale-unread:${describeFailure(err)}`;
  }
}

/** Where the loan stands against the liquidator's line. Illiquid
 *  collateral has no health factor — the read reverts, and the liquidator
 *  skips such loans too, so a revert reads as above the line. A read that
 *  got no answer is said as such and never guessed. */
type HfStanding = 'above' | 'under-water' | { unread: string };

async function hfStanding(
  client: PublicClient,
  diamond: Address,
  loanId: bigint,
  blockNumber?: bigint,
): Promise<HfStanding> {
  try {
    const hf = (await client.readContract({
      address: diamond,
      abi: RISK_ABI,
      functionName: 'calculateHealthFactor',
      args: [loanId],
      blockNumber,
    })) as bigint;
    return hf < HF_LIQUIDATION_THRESHOLD ? 'under-water' : 'above';
  } catch (err) {
    if (isRevert(err)) return 'above';
    return { unread: describeFailure(err) };
  }
}

const LEFT_TO_LIQUIDATOR = 'hf-liquidatable (left to the liquidator)';
