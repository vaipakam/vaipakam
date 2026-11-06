/**
 * OFF-05 / OFF-10 / OFF-14 / OFF-16 / OFF-19 — the receipt a borrower signs
 * against when posting their own request (RB-CONFIDENCE): what is locked
 * now, what a lender taking it would pay and ask back, every term the
 * request binds, and every consequence. The lender's offer has its own
 * receipt (lenderPostReceipt); `postReceipt` picks by side.
 */
import type { CopyAccess, CopyKey } from '../copy/useCopy';
import type { Posture } from '../capability/types';
import type { Receipt } from '../receipt/types';
import { assetName, tokenAmount, type TokenMetaMap } from '../reads/tokens';
import { formatBps, formatScaled, formatSpan, formatUtc } from '../ui/format';
import { pageHandoff } from '../../routes/pageMap';
import { isRanged, postFigures, ZERO, type ParsedPost } from './postModel';
import { lockedName, ltvText, needsApproval, promptCount, type LtvRead, type PostReview, type StartGate } from './postReview';
import { tariffConsequences, tariffRows } from './tariffReview';
import { scheduleConsequences, scheduleRows } from './scheduleReview';

type Hex = `0x${string}`;

const FILL_MODE_KEYS: Readonly<Record<ParsedPost['fillMode'], CopyKey>> = {
  partial: 'request.fillModePartial',
  aon: 'request.fillModeAon',
  ioc: 'request.fillModeIoc',
};

/** The largest match's loan-to-value as the collateral it may lock spans
 *  it: from everything posted to only the floor for a collateral range, and
 *  everything posted with "a match may lock less" otherwise. */
function largestText(all: LtvRead, atFloor: LtvRead | null, copy: Pick<CopyAccess, 'text' | 'format'>): string {
  if (all.kind !== 'value') return ltvText(all, copy);
  if (atFloor === null) return copy.format('request.ltvAllLocked', { ltv: formatBps(all.bps) });
  if (atFloor.kind !== 'value') return ltvText(atFloor, copy);
  return copy.format('request.ltvSpan', { low: formatBps(all.bps), high: formatBps(atFloor.bps) });
}

/** The start-of-loan limit row (Advanced detail): the figure read now, or
 *  that it could not be read; nothing for a pair it does not apply to. */
function startRows(start: StartGate, copy: Pick<CopyAccess, 'text' | 'format'>): Receipt['rows'] {
  if (start.kind === 'none') return [];
  const value =
    start.kind === 'unread' ? copy.text('request.hfFloorUnread') : copy.format(start.tiered ? 'request.hfFloorTiered' : 'request.hfFloor', { hf: formatScaled(start.floor) });
  return [{ label: copy.text('request.rowHfFloor'), value: { kind: 'text', text: value }, binding: false }];
}

/** The receipt (RB-CONFIDENCE): what is locked now, what a lender taking it
 *  would pay and ask back, every term the request binds, and every
 *  consequence. For a range (OFF-10) it states both ends: what a lender
 *  taking it directly lends and what the largest match can lend, with the
 *  risk at each (OFF-16). `advanced` adds the panel detail, the live
 *  start-of-loan health factor; every risk warning stays in Basic. */
