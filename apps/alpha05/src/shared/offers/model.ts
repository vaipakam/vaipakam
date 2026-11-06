/**
 * The rules an offer row and an acceptance review are written from (OFF-40,
 * OFF-41, OFF-50), pure so each is tested once. Nothing here decides whether
 * an acceptance is allowed: the protocol's `previewAccept` and the offer
 * state decide that, and these functions only carry their answer to the
 * page, in order.
 */
import { ASSET_ERC20, OFFER_LENDER, roleTerms, type StoredOffer } from './acceptTerms';
import type { AcceptErrorName, AcceptPreview, OfferState } from './reads';

type Hex = `0x${string}`;

/** The protocol's year for interest: 365 days, by the second. */
export const DAYS_PER_YEAR = 365n;
export const BPS = 10_000n;

/**
 * The interest a loan owes when it is repaid on its due date, by the
 * protocol's published rule: principal × rate × term ÷ (365 days × 10,000),
 * counted in seconds and rounded down. A loan repaid on its due date owes
 * exactly this under either interest mode (pro-rata and full-term agree at
 * the full term). This is the figure if the protocol never pauses: a pause
 * moves the due date later by its length and interest keeps accruing
 * through it, so the review labels the figure and states the pause rule.
 */
export function interestAtDue(principal: bigint, rateBps: bigint, durationDays: bigint): bigint {
  return (principal * rateBps * durationDays) / (DAYS_PER_YEAR * BPS);
}

/** Why an offer cannot be taken now, or null when the protocol reports
 *  nothing against it. The offer's own state outranks the preview. */
export type NotTakeable =
  | { kind: 'state'; state: Exclude<OfferState, 'open'> }
  | { kind: 'refused'; error: Exclude<AcceptErrorName, 'None'> }
  | { kind: 'gate'; block: GateBlock }
  | { kind: 'unread'; reason: string };

/** A risk-access block on this acceptance: the lender's own (`creator`,
 *  which this wallet cannot fix) or this wallet's, with the gate's code. */
export interface GateBlock {
  creator: boolean;
  code: number;
}

/**
 * The risk-access verdict for an acceptance, from the combined preview
 * (`previewOfferAcceptBlock`, the creator's code first) and the creator's
 * own (`previewCreatorBlock`). The one rule both the offer list and the
 * acceptance review read, so a row is never marked takeable that the
 * review then blocks. Every code other than none blocks, the soft
 * illiquid-pair code (4) included: the acceptance's own acknowledgement no
 * longer stands in for the pair consent (owner decision 2026-11-06), so the
 * acceptor's standing consent, armed past any waiting period, is the only
 * way through, the same as the lender's. On a protocol that still softens
 * it, a consent clears it all the same, so nothing is wrongly blocked.
 */
export function gateBlock(gate: number, creatorGate: number): GateBlock | null {
  if (creatorGate !== 0) return { creator: true, code: creatorGate };
  if (gate !== 0) return { creator: false, code: gate };
  return null;
}

export function notTakeable(state: OfferState | null, preview: AcceptPreview | null, readError: string | null, gate: GateBlock | null = null): NotTakeable | null {
  if (readError !== null) return { kind: 'unread', reason: readError };
  if (state === null || preview === null) return { kind: 'unread', reason: 'not read yet' };
  if (state !== 'open') return { kind: 'state', state };
  if (preview.error !== 'None') return { kind: 'refused', error: preview.error };
  if (gate !== null) return { kind: 'gate', block: gate };
  return null;
}

/** The side the connected wallet takes when it accepts an offer: a lender
 *  offer is taken by a borrower, a borrow request by a lender. */
export type AcceptRole = 'borrower' | 'lender';

export function acceptorRole(o: Pick<StoredOffer, 'offerType'>): AcceptRole {
  return o.offerType === OFFER_LENDER ? 'borrower' : 'lender';
}

/** The loan a borrow request refinances, or null. Funding such a request
 *  does not deliver to the borrower: the amount less the borrower's fee
 *  stays in the lender's vault and pays the old loan's lender in the same
 *  transaction. The protocol's rule is a borrower-side offer naming a
 *  target loan; this is the same rule, so the review and the chain agree. */
export function refinancePayoff(o: Pick<StoredOffer, 'offerType' | 'refinanceTargetLoanId'>): bigint | null {
  return o.offerType !== OFFER_LENDER && o.refinanceTargetLoanId !== 0n ? o.refinanceTargetLoanId : null;
}

/** Whether this offer is one a guided flow can take for `role`: an offer
 *  from the other side (a lender offer for a borrower, a borrow request for
 *  a lender) of an ERC-20 against ERC-20 collateral, posted by someone
 *  else. Everything else on the pair is counted, never silently dropped. */
export type OfferFit = 'fits' | 'own' | 'other-side' | 'not-erc20';

export function offerFit(o: Pick<StoredOffer, 'offerType' | 'assetType' | 'collateralAssetType' | 'creator'>, account: Hex, role: AcceptRole): OfferFit {
  if (acceptorRole(o) !== role) return 'other-side';
  if (o.assetType !== ASSET_ERC20 || o.collateralAssetType !== ASSET_ERC20) return 'not-erc20';
  if (o.creator.toLowerCase() === account.toLowerCase()) return 'own';
  return 'fits';
}

export interface Ranked {
  offer: StoredOffer;
  /** Anything truthy: the offer cannot be taken now. */
  blocked: unknown;
}

