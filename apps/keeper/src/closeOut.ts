/**
 * apps/keeper — one loan's `DefaultedFacet.triggerDefault` attempt, shared
 * by the two passes that may send it.
 *
 * ONE OWNER PER LOAN. Both passes sign from the same keeper account, and two
 * passes each deciding for themselves whether to close one loan race two
 * terminal transactions however the decision is split (#2485 r2, r3, r5,
 * r6). So the health-factor line, read again at the final gate's block,
 * decides which pass a loan belongs to, and each role refuses the other's:
 *
 *  - `grace` — the grace-default pass (#2483). A past-grace loan ABOVE the
 *    line: quote a sale of only the collateral its debt needs (#2796, the
 *    contract's `previewForcedSale(loanId, TimeBasedDefault)` range) and
 *    send a `sale`, or an `other` ending (an illiquid or rental in-kind
 *    close, an internal match).
 *  - `in-kind` — the HF liquidator's no-route fallback (#2487). A past-grace
 *    loan BELOW the line, for which no venue quoted at any size. Sent with
 *    an empty try-list, and only when the preview shows a terminal no-swap
 *    close: `LoanDefaulted` for this loan, no swap event of either kind, no
 *    internal match. That is the contract's in-kind branch for liquid
 *    collateral whose LTV has collapsed, which hands the lender the
 *    collateral itself. Every other ending is the liquidator's ordinary
 *    route, or nobody's yet: a liquid loan whose LTV has not collapsed
 *    reverts `NoEnabledSwapRoute` with an empty list, and the preview says
 *    `unknown`.
 *
 * Everything else is the same for both roles, and lives here once: a send
 * still pending from an earlier run holds this one, the sale interlock
 * (#2078) refuses a loan whose lender position a buyer has accepted, the
 * collateral must not have changed since it was read (#2472), and the
 * preview runs at the same fresh block as the gate's other reads.
 *
 * THE SALE SIZE (#2796). A default that sells takes a `sellAmount`, the
 * collateral the try-list was quoted for, and the contract accepts it only
 * inside the range `previewForcedSale` reports at the settling block. The
 * attempt quotes the middle of that range (`forcedSaleQuoteAmount`, shared
 * with the app), re-reads the range at the gate's block, and refuses a
 * quote that has left it. An empty-list close sells nothing and passes 0,
 * which an in-kind branch ignores.
 *
 * The same kind-3 plan also says whether the default sells at all: it is
 * all zero whenever the contract's one route rule (`LibDefaultRoute`) sends
 * the loan anywhere but the sale route — an unpriced pair (the unpriced
 * fallback), an illiquid or collapsed loan (in kind), a refused one, or one
 * not yet due. Such a loan is sent with 0 and an empty list, and the gate's
 * preview decides: an in-kind or unpriced-fallback close succeeds there, a
 * refused or not-due one reverts and is skipped. A plan whose answer flips
 * between the first read and the gate's (sale to none, or none to sale)
 * means the route moved, and the attempt is skipped. A plan read that
 * reverts (a distrusted price) skips, as the default itself would revert.
 *
 * THE SURFACE. A Diamond deployed before #2796 — the live testnets, until
 * the all-waves fresh deploy — has no plan and routes only the
 * `triggerDefault(loanId, adapterCalls)` form, which sells the whole
 * collateral and returns the surplus to the borrower. On such a Diamond the
 * attempt quotes the whole collateral, skips the plan checks, and sends that
 * form; the preview still decides. The surface is one loupe read at the
 * start (`readForcedSaleSurface`); it is not read again at the gate, because
 * the gate's preview simulates the exact form that is sent, and a Diamond
 * cut in between (or routing part of each surface) makes that form revert
 * there, so nothing is sent. The whole-collateral branch is deleted with the
 * rest of that surface (#2907).
 */

