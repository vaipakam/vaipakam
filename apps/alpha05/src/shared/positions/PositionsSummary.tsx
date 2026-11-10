import { Link } from 'react-router-dom';
import { useCopy, type CopyKey } from '../copy/useCopy';
import { WhyLink } from '../help/WhyLink';
import { tokenAmount, type TokenMetaMap } from '../reads/tokens';
import type { OwnRead } from '../reads/useOwnRead';
import { formatUtc } from '../ui/format';
import { useNow } from '../ui/useNow';
import { positionKey } from './model';
import type { LiveLoans } from './reads';
import { bookSummary, type SideSummary } from './summary';

/**
 * #3320 — one card over the wallet's live loans, above the lists: per side,
 * the principal still owed or still out per token, the next date a payment
 * falls due with its loan, and the loans that need the reader now, each
 * linked. It adds the loans up and manages none of them; the rows below stay
 * one per loan, and with a single loan the card is not shown, since that
 * row already says all of it. It reads only what the loan list reads, shows nothing until
 * that read has an answer (the list states reading and failure), and says
 * when the walk was partial (RB-FUNDS). Grace and past-due stay tier A
 * (RB-VISIBLE).
 */
export function PositionsSummary({ read, meta }: { read: OwnRead<LiveLoans>; meta: TokenMetaMap | null }) {
  const { text } = useCopy();
  const nowSec = Math.floor(useNow() / 1000);
  const data = read.data;
  // One loan's row already says all of this; the card adds up two or more.
  if (!data || data.rows.length < 2) return null;
  const { borrowed, lent } = bookSummary(data.rows, (r) => data.deadlines[positionKey(r)] ?? null, nowSec);
  return (
    <section className="home-section positions-summary" aria-labelledby="positions-summary" data-testid="positions-summary">
      <h2 id="positions-summary">{text('positions.summaryTitle')}</h2>
      {!data.complete && <p className="tier-a">{text('positions.summaryPartial')}</p>}
      {borrowed && <SideBlock side={borrowed} borrowerSide meta={meta} />}
      {lent && <SideBlock side={lent} borrowerSide={false} meta={meta} />}
      <WhyLink summaryKey="positions.summaryInterest" detailKey="positions.summaryWhy" />
    </section>
  );
}

function SideBlock({ side, borrowerSide, meta }: { side: SideSummary; borrowerSide: boolean; meta: TokenMetaMap | null }) {
  const { format } = useCopy();
  const amounts = side.principal.map((t) => tokenAmount(t.amount, t.asset, meta, format)).join(', ');
  const count = String(side.loans);
  const head: CopyKey =
    side.principal.length === 0
      ? borrowerSide
        ? 'positions.summaryBorrowedRentals'
        : 'positions.summaryLentRentals'
      : borrowerSide
        ? 'positions.summaryBorrowed'
        : 'positions.summaryLent';
  const nextKey: CopyKey | null = side.next
    ? side.next.kind === 'repayment'
      ? borrowerSide
        ? 'positions.summaryNextRepayBorrower'
        : 'positions.summaryNextRepayLender'
      : borrowerSide
        ? 'positions.summaryNextInterestBorrower'
        : 'positions.summaryNextInterestLender'
    : null;
  return (
    <div className="summary-side" data-side={borrowerSide ? 'borrowed' : 'lent'}>
      <p className="tier-b summary-head">{format(head, { amounts, count })}</p>
      {side.principal.length > 0 && side.rentals > 0 && <p className="tier-b">{format('positions.summaryRentals', { count: String(side.rentals) })}</p>}
      {side.next && nextKey && (
        <p className="tier-b" data-testid="summary-next">
          {format(nextKey, { when: formatUtc(side.next.at), id: side.next.loanId.toString() })}{' '}
          <Link to={`/positions/${side.next.loanId}`}>{format('positions.loanOpen', { id: side.next.loanId.toString() })}</Link>
        </p>
      )}
      {side.undated.length > 0 && <p className="tier-a">{format('positions.summaryUndated', { count: String(side.undated.length) })}</p>}
      <LoanLinks labelKey="positions.summaryPastGrace" ids={side.pastGrace} testId="summary-past-grace" />
      <LoanLinks labelKey="positions.summaryInGrace" ids={side.inGrace} testId="summary-in-grace" />
      <LoanLinks labelKey="positions.summaryFallback" ids={side.fallback} testId="summary-fallback" />
    </div>
  );
}

/** A tier-A line naming loans that need the reader, each a link to its page. */
function LoanLinks({ labelKey, ids, testId }: { labelKey: CopyKey; ids: readonly bigint[]; testId: string }) {
  const { text, format } = useCopy();
  if (ids.length === 0) return null;
  return (
    <p className="tier-a summary-links" data-testid={testId}>
      {format(labelKey, { count: String(ids.length) })}{' '}
      {ids.map((id, i) => (
        <span key={id.toString()}>
          {i > 0 && text('positions.summaryListJoin')}
          <Link to={`/positions/${id}`}>{format('positions.summaryLoan', { id: id.toString() })}</Link>
        </span>
      ))}
    </p>
  );
}