/**
 * The order offers are suggested in: ones that can be taken first, then
 * the better rate for the reader (the lowest for a borrower, the highest
 * for a lender), then the larger amount, then the oldest id. Stated on the
 * page as the order, never as advice.
 */
export function rankFor<T extends Ranked>(role: AcceptRole, rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => {
    if (Boolean(a.blocked) !== Boolean(b.blocked)) return a.blocked ? 1 : -1;
    const ra = roleTerms(a.offer);
    const rb = roleTerms(b.offer);
    if (ra.rateBps !== rb.rateBps) return ra.rateBps < rb.rateBps === (role === 'borrower') ? -1 : 1;
    if (ra.amount !== rb.amount) return ra.amount > rb.amount ? -1 : 1;
    return a.offer.id < b.offer.id ? -1 : a.offer.id > b.offer.id ? 1 : 0;
  });
}

/** What the acceptor pays from the wallet: a borrower locks the collateral
 *  in their vault, a lender funds the principal. */
export function payLeg(
  role: AcceptRole,
  o: Pick<StoredOffer, 'lendingAsset' | 'collateralAsset'>,
  p: Pick<AcceptPreview, 'effectivePrincipal' | 'collateralAmount'>,
): { asset: Hex; amount: bigint } {
  return role === 'borrower' ? { asset: o.collateralAsset, amount: p.collateralAmount } : { asset: o.lendingAsset, amount: p.effectivePrincipal };
}

/** What the acceptor's wallet lacks for what it pays, or zero. */
export function shortfall(balance: bigint, needed: bigint): bigint {
  return balance >= needed ? 0n : needed - balance;
}

/**
 * The figures an acceptance moves, from the protocol's preview: the net the
 * borrower receives is the recorded principal less the initiation fee,
 * which the protocol takes from the principal in the lending asset.
 */
export interface AcceptFigures {
  principal: bigint;
  fee: bigint;
  /** The part of the fee the protocol pays to whoever submits the
   *  acceptance (the matcher's share), which on a direct take is the
   *  borrower: it reaches the wallet with the principal. */
  feeBack: bigint;
  received: bigint;
  collateral: bigint;
  refund: bigint;
  rateBps: bigint;
  interest: bigint;
  owedAtDue: bigint;
}

export function acceptFigures(preview: AcceptPreview, durationDays: bigint, matcherBps: bigint): AcceptFigures {
  const interest = interestAtDue(preview.effectivePrincipal, preview.interestRateBps, durationDays);
  const feeBack = (preview.lifEstimate * matcherBps) / BPS;
  return {
    principal: preview.effectivePrincipal,
    fee: preview.lifEstimate,
    feeBack,
    received: preview.effectivePrincipal - preview.lifEstimate + feeBack,
    collateral: preview.collateralAmount,
    refund: preview.collateralResidualRefund,
    rateBps: preview.interestRateBps,
    interest,
    owedAtDue: preview.effectivePrincipal + interest,
  };
}

/**
 * The figures a lender's acceptance moves, from the protocol's preview: the
 * principal leaves the wallet whole; the borrower's initiation fee is taken
 * from it on the way to the borrower, and the share the protocol pays the
 * submitter comes back to the lender's wallet. Interest at due is the
 * borrower's, before the protocol keeps its share of it when it is paid
 * (`protocolShareBps`, at most: a fee discount can lower it then).
 */
export interface LenderFigures {
  principal: bigint;
  fee: bigint;
  feeBack: bigint;
  collateral: bigint;
  rateBps: bigint;
  interest: bigint;
  /** The most the protocol keeps of that interest. */
  protocolShare: bigint;
  /** Principal plus interest less the most the protocol keeps. */
  backAtDue: bigint;
}

export function lenderFigures(preview: AcceptPreview, durationDays: bigint, matcherBps: bigint, protocolShareBps: bigint): LenderFigures {
  const interest = interestAtDue(preview.effectivePrincipal, preview.interestRateBps, durationDays);
  const protocolShare = (interest * protocolShareBps) / BPS;
  return {
    principal: preview.effectivePrincipal,
    fee: preview.lifEstimate,
    feeBack: (preview.lifEstimate * matcherBps) / BPS,
    collateral: preview.collateralAmount,
    rateBps: preview.interestRateBps,
    interest,
    protocolShare,
    backAtDue: preview.effectivePrincipal + interest - protocolShare,
  };
}

/** The fee the list rate gives before any discount (for the "list 0.2 %"
 *  line), rounded down like every protocol fee. */
export function listFee(principal: bigint, feeBps: bigint): bigint {
  return (principal * feeBps) / BPS;
}

/** Which figure moved between two previews of the same offer, by the
 *  first one that differs, or null when nothing a signature binds moved. */
export type Moved = 'amount' | 'rate' | 'collateral' | 'fee' | 'refund' | 'refusal' | null;

export function movedBetween(a: AcceptPreview, b: AcceptPreview): Moved {
  if (a.effectivePrincipal !== b.effectivePrincipal) return 'amount';
  if (a.interestRateBps !== b.interestRateBps) return 'rate';
  if (a.collateralAmount !== b.collateralAmount) return 'collateral';
  if (a.lifEstimate !== b.lifEstimate) return 'fee';
  if (a.collateralResidualRefund !== b.collateralResidualRefund) return 'refund';
  if (a.error !== b.error) return 'refusal';
  return null;
}