import {
  type Abi,
  type Address,
  type PublicClient,
  type WalletClient,
  zeroAddress,
} from 'viem';
import {
  DiamondLoupeFacetABI,
  LoanFacetABI,
  RiskFacetABI,
} from '@vaipakam/contracts/abis';
import { isRevert } from '@vaipakam/lib/contractRevert';
import { describeFailure } from '@vaipakam/lib/errorDescription';
import {
  FORCED_SALE_KIND,
  encodeTriggerDefault,
  forcedSaleQuoteAccepted,
  forcedSaleQuoteAmount,
  previewCloseOutDetail,
  readForcedSalePlan,
  readForcedSaleSurface,
  type CloseOutPreview,
  type CloseOutPreviewDetail,
  type ForcedSaleSurface,
} from '@vaipakam/lib/routeBuilder';
import {
  BOUNDED_LISTING_SELECTOR,
  probeSaleHoldLive,
  saleHoldBlocksSettlement,
  type SaleListingHoldState,
} from '@vaipakam/lib/saleHold';
import type { AdapterCall } from '@vaipakam/lib/swapRoutes';
import { HF_LIQUIDATION_THRESHOLD } from './hfLine';
import type { ServerOrchestrationResult } from './serverQuotes';
import { keeperTxPending, sendInSubmissionSlot } from './keeperSend';

const LOUPE_ABI: Abi = DiamondLoupeFacetABI as Abi;
const LOAN_ABI: Abi = LoanFacetABI as Abi;
const RISK_ABI: Abi = RiskFacetABI as Abi;

/** LibVaipakam.AssetType.ERC20. */
const ASSET_TYPE_ERC20 = 0;

/** Which pass is attempting the close-out; see the module header. */
export type CloseOutRole = 'grace' | 'in-kind';

/** The loan fields an attempt reads. */
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
  | { kind: 'submitted'; tx: string; preview: CloseOutPreview; calls: number; sellAmount: bigint }
  // The signed transaction went to the RPC and no answer came back: it may
  // be in the mempool or may never have arrived. `tx` is its hash, computed
  // locally from the signed bytes, so an operator can look it up; the
  // next run's pending-transaction check settles it on-chain either way.
  | {
      kind: 'unconfirmed';
      tx: string;
      preview: CloseOutPreview;
      calls: number;
      sellAmount: bigint;
      reason: string;
    }
  | { kind: 'skipped'; reason: string };

/** Everything one loan's attempt needs, injected so the decision is
 *  testable without an RPC. */
export interface GraceDefaultDeps {
  client: PublicClient;
  wallet: WalletClient;
  diamond: Address;
  chainId: number;
  /** The sending pass's run deadline (#2572), enforced at the send's turn. */
  notAfterMs: number;
  /** Builds the try-list for a sale of `sellAmount` of the loan's
   *  collateral. The `in-kind` role never calls it: it sends an empty list
   *  by definition. */
  buildRoute: (loan: GraceLoan, sellAmount: bigint) => Promise<ServerOrchestrationResult>;
}

/** The grace-default pass's attempt: {@link attemptCloseOut} as `grace`. */
export function attemptGraceDefault(
  deps: GraceDefaultDeps,
  loanId: bigint,
): Promise<GraceDefaultOutcome> {
  return attemptCloseOut(deps, loanId, 'grace');
}

/** One loan: interlock, route, preview, final gate, submit. Never sends
 *  when any step cannot establish its answer. */