export function requestReceipt(r: PostReview, meta: TokenMetaMap | null, copy: Pick<CopyAccess, 'text' | 'format'>, advanced = false, keeper: Posture = 'unknown'): Receipt {
  const { text, format } = copy;
  const { parsed, pair } = r.draft;
  const f = postFigures(parsed.amount, parsed.rateBps, parsed.durationDays, r.lifBps);
  const ranged = isRanged(parsed);
  const largest = ranged ? postFigures(parsed.amountMax, parsed.rateBps, parsed.durationDays, r.lifBps) : null;
  const returned = parsed.collateral - parsed.collateralFloor;
  const amount = (asset: Hex, value: bigint) => ({ kind: 'amount' as const, asset, amount: value });
  const textRow = (label: CopyKey, value: string, binding: boolean) => ({ label: text(label), value: { kind: 'text' as const, text: value }, binding });
  const illiquid = r.lendingClass === 'illiquid' || r.collateralClass === 'illiquid';
  const h = r.holding;
  const tokenName = lockedName(h, pair.collateral, meta, format);
  const collection = assetName(pair.collateral, meta);

  const rows: Receipt['rows'] = [
    h.kind === 'erc20'
      ? { label: text('request.rowLock'), value: amount(pair.collateral, parsed.collateral), binding: true, movesOut: true }
      : { label: text('request.rowLock'), value: { kind: 'text', text: tokenName }, binding: true, movesOut: true },
    ...(h.kind === 'erc20' && returned > 0n
      ? [
          { label: text('request.rowFloor'), value: amount(pair.collateral, parsed.collateralFloor), binding: true },
          { label: text('request.rowReturned'), value: amount(pair.collateral, returned), binding: true },
        ]
      : []),
    textRow('accept.rowVault', r.vault === ZERO ? text('accept.vaultNew') : r.vault, false),
    ...(ranged
      ? [
          { label: text('request.rowAmountMin'), value: amount(pair.lending, parsed.amount), binding: true },
          { label: text('request.rowAmountMax'), value: amount(pair.lending, parsed.amountMax), binding: true },
          textRow('request.rowWhole', text('request.rangeFill'), true),
        ]
      : [{ label: text('request.rowAmount'), value: amount(pair.lending, parsed.amount), binding: true }, textRow('request.rowWhole', text('request.whole'), true)]),
    // With one amount the default mode is one lender for all of it, which
    // the row above already says; only a mode that changes that is stated.
    ...(ranged || parsed.fillMode !== 'partial' ? [textRow('request.rowFill', text(FILL_MODE_KEYS[parsed.fillMode]), true)] : []),
    ...(ranged
      ? [textRow('request.rowMatching', text(r.risk.partialFill === null ? 'request.matchingUnread' : r.risk.partialFill ? 'request.matchingOn' : 'request.matchingOff'), false)]
      : []),
    textRow('accept.rowRate', format('accept.rate', { rate: formatBps(parsed.rateBps) }), true),
    textRow('accept.rowDue', format('request.due', { days: String(parsed.durationDays) }), true),
    // Not bound by the request or the loan: the grace period is read from the
    // live configuration when it is applied, so it is today's figure.
    textRow('accept.rowGrace', format('accept.grace', { span: formatSpan(Number(r.graceSeconds)) }), false),
    // Not bound by the request: the fee is set when a lender takes it, at the
    // rate in force then, so these are today's figures, labelled as such.
    { label: text('request.rowReceive'), value: amount(pair.lending, f.received), binding: false },
    { label: text('accept.rowFee'), value: amount(pair.lending, f.fee), binding: false },
    textRow('accept.rowFeeRule', format('request.feeRule', { rate: formatBps(r.lifBps) }), false),
    // With a schedule the figure is the whole term's interest, and the
    // instalments paid along the way count toward it, so it is labelled as a
    // total rather than as what is left to pay at the due date.
    {
      label: text(parsed.cadence !== 0 ? (ranged ? 'request.rowOweDirectTotal' : 'accept.rowOweTotal') : ranged ? 'request.rowOweDirect' : 'accept.rowOwe'),
      value: amount(pair.lending, f.owedAtDue),
      binding: true,
    },
    ...(largest
      ? [{ label: text(parsed.cadence !== 0 ? 'request.rowOweLargestTotal' : 'request.rowOweLargest'), value: amount(pair.lending, largest.owedAtDue), binding: true }]
      : []),
    textRow('accept.rowInterest', text(parsed.fullTerm ? (parsed.allowsPartialRepay ? 'accept.fullTermPartial' : 'accept.fullTerm') : 'accept.proRata'), true),
    ...scheduleRows(r, meta, copy, advanced, keeper),
    ...tariffRows(r.tariff, parsed, copy),
    textRow('accept.rowPartial', text(parsed.allowsPartialRepay ? 'accept.partialYes' : 'accept.partialNo'), true),
    textRow('accept.rowPrepayListing', text('accept.prepayListingNo'), true),
    textRow('accept.rowParallelSale', text('accept.parallelNo'), true),
    textRow('accept.rowRefinance', text('accept.refinanceNone'), true),
    r.draft.expiresAt === 0n
      ? textRow('request.rowExpiry', text('request.expiryNever'), true)
      : textRow('request.rowExpiry', format('request.expiryAt', { time: formatUtc(Number(r.draft.expiresAt)) }), true),
    textRow('request.rowLtvDirect', illiquid ? text('request.ltvIlliquid') : ltvText(r.risk.direct, copy), false),
    ...(r.risk.largest ? [textRow('request.rowLtvLargest', illiquid ? text('request.ltvIlliquid') : largestText(r.risk.largest, r.risk.largestAtFloor, copy), false)] : []),
    ...(advanced ? startRows(r.risk.start, copy) : []),
    {
      label: text('accept.rowApproval'),
      value: {
        kind: 'text',
        text: !needsApproval(r)
          ? h.kind === 'erc1155'
            ? format('request.approvalOperatorEnough', { collection })
            : text(h.kind === 'erc721' ? 'request.approvalTokenEnough' : 'accept.approvalEnough')
          : h.kind === 'erc721'
            ? format('request.approvalToken', { token: tokenName })
            : h.kind === 'erc1155'
              ? format('request.approvalOperator', { collection })
              : format(h.approvalSteps === 2 ? 'request.approvalZeroFirst' : 'request.approvalNeeded', { amount: tokenAmount(parsed.collateral, pair.collateral, meta, format) }),
      },
      binding: false,
      movesOut: needsApproval(r),
    },
  ];

  // Where the request is followed and cancelled after posting: said before
  // the collateral locks, not discovered afterwards (pageHandoff).
  const manage = pageHandoff('/offers');
  const consequences = [
    text('request.loseLocked'),
    ...(manage.kind === 'here' ? [] : [text(manage.kind === 'currentApp' ? 'request.manageElsewhere' : 'request.manageNowhere')]),
    text(r.draft.expiresAt === 0n ? 'request.loseOpen' : 'request.loseLapse'),
    text('request.loseTaken'),
    ...rangeConsequences(r, meta, copy),
    ...matchConsequences(r, meta, copy),
    ...scheduleConsequences(r, copy),
    ...tariffConsequences(r.tariff, copy),
    text('accept.loseDefault'),
    ...(r.lendingClass === 'illiquid' ? [text('accept.loseIlliquidLending')] : []),
    ...(r.collateralClass === 'illiquid' ? [text('accept.loseIlliquidCollateral')] : []),
    ...(!illiquid ? [text('accept.loseLiquidation')] : []),
    text(parsed.fullTerm ? (parsed.allowsPartialRepay ? 'accept.loseFullTermPartial' : 'accept.loseFullTerm') : 'accept.loseProRata'),
    text('accept.losePause'),
    text('request.loseBinding'),
  ];

  return { title: text('request.title'), rows, consequences, prompts: promptCount(r), readAt: r.readAt };
}

