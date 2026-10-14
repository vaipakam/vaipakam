/**
 * apps/keeper — time-based default pass (#2483).
 *
 * Closes out loans whose grace period has ended by submitting the
 * permissionless `DefaultedFacet.triggerDefault(loanId, adapterCalls)`, so a
 * lender who never opens the app is still closed out and only has to claim.
 * The lender's close-out card (#2474) sends the same transaction; this pass
 * applies the card's rules rather than a second set of its own.
 *
 * Per run:
 *
 *   1. On each chain, pin one block and enumerate the active loans at it. Swap-and-pop on
 *      the active list can skip a loan mid-pagination when the scan spans
 *      blocks — the liquidator's reason for pinning, and the same here.
 *   2. Batch-read `isLoanDefaultable` at that block. The contract's own view
 *      is the eligibility rule; nothing here re-derives grace arithmetic.
 *   3. For a batch of MAX_ATTEMPTS_PER_RUN candidates drawn from every
 *      chain's list together — the subrequest allowance is the
 *      invocation's, not a chain's — and consecutive runs take consecutive
 *      batches, so a loan that never closes cannot hold the front of the
 *      queue (`pickBatch`):
 *        a. Not the liquidator's. A loan that is also under water is the
 *           HF liquidator's to SELL, and it runs every tick from the same
 *           keeper account; two swap closes of one loan would race. The
 *           liquidator cannot close one without a route, though, and
 *           `triggerDefault` closes a genuinely LTV-collapsed loan in kind
 *           with none — so under water this pass previews the empty list
 *           only and sends only an in-kind ending.
 *        b. The sale interlock (#2078): `triggerDefault` does not inspect
 *           sale linkage, so closing a loan after a buyer accepted its
 *           lender-position sale strands the buyer's principal. An accepted
 *           sale, or a sale state the chain does not establish, skips.
 *        c. The try-list. Liquid ERC-20 collateral for an ERC-20 loan is
 *           quoted through the shared route builder for the loan's whole
 *           collateral. Anything else sends an empty list and lets the
 *           contract take its in-kind branch, or refuse.
 *        d. The preview. `previewCloseOut` runs the call on `eth_simulateV1`
 *           and reads its logs, because a plain simulation SUCCEEDS into
 *           the full-collateral fallback when every route fails. Only a
 *           `sale` or an `other` ending (in-kind, collapsed LTV, internal
 *           match, rental) is sent. A route that would fall back is not:
 *           the spec wants a liquid forced close to make a real market
 *           attempt, and a route already known to fail is not one.
 *        e. The final gate, at a fresh block: the health factor still on
 *           the side of the line step a judged it on, the sale state
 *           again, and the collateral amount the quotes were made for
 *           (#2472 — after a top-up the adapter sells only the quoted
 *           amount and the rest lands in no one's claim).
 *        f. Submit. The receipt is not awaited; the next tick's
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
  http,
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
import { HF_LIQUIDATION_THRESHOLD } from './liquidator';
import { orchestrateServerQuotes, type ServerOrchestrationResult } from './serverQuotes';

const DEFAULTED_ABI: Abi = DefaultedFacetABI as Abi;
const LOUPE_ABI: Abi = DiamondLoupeFacetABI as Abi;
const LOAN_ABI: Abi = LoanFacetABI as Abi;
const METRICS_ABI: Abi = MetricsFacetABI as Abi;
const RISK_ABI: Abi = RiskFacetABI as Abi;

/** Pagination size for `getActiveLoansPaginated`. */
const SCAN_PAGE = 200n;

/** `isLoanDefaultable` reads per aggregate — the liquidator's HF chunk size,
 *  so one eth_call never grows with the active-loan count. */
const READ_CHUNK = 100;

/** Candidates worked per RUN, across every chain. One attempt costs about
 *  sixteen subrequests plus two per enabled swap adapter (the roster is read
 *  one adapter at a time) plus the aggregator quotes — loan, health factor
 *  and sale reads, the simulation, the final gate's reads and the send's own
 *  preparation; the CPU bench measures 22 RPC calls with three adapters, on
 *  top of about four per chain for the scan. That is against a
 *  50-subrequest allowance the whole invocation shares with the other passes
 *  due on the same tick. The rest are reached
 *  on later runs through the rotating start: at one per five minutes, a
 *  backlog of n past-grace loans clears within 5n minutes. */
export const MAX_ATTEMPTS_PER_RUN = 1;

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
  | { kind: 'submitted'; tx: string; preview: CloseOutPreview; route: 'swap' | 'none' }
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

