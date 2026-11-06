/**
 * OFF-50 / OFF-17 / OFF-19 / OFF-29 — what a borrower's acceptance review
 * stands on, read in one go through the wallet's connection, and the rules
 * that turn it into the receipt, the blockers stated in place, and the
 * "what changed" of a re-check. The protocol's preview is the source of
 * truth for every figure; the review never computes an amount the protocol
 * reports.
 */
import type { OwnStateClient } from '../../chain/ownRail';
import type { CopyAccess, CopyKey } from '../../shared/copy/useCopy';
import { readFeeDiscountConsent } from '../../shared/consent/feeDiscount';
import { readAssetClass, type AssetClass } from '../../shared/offers/assets';
import type { StoredOffer } from '../../shared/offers/acceptTerms';
import { acceptFigures, listFee, shortfall } from '../../shared/offers/model';
import {
  readAcceptGate,
  readGraceSeconds,
  readLifBps,
  readLifMatcherBps,
  readLinkedLoanId,
  readOffer,
  readOfferState,
  readPreview,
  readRiskTermsHash,
  readVault,
  readWalletFunds,
  type AcceptPreview,
  type OfferState,
  type WalletFunds,
} from '../../shared/offers/reads';
import type { Receipt } from '../../shared/receipt/types';
import { SWITCH_EFFECTS } from '../../shared/eligibility/switchClasses';
import { tokenAmount, type TokenMetaMap } from '../../shared/reads/tokens';
import { formatBps, formatSpan, shortAddress } from '../../shared/ui/format';

type Hex = `0x${string}`;

export const ZERO: Hex = '0x0000000000000000000000000000000000000000';

export interface AcceptReview {
  /** The wallet and network the review was read under (RB-REVIEW). */
  identity: string;
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
  /** The borrower's vault; the zero address when it is opened by this accept. */
  vault: Hex;
  funds: WalletFunds;
  /** The risk-access gate's code for this acceptor (0 = open). */
  gate: number;
  /** The fee-discount setting; null when it could not be read. */
  consent: boolean | null;
  readAt: number;
}

export async function readAcceptReview(own: OwnStateClient, diamond: Hex, offerId: bigint, identity: string): Promise<AcceptReview> {
  const account = own.account;
  const r = <T>(fn: Parameters<OwnStateClient['read']>[0]) => own.read(fn).then((x) => x.value as T);
  const offer = await r<StoredOffer>((c) => readOffer(c, diamond, offerId));
  const [state, preview, linkedLoanId, riskTermsHash, lendingClass, collateralClass, graceSeconds, lifBps, matcherBps, vault, funds, gate, consent] = await Promise.all([
    r<OfferState>((c) => readOfferState(c, diamond, offerId)),
    r<AcceptPreview>((c) => readPreview(c, diamond, offerId, account)),
    r<bigint>((c) => readLinkedLoanId(c, diamond, offerId)),
    r<Hex>((c) => readRiskTermsHash(c, diamond)),
    r<AssetClass>((c) => readAssetClass(c, diamond, offer.lendingAsset)),
    r<AssetClass>((c) => readAssetClass(c, diamond, offer.collateralAsset)),
    r<bigint>((c) => readGraceSeconds(c, diamond, offer.durationDays)),
    r<bigint>((c) => readLifBps(c, diamond)),
    r<bigint>((c) => readLifMatcherBps(c, diamond)),
    r<Hex>((c) => readVault(c, diamond, account)),
    r<WalletFunds>((c) => readWalletFunds(c, offer.collateralAsset, account, diamond)),
    r<number>((c) => readAcceptGate(c, diamond, offerId, account)),
    r<boolean>((c) => readFeeDiscountConsent(c, diamond, account)).catch(() => null),
  ]);
  return {
    identity,
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
    vault,
    funds,
    gate,
    consent,
    readAt: Date.now(),
  };
}

/** Whether the collateral needs an approval step before the acceptance. */
export function needsApproval(r: Pick<AcceptReview, 'funds' | 'preview'>): boolean {
  return r.funds.allowance < r.preview.collateralAmount;
}

/** The wallet prompts this acceptance asks for: the signed terms, the
 *  approval when one is needed, and the acceptance itself. */
export function promptCount(r: Pick<AcceptReview, 'funds' | 'preview'>): number {
  return needsApproval(r) ? 3 : 2;
}

const STATE_KEYS: Readonly<Record<Exclude<OfferState, 'open'>, CopyKey>> = {
  accepted: 'borrow.stateAccepted',
  cancelled: 'borrow.stateCancelled',
  expired: 'borrow.stateExpired',
  'sale-consumed': 'borrow.stateSaleConsumed',
};

export function stateText(state: Exclude<OfferState, 'open'>, copy: Pick<CopyAccess, 'text'>): string {
  return copy.text(STATE_KEYS[state]);
}

