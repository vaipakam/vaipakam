/**
 * apps/keeper — time-based default pass (#2483).
 *
 * Closes out loans whose grace period has ended by submitting the
 * permissionless `DefaultedFacet.triggerDefault(loanId, adapterCalls)`, so a
 * lender who never opens the app is still closed out and only has to claim.
 * The lender's close-out card (#2474) sends the same transaction; this pass
 * applies the card's rules rather than a second set of its own.
 *
 * Per chain, per tick:
 *
 *   1. Pin one block and enumerate the active loans at it. Swap-and-pop on
 *      the active list can skip a loan mid-pagination when the scan spans
 *      blocks — the liquidator's reason for pinning, and the same here.
 *   2. Batch-read `isLoanDefaultable` at that block. The contract's own view
 *      is the eligibility rule; nothing here re-derives grace arithmetic.
 *   3. For each candidate, up to MAX_ATTEMPTS_PER_TICK, starting at a
 *      rotating offset so a loan that never closes cannot hold the front of
 *      the queue forever:
 *        a. The sale interlock (#2078): `triggerDefault` does not inspect
 *           sale linkage, so closing a loan after a buyer accepted its
 *           lender-position sale strands the buyer's principal. An accepted
 *           sale, or a sale state the chain does not establish, skips.
 *        b. The try-list. Liquid ERC-20 collateral for an ERC-20 loan is
 *           quoted through the shared route builder for the loan's whole
 *           collateral. Anything else sends an empty list and lets the
 *           contract take its in-kind branch, or refuse.
 *        c. The preview. `previewCloseOut` runs the call on `eth_simulateV1`
 *           and reads its logs, because a plain simulation SUCCEEDS into
 *           the full-collateral fallback when every route fails. Only a
 *           `sale` or an `other` ending (in-kind, collapsed LTV, internal
 *           match, rental) is sent. A route that would fall back is not:
 *           the spec wants a liquid forced close to make a real market
 *           attempt, and a route already known to fail is not one.
 *        d. The final gate, at a fresh block: the sale state again, and the
 *           collateral amount the quotes were made for (#2472 — after a
 *           top-up the adapter sells only the quoted amount and the rest
 *           lands in no one's claim).
 *        e. Submit. The receipt is not awaited; the next tick's
 *           `isLoanDefaultable` read is what says whether it landed.
 *
 * Every candidate logs one line naming what happened to it, so
 * `wrangler tail` says why a past-grace loan is still Active.
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
} from '@vaipakam/contracts/abis';
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
import { orchestrateServerQuotes, type ServerOrchestrationResult } from './serverQuotes';

const DEFAULTED_ABI: Abi = DefaultedFacetABI as Abi;
const LOUPE_ABI: Abi = DiamondLoupeFacetABI as Abi;
const LOAN_ABI: Abi = LoanFacetABI as Abi;
const METRICS_ABI: Abi = MetricsFacetABI as Abi;

/** Pagination size for `getActiveLoansPaginated`. */
const SCAN_PAGE = 200n;

/** `isLoanDefaultable` reads per aggregate — the liquidator's HF chunk size,
 *  so one eth_call never grows with the active-loan count. */
const READ_CHUNK = 100;

/** Candidates worked per chain per tick — each costs a quote round and a
 *  simulation, so this bounds API and RPC spend as well as gas. The rest
 *  are reached on later ticks through the rotating start. */
export const MAX_ATTEMPTS_PER_TICK = 5;

/** The pass's cadence, in ms — the rotation steps once per run. Mirrors
 *  `cadenceMinutes` in passSchedule.ts. */
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

export async function runGraceDefault(env: Env): Promise<void> {
  if (!passIsArmed(env, 'graceDefault', 'GRACE_DEFAULT_ENABLED')) return;
  for (const chain of getChainConfigs(env)) {
    try {
      await processChain(env, chain);
    } catch (err) {
      // Described, never stringified: a viem transport error carries the
      // request URL, and this Worker's RPC URLs carry API keys.
      console.error(`[keeper] graceDefault chain=${chain.id} failed: ${describeFailure(err)}`);
    }
  }
}

