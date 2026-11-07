/**
 * OFF-50 / OFF-17 / OFF-19 / OFF-29 — what an acceptance review stands on,
 * for either side (a borrower taking a lender offer, a lender taking a
 * borrow request), read in one go through the wallet's connection, and the
 * rules that turn it into the blockers stated in place and the "what
 * changed" of a re-check. Each side's receipt is written in its own module
 * (borrowerReceipt, lenderReceipt). The protocol's preview is the source of
 * truth for every figure; the review never computes an amount the protocol
 * reports.
 */
import type { OwnStateClient } from '../../chain/ownRail';
import type { CopyAccess, CopyKey } from '../copy/useCopy';
import { readFeeDiscountConsent } from '../consent/feeDiscount';
import { readAssetClass, type AssetClass } from '../offers/assets';
import type { StoredOffer } from '../offers/acceptTerms';
import { acceptorRole, gateBlock, payLeg, shortfall, type AcceptRole, type GateBlock } from '../offers/model';
import {
  readAcceptGate,
  readCreatorGate,
  readGraceSeconds,
  readLifBps,
  readLifMatcherBps,
  readLinkedLoanId,
  readOffer,
  readOfferState,
  readPreview,
  readRiskTermsHash,
  readTreasuryFeeBps,
  readVault,
  readWalletFunds,
  tokenAcceptsApproval,
  type AcceptPreview,
  type OfferState,
  type WalletFunds,
} from '../offers/reads';
import { SWITCH_EFFECTS } from '../eligibility/switchClasses';
import { tokenAmount, type TokenMetaMap } from '../reads/tokens';
import { allowanceSteps } from '../tx/approval';
import { shortAddress } from '../ui/format';

type Hex = `0x${string}`;

export const ZERO: Hex = '0x0000000000000000000000000000000000000000';
export const ZERO_HASH: Hex = '0x0000000000000000000000000000000000000000000000000000000000000000';

export interface AcceptReview {
  /** The wallet and network the review was read under (RB-REVIEW). */
  identity: string;
  /** The side this wallet takes, from the offer's own side. */
  role: AcceptRole;
  offerId: bigint;
  offer: StoredOffer;
  state: OfferState;
  preview: AcceptPreview;
  linkedLoanId: bigint;
  riskTermsHash: Hex;
  lendingClass: AssetClass;
  collateralClass: AssetClass;
  graceSeconds: bigint;
  lifBps: bigint;
  /** The share of the fee paid back to the submitter (bps of the fee). */
  matcherBps: bigint;
  /** The protocol's share of the lender's interest under today's setting
   *  (bps), read for a lender; null for a borrower. */
  protocolShareBps: bigint | null;
  /** This wallet's vault; the zero address when it is opened by this accept. */
  vault: Hex;
  /** The wallet's balance and allowance of what it pays (payLeg). */
  funds: WalletFunds;
  /** Wallet prompts the approval takes: 0 when the allowance covers what
   *  the wallet pays, 2 when the token must be set to zero first. */
  approvalSteps: number;
  /** Read only when the protocol reports a vault below the required
   *  version: whether it is this wallet's own (false: the other side's), or
   *  null when that could not be read. */
  /** The risk-access gate's code for this acceptance (0 = open); it is the
   *  creator's code when the creator is blocked. */
  gate: number;
  /** The creator's own block on this offer (0 = none): the other side's
   *  block, which the connected wallet cannot fix. */
  creatorGate: number;
  /** The fee-discount setting; null when it could not be read. */
  consent: boolean | null;
  readAt: number;
}

export async function readAcceptReview(own: OwnStateClient, diamond: Hex, offerId: bigint, identity: string): Promise<AcceptReview> {
  const account = own.account;
  const r = <T>(fn: Parameters<OwnStateClient['read']>[0]) => own.read(fn).then((x) => x.value as T);
  const offer = await r<StoredOffer>((c) => readOffer(c, diamond, offerId));
  const role = acceptorRole(offer);
  // What this wallet pays: the collateral for a borrower, the principal for
  // a lender. Its token is known from the offer before the preview sizes it.
  const payAsset = role === 'borrower' ? offer.collateralAsset : offer.lendingAsset;
  const [state, preview, linkedLoanId, riskTermsHash, lendingClass, collateralClass, graceSeconds, lifBps, matcherBps, protocolShareBps, vault, funds, gate, creatorGate, consent] =
    await Promise.all([
      r<OfferState>((c) => readOfferState(c, diamond, offerId)),
      r<AcceptPreview>((c) => readPreview(c, diamond, offerId, account)),
      r<bigint>((c) => readLinkedLoanId(c, diamond, offerId)),
      r<Hex>((c) => readRiskTermsHash(c, diamond)),
      r<AssetClass>((c) => readAssetClass(c, diamond, offer.lendingAsset)),
      r<AssetClass>((c) => readAssetClass(c, diamond, offer.collateralAsset)),
      r<bigint>((c) => readGraceSeconds(c, diamond, offer.durationDays)),
      r<bigint>((c) => readLifBps(c, diamond)),
      r<bigint>((c) => readLifMatcherBps(c, diamond)),
      role === 'lender' ? r<bigint>((c) => readTreasuryFeeBps(c, diamond)) : Promise.resolve(null),
      r<Hex>((c) => readVault(c, diamond, account)),
      r<WalletFunds>((c) => readWalletFunds(c, payAsset, account, diamond)),
      r<number>((c) => readAcceptGate(c, diamond, offerId, account)),
      r<number>((c) => readCreatorGate(c, diamond, offerId)),
      r<boolean>((c) => readFeeDiscountConsent(c, diamond, account)).catch(() => null),
    ]);
  const pay = payLeg(role, offer, preview).amount;
  const approvalSteps =
    funds.allowance >= pay ? 0 : (await allowanceSteps({ accepts: (amount) => r<boolean>((c) => tokenAcceptsApproval(c, payAsset, account, diamond, amount)) }, funds.allowance, pay)).length;
  return {
    identity,
    role,
    offerId,
    offer,
    state,
    preview,
    linkedLoanId,
    riskTermsHash,
    lendingClass,
    collateralClass,
    graceSeconds,
    lifBps,
    matcherBps,
    protocolShareBps,
    vault,
    funds,
    approvalSteps,
    gate,
    creatorGate,
    consent,
    readAt: Date.now(),
  };
}