export async function attemptCloseOut(
  deps: GraceDefaultDeps,
  loanId: bigint,
  role: CloseOutRole,
): Promise<GraceDefaultOutcome> {
  const { client, wallet, diamond } = deps;
  const keeper = wallet.account?.address;
  if (!keeper) return { kind: 'skipped', reason: 'no-keeper-account' };

  // A send from an earlier run may still be pending — on this loan, or on
  // another pass's. The loan then still reads Active and defaultable, and a
  // second `triggerDefault` would queue behind the first only to revert once
  // it lands. While one is unmined, this run waits.
  const pending = await keeperTxPending(client, keeper);
  if (pending !== null) return { kind: 'skipped', reason: pending };

  // Which `triggerDefault` this Diamond routes: the sized one every fresh
  // deploy carries, or the whole-collateral one of a Diamond deployed before
  // #2796, which the live testnets run until the all-waves fresh deploy.
  // One request: the attempt runs under the pass's request budget. A wrong
  // reading (a Diamond part-way between the two) is caught by the gate's
  // preview of the exact form; an unread one is sent nothing.
  let surface: ForcedSaleSurface;
  try {
    surface = await readForcedSaleSurface({ client, diamond });
  } catch (err) {
    return { kind: 'skipped', reason: surfaceSkipReason(err) };
  }

  const loan = await readLoan(client, diamond, loanId);

  // The owner rule, first on an early read so a loan that is plainly the
  // other pass's costs nothing more, then again at the gate's block.
  const hf = await hfStanding(client, diamond, loanId);
  if (typeof hf === 'object') return { kind: 'skipped', reason: `hf-unread:${hf.unread}` };
  const notOurs = ownerVerdict(role, hf);
  if (notOurs !== null) return { kind: 'skipped', reason: notOurs };

  const sale = await saleVerdict(client, diamond, loanId, loan.lenderTokenId, keeper);
  if (sale !== null) return { kind: 'skipped', reason: sale };

  // A swap is possible only between two ERC-20s; every other shape sends
  // the empty list, and the contract takes its in-kind or rental branch or
  // refuses (a liquid ERC-20 needs a route: `NoEnabledSwapRoute`). The
  // in-kind role always sends the empty list: no venue quoted, which is
  // why it is attempting this at all.
  const swappable =
    loan.collateralAssetType === ASSET_TYPE_ERC20 && loan.assetType === ASSET_TYPE_ERC20;
  let calls: readonly AdapterCall[] = [];
  let routeNote = '';
  let sellAmount = 0n;
  // Only a grace attempt on an ERC-20 pair can sell, so only it reads the
  // plan; whether it then sells is the plan's answer. A whole-collateral
  // Diamond has no plan: its `triggerDefault` sells all the collateral, so
  // the route is quoted for all of it and the gate's preview judges it.
  const sells = role === 'grace' && swappable;
  const readsPlan = sells && surface === 'sized';
  let planSells = false;
  if (sells && surface === 'whole') {
    sellAmount = loan.collateralAmount;
    const route = await deps.buildRoute(loan, sellAmount);
    calls = route.calls;
    if (route.failed.length > 0) routeNote = ` (failed: ${route.failed.join(',')})`;
  }
  if (readsPlan) {
    // The contract sizes the sale; the quote is built for an amount inside
    // the range it accepts. A plan that sells nothing is a default by
    // another route, sent with 0 and the empty list for the gate's preview
    // to judge.
    const plan = await readForcedSalePlan({ client, diamond, loanId, kind: FORCED_SALE_KIND.TimeBasedDefault });
    const quoted = forcedSaleQuoteAmount(plan);
    if (quoted !== null) {
      planSells = true;
      sellAmount = quoted;
      const route = await deps.buildRoute(loan, sellAmount);
      calls = route.calls;
      if (route.failed.length > 0) routeNote = ` (failed: ${route.failed.join(',')})`;
    }
  }

  // THE FINAL GATE, pinned to one fresh block: the owner rule, the sale
  // state, the collateral the attempt was judged on AND the preview, judged
  // together. The preview belongs here rather than before the gate: pool
  // liquidity, an adapter or a quote can change in the moments between, and
  // an ending that differs at the block the send is judged against must not
  // be sent on an earlier block's word.
  //
  // The health factor is read again because a price can cross the line
  // while the route is quoted, and a loan that crossed it belongs to the
  // other pass from that moment.
  //
  // An empty list still previews: a liquid loan reverts, an illiquid or
  // collapsed one takes the in-kind branch, and only the chain knows which.
  const gateBlock = await client.getBlockNumber({ cacheTime: 0 });
  const [lateHf, lateSale, live, detail, latePlan] = await Promise.all([
    hfStanding(client, diamond, loanId, gateBlock),
    saleVerdict(client, diamond, loanId, loan.lenderTokenId, keeper, gateBlock),
    readLoan(client, diamond, loanId, gateBlock),
    previewCloseOutDetail({ client, diamond, account: keeper, loanId, sellAmount, calls, blockNumber: gateBlock, surface }),
    readsPlan
      ? readForcedSalePlan({ client, diamond, loanId, kind: FORCED_SALE_KIND.TimeBasedDefault, blockNumber: gateBlock })
      : Promise.resolve(null),
  ]);
  if (typeof lateHf === 'object') return { kind: 'skipped', reason: `gate:hf-unread:${lateHf.unread}` };
  const lateNotOurs = ownerVerdict(role, lateHf);
  if (lateNotOurs !== null) return { kind: 'skipped', reason: `gate:${lateNotOurs}` };
  if (lateSale !== null) return { kind: 'skipped', reason: `gate:${lateSale}` };
  // For a quoted sale the adapter sells only the quoted amount, so a top-up
  // would land in no one's claim (#2472). For an in-kind close nothing was
  // quoted, but the decision was judged on this collateral, and a changed
  // amount means something moved the loan while it was being judged.
  if ((swappable || role === 'in-kind') && live.collateralAmount !== loan.collateralAmount) {
    return { kind: 'skipped', reason: 'gate:collateral-changed' };
  }

  // The route moved between the reads: a sale became a no-sale default or
  // the reverse, so what was built is the wrong call.
  if (latePlan !== null && (forcedSaleQuoteAmount(latePlan) !== null) !== planSells) {
    return {
      kind: 'skipped',
      reason: `gate:plan-changed (sells ${planSells}->${!planSells})`,
    };
  }
  // The range moves with accrual and price; a quote that has left it would
  // revert `ForcedSaleQuoteOutOfRange`, so it is quoted again next run.
  if (latePlan !== null && planSells && !forcedSaleQuoteAccepted(latePlan, sellAmount)) {
    return {
      kind: 'skipped',
      reason: `gate:quote-out-of-range quoted=${sellAmount} range=[${latePlan.sell},${latePlan.maxSell}]`,
    };
  }

  const refusal = previewVerdict(role, detail, calls.length, routeNote);
  if (refusal !== null) return { kind: 'skipped', reason: refusal };
  const preview = detail.preview;

  // Prepared, signed and broadcast in the account's submission slot (#2486),
  // so no other pass's send on this chain can take the same nonce. A
  // broadcast whose answer was lost is reported as such, with its hash.
  const sent = await sendInSubmissionSlot(
    wallet,
    deps.chainId,
    deps.notAfterMs,
    diamond,
    encodeTriggerDefault(surface, loanId, sellAmount, calls),
  );
  return sent.kind === 'submitted'
    ? { kind: 'submitted', tx: sent.tx, preview, calls: calls.length, sellAmount }
    : { kind: 'unconfirmed', tx: sent.tx, preview, calls: calls.length, sellAmount, reason: sent.reason };
}

