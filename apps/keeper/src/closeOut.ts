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
 *    line: quote a sale of its whole collateral and send a `sale`, or an
 *    `other` ending (an illiquid or rental in-kind close, an internal match).
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
 */

import {
  encodeFunctionData,
  keccak256,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
  zeroAddress,
} from 'viem';
import {
  DefaultedFacetABI,
  DiamondLoupeFacetABI,
  LoanFacetABI,
  RiskFacetABI,
} from '@vaipakam/contracts/abis';
import { isRevert } from '@vaipakam/lib/contractRevert';
import { describeFailure } from '@vaipakam/lib/errorDescription';
import {
  previewCloseOutDetail,
  type CloseOutPreview,
  type CloseOutPreviewDetail,
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
import { SubrequestBudgetExhausted } from './subrequestBudget';
import { withSubmissionSlot } from './submissionQueue';

const DEFAULTED_ABI: Abi = DefaultedFacetABI as Abi;
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
  /** Builds the try-list for a sale of the loan's whole collateral. The
   *  `in-kind` role never calls it: it sends an empty list by definition. */
  buildRoute: (loan: GraceLoan) => Promise<ServerOrchestrationResult>;
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
  if (role === 'grace' && swappable) {
    const route = await deps.buildRoute(loan);
    calls = route.calls;
    if (route.failed.length > 0) routeNote = ` (failed: ${route.failed.join(',')})`;
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
  const [lateHf, lateSale, live, detail] = await Promise.all([
    hfStanding(client, diamond, loanId, gateBlock),
    saleVerdict(client, diamond, loanId, loan.lenderTokenId, keeper, gateBlock),
    readLoan(client, diamond, loanId, gateBlock),
    previewCloseOutDetail({ client, diamond, account: keeper, loanId, calls, blockNumber: gateBlock }),
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

  const refusal = previewVerdict(role, detail, calls.length, routeNote);
  if (refusal !== null) return { kind: 'skipped', reason: refusal };
  const preview = detail.preview;

  // Prepared and signed here, broadcast separately: a failure up to the
  // signature means nothing was sent, while a failure of the broadcast
  // itself leaves the outcome unknown — the RPC may have relayed the
  // transaction and lost the answer. The hash is known from the signed
  // bytes either way, so the log can name it.
  const account = wallet.account;
  if (!account) return { kind: 'skipped', reason: 'no-keeper-account' };
  // In the account's submission slot (#2486), so no other pass's send on
  // this chain can take the same nonce. Once signed, the nonce stays
  // reserved even if the broadcast fails, since it may have been relayed.
  let tx: Hex | undefined;
  try {
    await withSubmissionSlot(wallet, deps.chainId, account.address, async (nonce, signed) => {
      const request = await wallet.prepareTransactionRequest({
        account,
        to: diamond,
        data: encodeFunctionData({ abi: DEFAULTED_ABI, functionName: 'triggerDefault', args: [loanId, calls] }),
        nonce,
        chain: undefined,
      } as never);
      // `chain: null`: the client is chainless, and the chain id the request
      // was prepared with (read from the RPC) is the one signed over.
      const serialized = await wallet.signTransaction({ ...(request as object), chain: null } as never);
      tx = keccak256(serialized);
      signed();
      await wallet.sendRawTransaction({ serializedTransaction: serialized });
    });
  } catch (err) {
    // The cap refuses BEFORE any network call, so a refused broadcast is
    // one that definitely did not happen.
    if (refusedByBudget(err)) throw err;
    // Failed before signing: nothing was sent.
    if (tx === undefined) throw err;
    return { kind: 'unconfirmed', tx, preview, calls: calls.length, reason: describeFailure(err) };
  }
  return { kind: 'submitted', tx: tx!, preview, calls: calls.length };
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

export const LEFT_TO_LIQUIDATOR = 'hf-liquidatable (left to the liquidator)';
export const LEFT_TO_GRACE_DEFAULT = 'hf-above-line (left to the grace-default pass)';
