/**
 * OFF-06 — the receipt a lender signs against when posting their own
 * lending offer (RB-CONFIDENCE): the amount that moves into their vault now
 * and stays locked while the offer is open, the collateral every borrower
 * must lock, what a borrower taking it would receive and the fee taken on
 * the way, the interest at the due date and the most the protocol keeps of
 * it, what comes back, every term the offer binds, and every consequence.
 * A figure that rests on today's setting (the fee, the protocol's share,
 * the grace period, the loan-to-value) says so.
 * A borrower taking the offer directly borrows its whole amount, so the
 * figures are the whole amount's. OFF-10 / OFF-11 (Advanced): a range adds
 * the smallest part one match may lend and the least collateral that part
 * asks, and a fill mode other than the default is stated with what it
 * means; both are fixed once posted. OFF-14 / OFF-22 (Advanced): an interest
 * schedule states each period's interest on all of it and on the smallest
 * part, and the Full fee tariff states what it costs and what it gives the
 * lender (10 more points of discount on the protocol's share of the loan's
 * interest, for its term), armed by its own transaction after posting.
 */
import type { CopyAccess, CopyKey } from '../copy/useCopy';
import type { Posture } from '../capability/types';
import type { Receipt } from '../receipt/types';
import { exactTokenAmount, tokenAmount, type TokenMetaMap } from '../reads/tokens';
import { formatBps, formatSpan, formatUtc } from '../ui/format';
import { pageHandoff } from '../../routes/pageMap';
import { isRanged, lenderPostFigures, partCollateral, ZERO, type ParsedPost } from './postModel';
import { ltvText, needsApproval, promptCount, stakeOfDraft, type PostReview } from './postReview';
import { scheduleConsequences, scheduleRows } from './scheduleReview';
import { tariffConsequences, tariffRows } from './tariffReview';

type Hex = `0x${string}`;

const FILL_MODE_KEYS: Readonly<Record<ParsedPost['fillMode'], CopyKey>> = {
  partial: 'request.fillModePartial',
  aon: 'request.fillModeAon',
  ioc: 'request.fillModeIoc',
};