/** Why a forced-sale attempt sends nothing when the Diamond's surface could
 *  not be read. */
export function surfaceSkipReason(err: unknown): string {
  return `surface-unread:${describeFailure(err)}`;
}

/** Null when the loan is this role's to close; otherwise the reason not to. */
function ownerVerdict(role: CloseOutRole, hf: 'above' | 'under-water'): string | null {
  if (role === 'grace') return hf === 'under-water' ? LEFT_TO_LIQUIDATOR : null;
  return hf === 'above' ? LEFT_TO_GRACE_DEFAULT : null;
}

/** Null when the preview shows an ending this role may send; otherwise the
 *  reason not to. */
function previewVerdict(
  role: CloseOutRole,
  detail: CloseOutPreviewDetail,
  calls: number,
  routeNote: string,
): string | null {
  const { preview } = detail;
  if (preview === 'fallback') return `preview=fallback calls=${calls}${routeNote}`;
  // eth_simulateV1 unsupported, or the call reverts — e.g. a liquid loan
  // with no quotable venue (`NoEnabledSwapRoute`).
  if (preview === 'unknown') return `preview=unknown calls=${calls}${routeNote}`;
  if (role === 'grace') return null;
  // In-kind: a terminal close with no swap, and nothing an internal match
  // did. A match is the liquidator's ordinary `triggerLiquidation` route,
  // not a no-route fallback; a `sale` cannot follow an empty list, and is
  // refused here should a node ever report one.
  if (preview !== 'other') return `preview=${preview} (in-kind expects a no-swap close)`;
  if (detail.internalMatch) return 'preview=internal-match (left to triggerLiquidation)';
  if (!detail.defaulted) return 'preview=not-terminal (no LoanDefaulted for this loan)';
  return null;
}

export async function readLoan(
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
export type HfStanding = 'above' | 'under-water' | { unread: string };

export async function hfStanding(
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

export const LEFT_TO_LIQUIDATOR = 'hf-liquidatable (left to the liquidator)';
export const LEFT_TO_GRACE_DEFAULT = 'hf-above-line (left to the grace-default pass)';
