/**
 * OFF-14 — an interest schedule in a post's review, for either side: the
 * receipt rows that state each period's interest, its grace and who may
 * settle a missed period, and what a schedule adds to "You can lose" (a
 * missed period is paid from a sale of part of the borrower's collateral,
 * and the schedule is fixed once posted), worded for the side posting.
 */
import type { CopyAccess, CopyKey } from '../copy/useCopy';
import type { Posture } from '../capability/types';
import { CADENCE_NAME, INTERVAL_DAYS, periodInterest } from '../offers/cadence';
import { figured, textValue, type Receipt, type ReceiptText } from '../receipt/types';
import { tokenAmount, type TokenMetaMap } from '../reads/tokens';
import { formatSpan } from '../ui/format';
import { isRanged } from './postModel';
import { TARIFF_KEYS } from './postCopy';
import type { PostReview } from './postReview';


/**
 * OFF-14 — the schedule rows, for either side. Interest at repayment is one
 * bound line. A schedule states each period's interest as the protocol
 * expects it (a request: on the direct loan, its smallest amount, and on the
 * largest loan a match can make; an offer: on all of it, what a borrower
 * taking it directly borrows, and on a loan of its smallest part), the grace
 * a missed period gets (today's figure, read live), and, in Advanced, who
 * may settle a missed period: anyone, with the keeper service's arming
 * stated as the capability service reports it (RB-SWITCH class 4, unknown
 * by default).
 */
export function scheduleRows(r: PostReview, meta: TokenMetaMap | null, copy: Pick<CopyAccess, 'text' | 'format'>, advanced: boolean, keeper: Posture): Receipt['rows'] {
  const { text, format } = copy;
  const { parsed, pair } = r.draft;
  const row = (label: CopyKey, value: ReceiptText, binding: boolean) => ({ label: text(label), value: textValue(value), binding });
  if (parsed.cadence === 0) return [row('accept.rowSchedule', text('accept.scheduleNone'), true)];
  const days = String(INTERVAL_DAYS[parsed.cadence]);
  const owe = (principal: bigint) =>
    figured((x) => format('request.periodOwe', { amount: tokenAmount(periodInterest(principal, parsed.rateBps, parsed.cadence), pair.lending, meta, format, x), days }));
  const ranged = isRanged(parsed);
  const periods =
    r.draft.side === 'lender'
      ? ranged
        ? [row('lendOffer.rowPeriodWhole', owe(parsed.amountMax), true), row('lendOffer.rowPeriodPart', owe(parsed.amount), true)]
        : [row('request.rowPeriod', owe(parsed.amountMax), true)]
      : ranged
        ? [row('request.rowPeriodDirect', owe(parsed.amount), true), row('request.rowPeriodLargest', owe(parsed.amountMax), true)]
        : [row('request.rowPeriod', owe(parsed.amount), true)];
  return [
    row('accept.rowSchedule', format('accept.scheduleEvery', { cadence: text(CADENCE_NAME[parsed.cadence]) }), true),
    ...periods,
    // Today's figure: the grace is read from the live configuration when a
    // period is settled, so the request does not bind it.
    row(
      'request.rowPeriodGrace',
      r.periodGraceSeconds !== null ? format('accept.grace', { span: formatSpan(Number(r.periodGraceSeconds)) }) : text('request.periodGraceUnread'),
      false,
    ),
    ...(advanced
      ? [row('request.rowPeriodSettle', text(keeper === 'present' ? 'request.settleArmed' : keeper === 'absent' ? 'request.settleOff' : 'request.settleUnknown'), false)]
      : []),
  ];
}

/** OFF-14 — what a schedule adds to the "You can lose" list, tier A and in
 *  Basic: a missed period is settled by selling the borrower's collateral
 *  (with the grace when it was read), paying the lender, and the schedule is
 *  fixed once posted. */
export function scheduleConsequences(r: PostReview, copy: Pick<CopyAccess, 'text' | 'format'>): string[] {
  const { parsed } = r.draft;
  if (parsed.cadence === 0) return [];
  const k = TARIFF_KEYS[r.draft.side];
  const cadence = copy.text(CADENCE_NAME[parsed.cadence]);
  return [
    r.periodGraceSeconds === null ? copy.format(k.loseCadenceUnread, { cadence }) : copy.format(k.loseCadence, { cadence, grace: formatSpan(Number(r.periodGraceSeconds)) }),
    copy.text(k.loseCadenceFixed),
  ];
}
