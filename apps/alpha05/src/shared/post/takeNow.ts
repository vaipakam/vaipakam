/**
 * #3622 B1 — "take it now" at posting. Before a new offer is posted, the
 * page looks through the other side's open offers it has already read for
 * the pair, and picks the ones a direct accept would give on terms inside
 * the limits the reader is about to post. The reader then chooses: take one
 * now (the existing direct accept, on that offer's own terms) or post
 * anyway. Nothing is accepted without that choice: a direct accept takes the
 * resting offer's own terms, where a match would lend at the midpoint of the
 * two rates.
 *
 * "Inside the limits" is exact, so taking can never give the reader a term,
 * option, amount, rate or collateral the posted offer would have refused:
 * - the same pair, both legs ERC-20, and the same term in days (a direct
 *   accept takes the offer's own term, never the shorter one a pro-rata
 *   match may give, #3615);
 * - the same lifecycle options: interest mode, partial repayment, the
 *   interest schedule, no prepay listing, no refinance and no linked loan;
 * - the amount the accept binds (`roleTerms`) within the reader's amount
 *   range;
 * - the rate the accept binds no worse than the reader's: at most a
 *   borrower's, at least a lender's;
 * - collateral no worse than the reader's for that amount, pro rata: a
 *   borrower locks no more than it offered, a lender is secured by no less
 *   than it asked.
 * A draft that opts into the Full fee tariff is never offered a take: a
 * direct accept here never opts into it, so taking would drop a choice the
 * reader made. Only offers the page could read in full, that are open and
 * that this wallet can take as they stand (no blocker, a preview read) are
 * picked.
 */
import { OFFER_BORROWER, OFFER_LENDER, roleTerms } from '../offers/acceptTerms';
import type { Matches, MatchRow } from '../offers/matches';
import type { PostDraft } from './postReview';

/** How many fitting offers the choice shows at most. */
export const TAKE_NOW_SHOWN = 3;

/** Whether a direct accept of `row`'s offer gives terms inside `draft`. */
export function fitsDraft(draft: PostDraft, row: MatchRow): boolean {
  const { parsed, pair, side } = draft;
  const o = row.offer;
  if (row.state !== 'open' || row.blocked !== null || row.preview === null) return false;
  if (pair.leg.kind !== 'erc20' || parsed.tariff !== null) return false;
  if (o.offerType !== (side === 'borrower' ? OFFER_LENDER : OFFER_BORROWER)) return false;
  if (o.lendingAsset.toLowerCase() !== pair.lending.toLowerCase() || o.collateralAsset.toLowerCase() !== pair.collateral.toLowerCase()) return false;
  if (o.durationDays !== BigInt(parsed.durationDays)) return false;
  if (o.useFullTermInterest !== parsed.fullTerm || o.allowsPartialRepay !== parsed.allowsPartialRepay || o.periodicInterestCadence !== parsed.cadence) return false;
  if (o.allowsPrepayListing || o.refinanceTargetLoanId !== 0n) return false;
  const { amount, rateBps } = roleTerms(o);
  if (amount < parsed.amount || amount > parsed.amountMax || parsed.amountMax === 0n) return false;
  if (side === 'borrower' ? rateBps > parsed.rateBps : rateBps < parsed.rateBps) return false;
  // The reader's collateral is stated for its largest amount; scale it to
  // the amount the accept binds, rounding against the reader.
  const scaled = parsed.collateral * amount;
  return side === 'borrower' ? o.collateralAmount * parsed.amountMax <= scaled : o.collateralAmount * parsed.amountMax >= scaled;
}

/** The fitting offers, in the list's own order (`rankFor`), at most
 *  `TAKE_NOW_SHOWN`. Empty when nothing fits or nothing was read. */
export function takeNowPicks(draft: PostDraft, matches: Matches | null): MatchRow[] {
  if (matches === null) return [];
  return matches.rows.filter((r) => fitsDraft(draft, r)).slice(0, TAKE_NOW_SHOWN);
}