export function lenderPostReceipt(r: PostReview, meta: TokenMetaMap | null, copy: Pick<CopyAccess, 'text' | 'format'>, advanced = false, keeper: Posture = 'unknown'): Receipt {
  const { text, format } = copy;
  const { parsed, pair } = r.draft;
  const stake = stakeOfDraft(r.draft);
  const shareBps = r.protocolShareBps;
  // A direct take borrows the whole amount (`acceptOffer` sizes a lending
  // offer's loan at its largest amount), so the figures are the whole amount's.
  const f = lenderPostFigures(parsed.amountMax, parsed.rateBps, parsed.durationDays, r.lifBps, shareBps ?? 0n);
  const ranged = isRanged(parsed);
  const amount = (asset: Hex, value: bigint) => ({ kind: 'amount' as const, asset, amount: value });
  const textRow = (label: CopyKey, value: string, binding: boolean) => ({ label: text(label), value: { kind: 'text' as const, text: value }, binding });
  const illiquid = r.lendingClass === 'illiquid' || r.collateralClass === 'illiquid';
  const approvalSteps = r.holding.kind === 'erc20' ? r.holding.approvalSteps : 0;

  const rows: Receipt['rows'] = [
    { label: text('lendOffer.rowLock'), value: amount(stake.asset, stake.amount), binding: true, movesOut: true },
    textRow('accept.rowVault', r.vault === ZERO ? text('accept.vaultNew') : r.vault, false),
    { label: text('lendOffer.rowAmount'), value: amount(pair.lending, parsed.amountMax), binding: true },
    ...(ranged
      ? [{ label: text('lendOffer.rowPartMin'), value: amount(pair.lending, parsed.amount), binding: true }, textRow('request.rowWhole', text('lendOffer.rangeFill'), true)]
      : [textRow('request.rowWhole', text('lendOffer.whole'), true)]),
    // With one amount the default mode is one borrower for all of it, which
    // the row above already says; only a mode that changes that is stated.
    ...(ranged || parsed.fillMode !== 'partial' ? [textRow('request.rowFill', text(FILL_MODE_KEYS[parsed.fillMode]), true)] : []),
    textRow('lendOffer.rowMatching', text(r.risk.partialFill === null ? 'request.matchingUnread' : r.risk.partialFill ? 'lendOffer.matchingOn' : 'lendOffer.matchingOff'), false),
    { label: text(ranged ? 'lendOffer.rowCollateralWhole' : 'lendOffer.rowCollateral'), value: amount(pair.collateral, parsed.collateral), binding: true },
    ...(ranged
      ? [{ label: text('lendOffer.rowCollateralPart'), value: amount(pair.collateral, partCollateral(parsed.collateral, parsed.amount, parsed.amountMax)), binding: true }]
      : []),
    textRow('accept.rowRate', format('accept.rate', { rate: formatBps(parsed.rateBps) }), true),
    textRow('accept.rowDue', format('lendOffer.due', { days: String(parsed.durationDays) }), true),
    // Not bound by the offer or the loan: the grace period is read from the
    // live configuration when it is applied, so it is today's figure.
    textRow('accept.rowGrace', format('accept.grace', { span: formatSpan(Number(r.graceSeconds)) }), false),
    // The fee is the borrower's, set when a borrower takes the offer at the
    // rate in force then and lowered by their discount tier: today's figure.
    { label: text(ranged ? 'lendOffer.rowBorrowerGetsWhole' : 'lendOffer.rowBorrowerGets'), value: amount(pair.lending, f.borrowerGets), binding: false },
    { label: text('lendAccept.rowFee'), value: amount(pair.lending, f.fee), binding: false },
    textRow('accept.rowFeeRule', format('lendOffer.feeRule', { rate: formatBps(r.lifBps) }), false),
    // With a schedule the figure is the whole term's interest, and the
    // instalments paid along the way count toward it.
    {
      label: text(
        parsed.cadence !== 0 ? (ranged ? 'lendOffer.rowInterestWholeTotal' : 'lendAccept.rowInterestTotal') : ranged ? 'lendOffer.rowInterestWhole' : 'lendAccept.rowInterestDue',
      ),
      value: amount(pair.lending, f.interest),
      binding: true,
    },
    // Today's setting: the loan fixes the share in force when it opens, and
    // a fee-discount tier can lower it when interest is paid. A share that
    // could not be read is said, never shown as zero.
    shareBps === null
      ? textRow('lendAccept.rowShare', text('lendOffer.shareUnread'), false)
      : textRow('lendAccept.rowShare', format('lendAccept.share', { rate: formatBps(shareBps), amount: tokenAmount(f.protocolShare, pair.lending, meta, format) }), false),
    ...(shareBps === null ? [] : [{ label: text(ranged ? 'lendOffer.rowBackWhole' : 'lendAccept.rowBack'), value: amount(pair.lending, f.backAtDue), binding: false }]),
    textRow('accept.rowInterest', text(parsed.fullTerm ? (parsed.allowsPartialRepay ? 'lendAccept.fullTermPartial' : 'lendAccept.fullTerm') : 'lendAccept.proRata'), true),
    ...scheduleRows(r, meta, copy, advanced, keeper),
    ...tariffRows(r.tariff, parsed, copy, 'lender'),
    textRow('accept.rowPartial', text(parsed.allowsPartialRepay ? 'lendAccept.partialYes' : 'lendAccept.partialNo'), true),
    textRow('accept.rowPrepayListing', text('accept.prepayListingNo'), true),
    textRow('accept.rowParallelSale', text('accept.parallelNo'), true),
    textRow('accept.rowRefinance', text('accept.refinanceNone'), true),
    r.draft.expiresAt === 0n
      ? textRow('lendOffer.rowExpiry', text('request.expiryNever'), true)
      : textRow('lendOffer.rowExpiry', format('request.expiryAt', { time: formatUtc(Number(r.draft.expiresAt)) }), true),
    textRow(ranged ? 'lendOffer.rowLtvAny' : 'lendOffer.rowLtv', illiquid ? text('request.ltvIlliquid') : ltvText(r.risk.direct, copy, 'lender'), false),
    {
      label: text('accept.rowApproval'),
      value: {
        kind: 'text',
        text: !needsApproval(r)
          ? text('accept.approvalEnough')
          : format(approvalSteps === 2 ? 'request.approvalZeroFirst' : 'request.approvalNeeded', { amount: exactTokenAmount(stake.amount, stake.asset, meta, format) }),
      },
      binding: false,
      movesOut: needsApproval(r),
    },
  ];

  // Where the offer is followed and cancelled after posting: said before
  // the amount locks, not discovered afterwards (pageHandoff).
  const manage = pageHandoff('/offers');
  const consequences = [
    text('lendOffer.loseLocked'),
    ...(manage.kind === 'here' ? [] : [text(manage.kind === 'currentApp' ? 'lendOffer.manageElsewhere' : 'lendOffer.manageNowhere')]),
    text(r.draft.expiresAt === 0n ? 'lendOffer.loseOpen' : 'lendOffer.loseLapse'),
    text('lendOffer.loseTaken'),
    ...matchConsequences(r, meta, copy),
    ...scheduleConsequences(r, copy),
    ...tariffConsequences(r.tariff, copy, 'lender'),
    text('lendAccept.loseDefault'),
    ...(r.lendingClass === 'illiquid' ? [text('lendAccept.loseIlliquidLending')] : []),
    ...(r.collateralClass === 'illiquid' ? [text('lendAccept.loseIlliquidCollateral')] : []),
    ...(!illiquid ? [text('lendAccept.loseLiquidation')] : []),
    text('lendAccept.loseLocked'),
    text(parsed.fullTerm ? (parsed.allowsPartialRepay ? 'lendAccept.loseFullTermPartial' : 'lendAccept.loseFullTerm') : 'lendAccept.loseProRata'),
    text('lendAccept.loseShare'),
    text('lendAccept.losePosition'),
    text('lendAccept.losePause'),
    text('lendOffer.loseBinding'),
  ];

  return { title: text('lendOffer.title'), rows, consequences, prompts: promptCount(r), readAt: r.readAt };
}