/** The protocol's first refusal, as the page states it. */
export function acceptErrorText(error: AcceptPreview['error'], copy: Pick<CopyAccess, 'text' | 'format'>): string {
  if (error === 'ProtocolPaused')
    return copy.format('accept.err.ProtocolPaused', {
      staysOpen: SWITCH_EFFECTS['2'].staysOpen,
    });
  if (error === 'None') return '';
  return copy.text(`accept.err.${error}` as CopyKey);
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
 * wallet holds the collateral. Each is a tier-A sentence with its remedy
 * where this session can offer one.
 */
export function reviewBlockers(r: AcceptReview, meta: TokenMetaMap | null, copy: Pick<CopyAccess, 'text' | 'format'>): string[] {
  const out: string[] = [];
  if (r.state !== 'open') out.push(copy.format('accept.blockState', { state: stateText(r.state, copy) }));
  else if (r.preview.error !== 'None') out.push(acceptErrorText(r.preview.error, copy));
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
  if (r.gate === 1) out.push(copy.text('accept.blockGate1'));
  if (r.gate === 2) out.push(copy.text('accept.blockGate2'));
  if (r.gate === 3) out.push(copy.text('accept.blockGate3'));
  const missing = shortfall(r.funds.balance, r.preview.collateralAmount);
  if (missing > 0n) {
    const amt = (v: bigint) => tokenAmount(v, r.offer.collateralAsset, meta, copy.format);
    out.push(
      copy.format('accept.blockShortfall', {
        have: amt(r.funds.balance),
        missing: amt(missing),
        need: amt(r.preview.collateralAmount),
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
    a.graceSeconds !== b.graceSeconds ||
    a.lifBps !== b.lifBps ||
    a.matcherBps !== b.matcherBps
  )
    return copy.text('accept.changedClass');
  if (shortfall(a.funds.balance, a.preview.collateralAmount) !== shortfall(b.funds.balance, b.preview.collateralAmount) || needsApproval(a) !== needsApproval(b))
    return copy.text('accept.changedFunds');
  if (a.vault.toLowerCase() !== b.vault.toLowerCase()) return copy.text('accept.changedVault');
  return null;
}

/** The receipt (RB-CONFIDENCE): what arrives, what is locked, what is
 *  owed and when, the fee and its rule, and every consequence. */
export function acceptReceipt(r: AcceptReview, meta: TokenMetaMap | null, copy: Pick<CopyAccess, 'text' | 'format'>): Receipt {
  const { text, format } = copy;
  const o = r.offer;
  const f = acceptFigures(r.preview, o.durationDays, r.matcherBps);
  const lending = o.lendingAsset;
  const collateral = o.collateralAsset;
  const amount = (asset: Hex, value: bigint) => ({
    kind: 'amount' as const,
    asset,
    amount: value,
  });
  const cadence = cadenceText(o.periodicInterestCadence, copy);
  const discounted = f.fee < listFee(f.principal, r.lifBps);
  const illiquid = r.lendingClass === 'illiquid' || r.collateralClass === 'illiquid';

  const rows: Receipt['rows'] = [
    {
      label: text('accept.rowReceive'),
      value: amount(lending, f.received),
      binding: true,
    },
    {
      label: text('accept.rowFee'),
      value: amount(lending, f.fee),
      binding: true,
    },
    ...(f.feeBack > 0n
      ? [
          {
            label: text('accept.rowFeeBack'),
            value: amount(lending, f.feeBack),
            binding: true,
          },
        ]
      : []),
    {
      label: text('accept.rowFeeRule'),
      value: {
        kind: 'text',
        text: format(discounted ? 'accept.feeDiscounted' : 'accept.feeRule', {
          rate: formatBps(r.lifBps),
        }),
      },
      binding: false,
    },
    {
      label: text('accept.rowPrincipal'),
      value: amount(lending, f.principal),
      binding: true,
    },
    {
      label: text('accept.rowLock'),
      value: amount(collateral, f.collateral),
      binding: true,
    },
    ...(f.refund > 0n
      ? [
          {
            label: text('accept.rowRefund'),
            value: amount(collateral, f.refund),
            binding: true,
          },
        ]
      : []),
    {
      label: text('accept.rowRate'),
      value: {
        kind: 'text',
        text: format('accept.rate', { rate: formatBps(f.rateBps) }),
      },
      binding: true,
    },
    {
      label: text('accept.rowOwe'),
      value: amount(lending, f.owedAtDue),
      binding: true,
    },
    {
      label: text('accept.rowDue'),
      value: {
        kind: 'text',
        text: format('accept.due', { days: o.durationDays.toString() }),
      },
      binding: true,
    },
    {
      label: text('accept.rowGrace'),
      value: {
        kind: 'text',
        text: format('accept.grace', {
          span: formatSpan(Number(r.graceSeconds)),
        }),
      },
      binding: true,
    },
    {
      label: text('accept.rowInterest'),
      value: {
        kind: 'text',
        text: text(o.useFullTermInterest ? (o.allowsPartialRepay ? 'accept.fullTermPartial' : 'accept.fullTerm') : 'accept.proRata'),
      },
      binding: true,
    },
    {
      label: text('accept.rowSchedule'),
      value: {
        kind: 'text',
        text: cadence ? format('accept.scheduleEvery', { cadence }) : text('accept.scheduleNone'),
      },
      binding: true,
    },
    {
      label: text('accept.rowVault'),
      value: {
        kind: 'text',
        text: r.vault === ZERO ? text('accept.vaultNew') : r.vault,
      },
      binding: false,
    },
    {
      label: text('accept.rowLender'),
      value: { kind: 'text', text: o.creator },
      binding: false,
    },
    {
      label: text('accept.rowApproval'),
      value: {
        kind: 'text',
        text: needsApproval(r)
          ? format('accept.approvalNeeded', {
              amount: tokenAmount(f.collateral, collateral, meta, format),
            })
          : text('accept.approvalEnough'),
      },
      binding: false,
    },
  ];

  const consequences = [
    text('accept.loseDefault'),
    illiquid ? text('accept.loseIlliquid') : text('accept.loseLiquidation'),
    text('accept.loseLocked'),
    text(o.useFullTermInterest ? (o.allowsPartialRepay ? 'accept.loseFullTermPartial' : 'accept.loseFullTerm') : 'accept.loseProRata'),
    ...(cadence ? [format('accept.loseCadence', { cadence })] : []),
    text('accept.loseBinding'),
  ];

  return {
    title: format('accept.title', { id: r.offerId.toString() }),
    rows,
    consequences,
    prompts: promptCount(r),
    readAt: r.readAt,
  };
}