/** What this acceptance takes from the wallet (payLeg), for the review. */
export function paid(r: Pick<AcceptReview, 'role' | 'offer' | 'preview'>): { asset: Hex; amount: bigint } {
  return payLeg(r.role, r.offer, r.preview);
}

/** Whether what the wallet pays needs an approval step before the acceptance. */
export function needsApproval(r: Pick<AcceptReview, 'funds' | 'preview' | 'role' | 'offer'>): boolean {
  return r.funds.allowance < paid(r).amount;
}

/** The wallet prompts this acceptance asks for: the signed terms, the
 *  approval when one is needed, and the acceptance itself. */
export function promptCount(r: Pick<AcceptReview, 'approvalSteps'>): number {
  return 2 + r.approvalSteps;
}

const STATE_KEYS: Readonly<Record<AcceptRole, Readonly<Record<Exclude<OfferState, 'open'>, CopyKey>>>> = {
  borrower: {
    accepted: 'borrow.stateAccepted',
    cancelled: 'borrow.stateCancelled',
    expired: 'borrow.stateExpired',
    'sale-consumed': 'borrow.stateSaleConsumed',
  },
  lender: {
    accepted: 'lend.stateAccepted',
    cancelled: 'lend.stateCancelled',
    expired: 'borrow.stateExpired',
    'sale-consumed': 'borrow.stateSaleConsumed',
  },
};

/** An ended offer's state, naming the other side for the reader's role. */
export function stateText(state: Exclude<OfferState, 'open'>, copy: Pick<CopyAccess, 'text'>, role: AcceptRole = 'borrower'): string {
  return copy.text(STATE_KEYS[role][state]);
}

const GATE_KEYS: Readonly<Record<number, CopyKey>> = { 1: 'risk.blockTier', 2: 'risk.blockConsent', 3: 'risk.blockAck', 4: 'risk.blockConsent' };

/** A risk-access block as the page states it: the other side's block is
 *  named as theirs and never sent to this wallet's settings, and a code
 *  this build cannot name is still a block. */
export function gateBlockText(b: GateBlock, copy: Pick<CopyAccess, 'text'>, role: AcceptRole = 'borrower'): string {
  if (b.creator) return copy.text(role === 'borrower' ? 'accept.blockCreatorGate' : 'lendAccept.blockCreatorGate');
  return copy.text(GATE_KEYS[b.code] ?? 'accept.blockGateOther');
}

/** The refusals whose wording names the other side or the offer's kind,
 *  written for a lender taking a borrow request; every other refusal reads
 *  the same from either side. */
const LENDER_ERRORS: Partial<Record<AcceptPreview['error'], CopyKey>> = {
  OfferAlreadyAccepted: 'lendAccept.err.OfferAlreadyAccepted',
  SanctionedCreator: 'lendAccept.err.SanctionedCreator',
  RiskAndTermsConsentRequired: 'lendAccept.err.RiskAndTermsConsentRequired',
  OfferExpired: 'lendAccept.err.OfferExpired',
  OfferPartiallyFilled: 'lendAccept.err.OfferPartiallyFilled',
  OfferIsCancelled: 'lendAccept.err.OfferIsCancelled',
  SelfTrade: 'lendAccept.err.SelfTrade',
  RefinanceRequestUntakeable: 'lendAccept.err.RefinanceRequestUntakeable',
  CadenceNotAdmitted: 'lendAccept.err.CadenceNotAdmitted',
  Unrecognised: 'lendAccept.err.Unrecognised',
};