/**
 * OFF-16 — what a match can do that a direct take cannot, tier A and in
 * Basic, for ERC-20 collateral while matching is on or not known to be off.
 * A match locks only the collateral its lender asks for (at least the floor
 * for a collateral range; otherwise only the requirement), so for a priced
 * pair a matched loan can start riskier than the figures shown, bounded only
 * by the protocol's start-of-loan limit (with an unpriced leg no
 * loan-to-value applies). Whatever the pair, the collateral a match does not
 * lock stays committed to the request for later matches: the protocol
 * returns it only when the request closes or is cancelled, never per match.
 */
export function matchConsequences(r: PostReview, meta: TokenMetaMap | null, copy: Pick<CopyAccess, 'text' | 'format'>): string[] {
  const { parsed, pair } = r.draft;
  if (r.risk.partialFill === false || r.holding.kind !== 'erc20') return [];
  const out: string[] = [];
  if (r.risk.start.kind !== 'none') {
    out.push(
      parsed.collateralFloor < parsed.collateral
        ? copy.format('request.loseMatchLocksFloor', { floor: tokenAmount(parsed.collateralFloor, pair.collateral, meta, copy.format) })
        : copy.text('request.loseMatchLocksLess'),
    );
  }
  out.push(copy.text('request.loseMatchKeepsRest'));
  return out;
}

/** OFF-10 / OFF-11 / OFF-16 — what a range and a fill mode add to the
 *  "You can lose" list, all tier A and all in Basic: the direct point over
 *  the protocol's limit (or not known to be within it), the matching switch
 *  off, and a fill mode that cannot be changed later. */
export function rangeConsequences(r: PostReview, meta: TokenMetaMap | null, copy: Pick<CopyAccess, 'text' | 'format'>): string[] {
  const { parsed, pair } = r.draft;
  const out: string[] = [];
  if (isRanged(parsed)) {
    const risk = r.risk;
    if (risk.directWithinLimit === 'over') {
      out.push(
        risk.directCeiling === null
          ? copy.text('request.loseDirectOverPlain')
          : copy.format('request.loseDirectOver', {
              floor: tokenAmount(parsed.collateralFloor, pair.collateral, meta, copy.format),
              ceiling: tokenAmount(risk.directCeiling, pair.lending, meta, copy.format),
            }),
      );
    } else if (risk.directWithinLimit === 'unknown') out.push(copy.text('request.loseDirectUnknown'));
    if (risk.partialFill === false) out.push(copy.text('request.loseMatchingOff'));
    else if (risk.partialFill === null) out.push(copy.text('request.loseMatchingUnread'));
  }
  if (isRanged(parsed) || parsed.fillMode !== 'partial') out.push(copy.text('request.loseFillFixed'));
  return out;
}