async function processChain(env: Env, chain: ChainConfig): Promise<void> {
  if (!chain.diamond) return;
  const client = createPublicClient({ transport: http(chain.rpc) }) as PublicClient;
  const ctx = buildKeeperContext(env, chain, client);
  if (!ctx) return;
  const keeper = ctx.wallet.account?.address;
  if (!keeper) return;

  const candidates = await findDefaultable(client, ctx.diamond, chain.id);
  if (candidates.length === 0) return;

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

  const picked = rotate(candidates, Math.floor(Date.now() / ROTATION_STEP_MS)).slice(
    0,
    MAX_ATTEMPTS_PER_TICK,
  );
  let submitted = 0;
  for (const loanId of picked) {
    let outcome: GraceDefaultOutcome;
    try {
      // eslint-disable-next-line no-await-in-loop
      outcome = await attemptGraceDefault(deps, loanId);
    } catch (err) {
      outcome = { kind: 'skipped', reason: `error:${describeFailure(err)}` };
    }
    if (outcome.kind === 'submitted') {
      submitted += 1;
      console.log(
        `[keeper] graceDefault chain=${chain.id} loan=${loanId} submitted tx=${outcome.tx} preview=${outcome.preview} route=${outcome.route}`,
      );
    } else {
      console.log(
        `[keeper] graceDefault chain=${chain.id} loan=${loanId} skipped: ${outcome.reason}`,
      );
    }
  }
  console.log(
    `[keeper] graceDefault chain=${chain.id} defaultable=${candidates.length} attempted=${picked.length} submitted=${submitted}`,
  );
}

/** Active loans past grace, read at one pinned block. */
export async function findDefaultable(
  client: PublicClient,
  diamond: Address,
  chainId: number,
): Promise<bigint[]> {
  const blockNumber = await client.getBlockNumber({ cacheTime: 0 });
  const total = (await client.readContract({
    address: diamond,
    abi: METRICS_ABI,
    functionName: 'getActiveLoansCount',
    blockNumber,
  })) as bigint;
  if (total === 0n) return [];
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
  const out: bigint[] = [];
  let unread = 0;
  results.forEach((r, i) => {
    if (r.status !== 'success') unread += 1;
    else if (r.result === true) out.push(ids[i]);
  });
  if (unread > 0) {
    // Unread is not "not defaultable": say so, so a loan missing from the
    // attempts below is not mistaken for one the chain ruled out.
    console.log(`[keeper] graceDefault chain=${chainId} isLoanDefaultable unread=${unread}`);
  }
  return out;
}

/** The candidates starting at `step mod length` — a stateless rotation, so
 *  every candidate reaches the front within `length` runs. */
export function rotate<T>(items: readonly T[], step: number): T[] {
  if (items.length === 0) return [];
  const start = ((step % items.length) + items.length) % items.length;
  return [...items.slice(start), ...items.slice(0, start)];
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

  // An empty list still previews: a liquid loan reverts, an illiquid or
  // collapsed one takes the in-kind branch, and only the chain knows which.
  const preview = await previewCloseOut({ client, diamond, account: keeper, loanId, calls });
  if (preview === 'fallback') {
    return { kind: 'skipped', reason: `preview=fallback calls=${calls.length}${routeNote}` };
  }
  if (preview === 'unknown') {
    // eth_simulateV1 unsupported, or the call reverts — e.g. a liquid loan
    // with no quotable venue (`NoEnabledSwapRoute`).
    return { kind: 'skipped', reason: `preview=unknown calls=${calls.length}${routeNote}` };
  }

  // THE FINAL GATE, pinned to one fresh block: the sale state and the
  // collateral the quotes were made for, judged together.
  const gateBlock = await client.getBlockNumber({ cacheTime: 0 });
  const [lateSale, live] = await Promise.all([
    saleVerdict(client, diamond, loanId, loan.lenderTokenId, keeper, gateBlock),
    readLoan(client, diamond, loanId, gateBlock),
  ]);
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