/** The protocol's first refusal, as the page states it for the reader's role. */
export function acceptErrorText(code: AcceptPreview['error'], copy: Pick<CopyAccess, 'text' | 'format'>, role: AcceptRole = 'borrower'): string {
  // #3204 — the retired vault-version code is never produced; should an old
  // Diamond send it, it reads as the code this build cannot name.
  const error: AcceptPreview['error'] = code === 'RetiredVaultUpgradeRequired' ? 'Unrecognised' : code;
  if (error === 'ProtocolPaused')
    return copy.format('accept.err.ProtocolPaused', {
      staysOpen: SWITCH_EFFECTS['2'].staysOpen,
    });
  if (error === 'None') return '';
  const lender = role === 'lender' ? LENDER_ERRORS[error] : undefined;
  return copy.text(lender ?? (`accept.err.${error}` as CopyKey));
}

const CADENCE_KEYS: readonly (CopyKey | null)[] = [null, 'borrow.cadenceMonthly', 'borrow.cadenceQuarterly', 'borrow.cadenceSemiAnnual', 'borrow.cadenceAnnual'];

/** The schedule's name ("every month"), or null for interest at repayment. */
export function cadenceText(cadence: number, copy: Pick<CopyAccess, 'text'>): string | null {
  const key = CADENCE_KEYS[cadence];
  return key ? copy.text(key) : null;
}

/**
 * Every reason the wallet must not open for this review, in the order the
 * reader should meet them; empty when the protocol reports nothing and the
 * wallet holds what it pays. Each is a tier-A sentence with its remedy
 * where this session can offer one.
 */
export function reviewBlockers(r: AcceptReview, meta: TokenMetaMap | null, copy: Pick<CopyAccess, 'text' | 'format'>): string[] {
  const out: string[] = [];
  if (r.state !== 'open') out.push(copy.format('accept.blockState', { state: stateText(r.state, copy, r.role) }));
  else if (r.preview.error !== 'None') out.push(acceptErrorText(r.preview.error, copy, r.role));
  // A borrow-side offer linked to a loan is a sale of that loan's lender
  // position: taking it buys a running loan, which this review does not
  // describe, so it is never taken here.
  if (r.role === 'lender' && r.linkedLoanId !== 0n) out.push(copy.format('lendAccept.blockPositionSale', { id: r.linkedLoanId.toString() }));
  for (const [asset, cls] of [
    [r.offer.lendingAsset, r.lendingClass],
    [r.offer.collateralAsset, r.collateralClass],
  ] as const) {
    if (cls === 'distrusted')
      out.push(
        copy.format('accept.blockDistrusted', {
          asset: meta?.[asset.toLowerCase()]?.symbol ?? shortAddress(asset),
        }),
      );
  }
  const gate = gateBlock(r.gate, r.creatorGate);
  if (gate !== null) out.push(gateBlockText(gate, copy, r.role));
  const pay = paid(r);
  const missing = shortfall(r.funds.balance, pay.amount);
  if (missing > 0n) {
    const amt = (v: bigint) => tokenAmount(v, pay.asset, meta, copy.format);
    out.push(
      copy.format(r.role === 'borrower' ? 'accept.blockShortfall' : 'lendAccept.blockShortfall', {
        have: amt(r.funds.balance),
        missing: amt(missing),
        need: amt(pay.amount),
      }),
    );
  }
  return out;
}

function offerKey(o: StoredOffer): string {
  return JSON.stringify(o, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));
}

/** What moved between the review and a re-read of it, as the page names it,
 *  or null when nothing the receipt or the signature stands on moved. */
export function changedBetween(a: AcceptReview, b: AcceptReview, copy: Pick<CopyAccess, 'text'>): string | null {
  if (offerKey(a.offer) !== offerKey(b.offer) || a.state !== b.state || a.linkedLoanId !== b.linkedLoanId || a.riskTermsHash !== b.riskTermsHash)
    return copy.text('accept.changedOffer');
  const p = a.preview;
  const q = b.preview;
  if (
    p.effectivePrincipal !== q.effectivePrincipal ||
    p.interestRateBps !== q.interestRateBps ||
    p.collateralAmount !== q.collateralAmount ||
    p.lifEstimate !== q.lifEstimate ||
    p.collateralResidualRefund !== q.collateralResidualRefund ||
    p.error !== q.error
  )
    return copy.text('accept.changedPreview');
  if (
    a.lendingClass !== b.lendingClass ||
    a.collateralClass !== b.collateralClass ||
    a.gate !== b.gate ||
    a.creatorGate !== b.creatorGate ||
    a.graceSeconds !== b.graceSeconds ||
    a.lifBps !== b.lifBps ||
    a.matcherBps !== b.matcherBps ||
    a.protocolShareBps !== b.protocolShareBps
  )
    return copy.text('accept.changedClass');
  if (
    shortfall(a.funds.balance, paid(a).amount) !== shortfall(b.funds.balance, paid(b).amount) ||
    needsApproval(a) !== needsApproval(b) ||
    a.approvalSteps !== b.approvalSteps
  )
    return copy.text('accept.changedFunds');
  if (a.vault.toLowerCase() !== b.vault.toLowerCase()) return copy.text('accept.changedVault');
  return null;
}