/**
 * OFF-10 / OFF-11 — what matching means for a lending offer, tier A and in
 * Basic. A single-amount offer matched against a request lends its whole
 * amount at its one rate, against at least the collateral it asks for
 * (`LibOfferMatch`). A range is lent by matches in parts of at least the
 * smallest part, each asking at least a matching share of the collateral
 * (rounded down), until less than that part is left, which the protocol
 * returns to the lender's wallet as it closes the offer; once a match has
 * lent a part, no borrower can take the rest directly (`acceptOffer`
 * refuses a partly filled offer). While matching is off, matchers refuse.
 * The switch is stated in each state (on, off, unread), since it can
 * change while the offer is open (RB-SWITCH). A fill mode is fixed once
 * posted.
 */
export function matchConsequences(r: PostReview, meta: TokenMetaMap | null, copy: Pick<CopyAccess, 'text' | 'format'>): string[] {
  const { text, format } = copy;
  const { parsed, pair } = r.draft;
  const sw = r.risk.partialFill;
  if (!isRanged(parsed)) {
    return [
      text(sw === null ? 'lendOffer.loseMatchUnread' : sw ? 'lendOffer.loseMatch' : 'lendOffer.loseMatchOff'),
      ...(parsed.fillMode !== 'partial' ? [text('lendOffer.loseFillFixed')] : []),
    ];
  }
  const part = tokenAmount(parsed.amount, pair.lending, meta, format);
  return [
    format('lendOffer.loseRangeParts', { part }),
    text(sw === null ? 'lendOffer.loseRangeMatchUnread' : sw ? 'lendOffer.loseRangeMatch' : 'lendOffer.loseRangeMatchOff'),
    text('lendOffer.loseRangeNoDirect'),
    text('lendOffer.loseRangeShare'),
    text('lendOffer.loseFillFixed'),
  ];
}