/** One chain's working state for a run. */
interface ChainRun {
  chain: ChainConfig;
  deps: GraceDefaultDeps;
  candidates: bigint[];
  attempted: number;
  submitted: number;
}

export async function runGraceDefault(env: Env): Promise<void> {
  if (!passIsArmed(env, 'graceDefault', 'GRACE_DEFAULT_ENABLED')) return;

  // Scan every chain first: the scan is a handful of subrequests per chain,
  // while an attempt costs a quote round, a simulation and a send. The cap
  // then applies to the RUN, not to each chain, because the subrequest
  // allowance is the invocation's — shared by every chain and every pass
  // the tick launches — and a per-chain cap multiplies with the roster.
  const runs: ChainRun[] = [];
  for (const chain of getChainConfigs(env)) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const run = await scanChain(env, chain);
      if (run) runs.push(run);
    } catch (err) {
      // Described, never stringified: a viem transport error carries the
      // request URL, and this Worker's RPC URLs carry API keys.
      console.error(`[keeper] graceDefault chain=${chain.id} failed: ${describeFailure(err)}`);
    }
  }

  const queue = runs.flatMap((run) => run.candidates.map((loanId) => ({ run, loanId })));
  const { picked, deferred } = pickBatch(
    queue,
    Math.floor(Date.now() / ROTATION_STEP_MS),
    MAX_ATTEMPTS_PER_RUN,
  );
  for (const run of runs) {
    // Named, not just counted: an operator asking why one loan is still
    // Active must be able to tell "waiting its turn" from "never seen".
    const waiting = deferred.filter((d) => d.run === run).map((d) => d.loanId);
    if (waiting.length > 0) {
      console.log(
        `[keeper] graceDefault chain=${run.chain.id} deferred-by-cap loans=${waiting.join(',')}`,
      );
    }
  }

  for (const { run, loanId } of picked) {
    let outcome: GraceDefaultOutcome;
    try {
      // eslint-disable-next-line no-await-in-loop
      outcome = await attemptGraceDefault(run.deps, loanId);
    } catch (err) {
      outcome = { kind: 'skipped', reason: `error:${describeFailure(err)}` };
    }
    run.attempted += 1;
    if (outcome.kind === 'submitted') {
      run.submitted += 1;
      console.log(
        `[keeper] graceDefault chain=${run.chain.id} loan=${loanId} submitted tx=${outcome.tx} preview=${outcome.preview} route=${outcome.route}`,
      );
    } else {
      console.log(
        `[keeper] graceDefault chain=${run.chain.id} loan=${loanId} skipped: ${outcome.reason}`,
      );
    }
  }

  for (const run of runs) {
    if (run.candidates.length === 0) continue;
    console.log(
      `[keeper] graceDefault chain=${run.chain.id} defaultable=${run.candidates.length} attempted=${run.attempted} submitted=${run.submitted}`,
    );
  }
}

async function scanChain(env: Env, chain: ChainConfig): Promise<ChainRun | null> {
  if (!chain.diamond) return null;
  const client = createPublicClient({ transport: http(chain.rpc) }) as PublicClient;
  const ctx = buildKeeperContext(env, chain, client);
  if (!ctx) return null;
  const keeper = ctx.wallet.account?.address;
  if (!keeper) return null;

  const { defaultable: candidates, unread } = await findDefaultable(client, ctx.diamond, chain.id);
  if (unread.length > 0) {
    // Unread is not "not defaultable": name them, so a loan missing from the
    // attempts below is not mistaken for one the chain ruled out.
    console.log(
      `[keeper] graceDefault chain=${chain.id} eligibility-unread loans=${unread.join(',')}`,
    );
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
      }),
  };
  return { chain, deps, candidates, attempted: 0, submitted: 0 };
}

/** Active loans past grace, read at one pinned block. */
export async function findDefaultable(
  client: PublicClient,
  diamond: Address,
  chainId: number,
): Promise<{ defaultable: bigint[]; unread: bigint[] }> {
  const blockNumber = await client.getBlockNumber({ cacheTime: 0 });
  const total = (await client.readContract({
    address: diamond,
    abi: METRICS_ABI,
    functionName: 'getActiveLoansCount',
    blockNumber,
  })) as bigint;
  if (total === 0n) return { defaultable: [], unread: [] };
  const ids: bigint[] = [];
  for (let cursor = 0n; cursor < total; cursor += SCAN_PAGE) {
    const limit = cursor + SCAN_PAGE > total ? total - cursor : SCAN_PAGE;
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
    );
    results.push(...part);
  }
  const defaultable: bigint[] = [];
  const unread: bigint[] = [];
  results.forEach((r, i) => {
    if (r.status !== 'success') unread.push(ids[i]);
    else if (r.result === true) defaultable.push(ids[i]);
  });
  return { defaultable, unread };
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

  const loan = await readLoan(client, diamond, loanId);

  // A past-grace loan that is ALSO under water: any SWAP close of it belongs
  // to the liquidator, which runs every tick from the same keeper account —
  // quoting a second sale here would race two terminal transactions for one
  // loan. What the liquidator cannot do is the no-swap close: it needs a
  // route, while `triggerDefault` moves a genuinely LTV-collapsed loan's
  // collateral in kind with an empty list. So under water this pass
  // previews the empty list only, and sends only an in-kind ending.
  const hf = await hfStanding(client, diamond, loanId);
  if (typeof hf === 'object') return { kind: 'skipped', reason: `hf-unread:${hf.unread}` };
  const underWater = hf === 'under-water';

  const sale = await saleVerdict(client, diamond, loanId, loan.lenderTokenId, keeper);
  if (sale !== null) return { kind: 'skipped', reason: sale };

  // A swap is possible only between two ERC-20s; every other shape sends
  // the empty list, and the contract takes its in-kind or rental branch or
  // refuses (a liquid ERC-20 needs a route: `NoEnabledSwapRoute`).
  const swappable =
    !underWater &&
    loan.collateralAssetType === ASSET_TYPE_ERC20 &&
    loan.assetType === ASSET_TYPE_ERC20;
  let calls: readonly AdapterCall[] = [];
  let routeNote = '';
  if (swappable) {
    const route = await deps.buildRoute(loan);
    calls = route.calls;
    if (route.failed.length > 0) routeNote = ` (failed: ${route.failed.join(',')})`;
  }

  // An empty list still previews: a liquid loan reverts, an illiquid or
  // collapsed one takes the in-kind branch, and only the chain knows which.
  const preview = await previewCloseOut({ client, diamond, account: keeper, loanId, calls });
  if (underWater && preview !== 'other') {
    // Not an in-kind close (a liquid loan's empty list reverts, or the
    // chain could not say): the liquidator's.
    return { kind: 'skipped', reason: `${LEFT_TO_LIQUIDATOR} preview=${preview}` };
  }
  if (preview === 'fallback') {
    return { kind: 'skipped', reason: `preview=fallback calls=${calls.length}${routeNote}` };
  }
  if (preview === 'unknown') {
    // eth_simulateV1 unsupported, or the call reverts — e.g. a liquid loan
    // with no quotable venue (`NoEnabledSwapRoute`).
    return { kind: 'skipped', reason: `preview=unknown calls=${calls.length}${routeNote}` };
  }

  // THE FINAL GATE, pinned to one fresh block: the liquidator boundary, the
  // sale state and the collateral the quotes were made for, judged together.
  // The health factor is read again because a price can cross the line, in
  // either direction, while the route is quoted and previewed: the decision
  // above (quote a sale, or preview in kind only) holds only for the side
  // of the line it was made on.
  const gateBlock = await client.getBlockNumber({ cacheTime: 0 });
  const [lateHf, lateSale, live] = await Promise.all([
    hfStanding(client, diamond, loanId, gateBlock),
    saleVerdict(client, diamond, loanId, loan.lenderTokenId, keeper, gateBlock),
    readLoan(client, diamond, loanId, gateBlock),
  ]);
  if (typeof lateHf === 'object') return { kind: 'skipped', reason: `gate:hf-unread:${lateHf.unread}` };
  if (lateHf !== hf) {
    return {
      kind: 'skipped',
      reason: lateHf === 'under-water' ? `gate:${LEFT_TO_LIQUIDATOR}` : 'gate:hf-recovered',
    };
  }
  if (lateSale !== null) return { kind: 'skipped', reason: `gate:${lateSale}` };
  if (swappable && live.collateralAmount !== loan.collateralAmount) {
    return { kind: 'skipped', reason: 'gate:collateral-changed' };
  }

  const tx = await wallet.writeContract({
    address: diamond,
    abi: DEFAULTED_ABI,
    functionName: 'triggerDefault',
    args: [loanId, calls],
    chain: undefined,
    account: wallet.account ?? null,
  } as never);
  return { kind: 'submitted', tx, preview, route: calls.length > 0 ? 'swap' : 'none' };
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
