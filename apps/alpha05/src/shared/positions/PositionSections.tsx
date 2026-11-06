import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useCopy } from '../copy/useCopy';
import { WhyLink } from '../help/WhyLink';
import { assetName, tokenAmount, type TokenMetaMap } from '../reads/tokens';
import type { OwnRead } from '../reads/useOwnRead';
import { formatAge, formatBps, formatScaled, formatSpan, formatUtc } from '../ui/format';
import { useNow } from '../ui/useNow';
import {
  ASSET_ERC20,
  compareStages,
  exposure,
  groupByOffer,
  loanObligations,
  loanStatusName,
  mostUrgent,
  positionKey,
  type Deadlines,
  type EndedLoanRow,
  type LiveLoanRow,
  type LoanEntry,
  type InterestStage,
  type LoanObligations,
  type LoanStage,
  type OfferGroup,
} from './model';
import type { EndedLoans, LiveLoans, Payouts } from './reads';

type Hex = `0x${string}`;

/**
 * RW-70 / LN-05 — the sections a wallet's loan positions are listed in, shared
 * by Home and Positions so both say one thing one way: payouts confirmed
 * ready to collect, then live loans (the most urgent deadline first, the
 * children of one offer grouped) with each obligation's stage, its pause
 * credit and the health factor. Each section states its own reading,
 * failure or incompleteness. A position's button OPENS it: whether an action
 * is open is decided on the position's page by the shared verdict (RB-ELIG).
 */

/** A section's read, stated: still reading, failed, or answered; and an
 *  answer kept after a failed re-read is labelled with its age, never shown
 *  as current. */
export function ReadState<T>({ read, children }: { read: OwnRead<T>; children: (data: T) => ReactNode }) {
  const { text, format } = useCopy();
  const now = useNow();
  if (read.state === 'failed') return <p className="tier-a notice-warn">{format('positions.failed', { reason: read.error ?? '' })}</p>;
  if (read.data === null) return <p className="tier-b">{text('positions.reading')}</p>;
  return (
    <>
      {read.error !== null && read.readAt !== null && (
        <p className="tier-a notice-warn">{format('positions.stale', { reason: read.error, age: formatAge((now - read.readAt) / 1000) })}</p>
      )}
      {children(read.data)}
    </>
  );
}

/** A section is left out only when its whole inventory was read, the
 *  latest re-read succeeded, and there is nothing in it. */
export function settledEmpty<T>(read: OwnRead<T>, isEmpty: (data: T) => boolean): boolean {
  return read.data !== null && read.error === null && isEmpty(read.data);
}

export function PayoutsSection({ read }: { read: OwnRead<Payouts> }) {
  const { text, format } = useCopy();
  if (settledEmpty(read, (d) => d.complete && d.rows.length === 0 && d.unlisted.length === 0)) return null;
  return (
    <section className="home-section" aria-labelledby="home-payouts">
      <h2 id="home-payouts">{text('positions.payoutsTitle')}</h2>
      <ReadState read={read}>
        {(data) => (
          <>
            {!data.complete && <p className="tier-a">{text('positions.incomplete')}</p>}
            <ul className="rows">
              {data.rows.map((p) => (
                <li key={`${p.side}:${p.loanId}`} className="card" data-payout={`${p.side}:${p.loanId}`}>
                  <p className="row-head">
                    {format('positions.payoutRow', { id: p.loanId.toString(), side: text(p.side === 'lender' ? 'positions.sideLender' : 'positions.sideBorrower') })}
                  </p>
                </li>
              ))}
            </ul>
            {data.unlisted.length > 0 && <p className="tier-b">{format('positions.payoutsUnlisted', { count: String(data.unlisted.length) })}</p>}
            <WhyLink summaryKey="positions.payoutsNote" detailKey="positions.payoutsWhy" />
            <Link className="btn btn-primary" to="/claims">
              {text('positions.payoutsAction')}
            </Link>
          </>
        )}
      </ReadState>
    </section>
  );
}

export function LoansSection({ read, meta, unit }: { read: OwnRead<LiveLoans>; meta: TokenMetaMap | null; unit: string }) {
  const { text } = useCopy();
  if (settledEmpty(read, (d) => d.complete && d.rows.length === 0)) return null;
  return (
    <section className="home-section" aria-labelledby="home-loans">
      <h2 id="home-loans">{text('positions.loansTitle')}</h2>
      <ReadState read={read}>{(data) => <LoanList data={data} meta={meta} unit={unit} />}</ReadState>
    </section>
  );
}

function LoanList({ data, meta, unit }: { data: LiveLoans; meta: TokenMetaMap | null; unit: string }) {
  const { text } = useCopy();
  const nowSec = Math.floor(useNow() / 1000);
  const deadlinesOf = (r: LiveLoanRow) => data.deadlines[positionKey(r)] ?? null;
  const obligationsOf = (r: LiveLoanRow) => loanObligations(r, deadlinesOf(r), nowSec);
  const ordered = [...data.rows].sort((a, b) => compareStages(mostUrgent(obligationsOf(a)), mostUrgent(obligationsOf(b))));
  const entries = groupByOffer(ordered);
  const exp = exposure(data.rows, (r) => data.values[positionKey(r)] ?? null, data.complete);
  return (
    <>
      <ExposureLine e={exp} unit={unit} />
      {!data.complete && <p className="tier-a">{text('positions.incomplete')}</p>}
      <ul className="rows">
        {entries.map((e) => (
          <EntryCard
            key={e.kind === 'single' ? positionKey(e.row) : `g${e.group.offerId}:${e.group.borrowerSide}`}
            entry={e}
            meta={meta}
            obligationsOf={obligationsOf}
            deadlinesOf={deadlinesOf}
          />
        ))}
      </ul>
    </>
  );
}

function ExposureLine({ e, unit }: { e: ReturnType<typeof exposure>; unit: string }) {
  const { format } = useCopy();
  const lent = formatScaled(e.lent);
  const borrowed = formatScaled(e.borrowed);
  const unvalued = e.unvaluedLent + e.unvaluedBorrowed;
  const tail =
    unvalued > 0 && e.larger !== 'unknown' && e.larger !== 'only-lent' && e.larger !== 'only-borrowed' ? (
      <p className="tier-b">{format('positions.exposureUnvalued', { count: String(unvalued) })}</p>
    ) : null;
  switch (e.larger) {
    case 'none':
      return null;
    case 'only-lent':
      return <WhyLink summaryKey="positions.exposureOnlyLent" detailKey="positions.exposureWhy" vars={{ count: String(e.lentLoans) }} />;
    case 'only-borrowed':
      return <WhyLink summaryKey="positions.exposureOnlyBorrowed" detailKey="positions.exposureWhy" vars={{ count: String(e.borrowedLoans) }} />;
    case 'lent':
      return (
        <>
          <WhyLink summaryKey="positions.exposureLent" detailKey="positions.exposureWhy" vars={{ lent, borrowed, unit }} />
          {tail}
        </>
      );
    case 'borrowed':
      return (
        <>
          <WhyLink summaryKey="positions.exposureBorrowed" detailKey="positions.exposureWhy" vars={{ lent, borrowed, unit }} />
          {tail}
        </>
      );
    case 'even':
      return <WhyLink summaryKey="positions.exposureEven" detailKey="positions.exposureWhy" vars={{ lent, unit }} />;
    case 'unknown':
      return <WhyLink summaryKey="positions.exposureUnknown" detailKey="positions.exposureWhy" vars={{ lent, borrowed, unit, count: String(unvalued) }} />;
    case 'partial':
      return <WhyLink summaryKey="positions.exposurePartial" detailKey="positions.exposureWhy" vars={{ lent, borrowed, unit }} />;
  }
}

function EntryCard({
  entry,
  meta,
  obligationsOf,
  deadlinesOf,
}: {
  entry: LoanEntry;
  meta: TokenMetaMap | null;
  obligationsOf: (r: LiveLoanRow) => LoanObligations;
  deadlinesOf: (r: LiveLoanRow) => Deadlines | null;
}) {
  if (entry.kind === 'single') return <LoanCard row={entry.row} meta={meta} obligations={obligationsOf(entry.row)} deadlines={deadlinesOf(entry.row)} />;
  return <GroupCard group={entry.group} meta={meta} obligationsOf={obligationsOf} deadlinesOf={deadlinesOf} />;
}

function GroupCard({
  group,
  meta,
  obligationsOf,
  deadlinesOf,
}: {
  group: OfferGroup;
  meta: TokenMetaMap | null;
  obligationsOf: (r: LiveLoanRow) => LoanObligations;
  deadlinesOf: (r: LiveLoanRow) => Deadlines | null;
}) {
  const { text, format } = useCopy();
  const side = text(group.borrowerSide ? 'positions.sideBorrower' : 'positions.sideLender');
  return (
    <li className="card group" data-offer-group={group.offerId.toString()}>
      <h3>{format('positions.groupHead', { id: group.offerId.toString(), count: String(group.rows.length), side })}</h3>
      <p className="tier-b">{format('positions.groupTerms', { amount: tokenAmount(group.principal, group.asset, meta, format), rate: formatBps(group.weightedRateBps) })}</p>
      {group.minHealthFactor !== null && <p className="tier-b">{format('positions.groupHealth', { hf: formatScaled(group.minHealthFactor) })}</p>}
      {group.unpricedChildren > 0 && <p className="tier-b">{format('positions.groupUnpriced', { count: String(group.unpricedChildren) })}</p>}
      <ul className="rows nested">
        {group.rows.map((r) => (
          <LoanCard key={positionKey(r)} row={r} meta={meta} obligations={obligationsOf(r)} deadlines={deadlinesOf(r)} />
        ))}
      </ul>
    </li>
  );
}

function LoanCard({ row, meta, obligations, deadlines }: { row: LiveLoanRow; meta: TokenMetaMap | null; obligations: LoanObligations; deadlines: Deadlines | null }) {
  const { text, format } = useCopy();
  const l = row.loan;
  const id = l.id.toString();
  const side = text(row.borrowerSide ? 'positions.sideBorrower' : 'positions.sideLender');
  const legText = (asset: Hex, assetType: number, amount: bigint, tokenId: bigint) =>
    assetType === ASSET_ERC20 ? tokenAmount(amount, asset, meta, format) : format('asset.nft', { id: tokenId.toString(), asset: assetName(asset, meta) });
  return (
    <li className="card loan" data-loan-id={id} data-stage={mostUrgent(obligations).kind}>
      <h3>{format('positions.loanHead', { id, side })}</h3>
      <p className="tier-b">
        {l.assetType === ASSET_ERC20
          ? format('positions.loanTerms', { amount: tokenAmount(l.principal, l.principalAsset, meta, format), rate: formatBps(l.interestRateBps), days: l.durationDays.toString() })
          : format('positions.loanRental', { asset: legText(l.principalAsset, l.assetType, l.principal, l.tokenId), days: l.durationDays.toString() })}
      </p>
      {/* An NFT rental carries no collateral leg; its prepaid rent is what a default settles. */}
      {l.assetType === ASSET_ERC20 && (
        <p className="tier-b">{format('positions.loanCollateral', { amount: legText(l.collateralAsset, l.collateralAssetType, l.collateralAmount, l.collateralTokenId) })}</p>
      )}
      {/* Both obligations, each with its own grace: neither hides the other. */}
      <StageLine stage={obligations.stage} borrowerSide={row.borrowerSide} rental={l.assetType !== ASSET_ERC20} />
      {obligations.interest && <InterestLine stage={obligations.interest} borrowerSide={row.borrowerSide} amountOf={(v) => tokenAmount(v, l.principalAsset, meta, format)} />}
      {deadlines?.periodic && !deadlines.periodic.enforced && <p className="tier-b">{text('positions.interestCheckpointsOff')}</p>}
      {deadlines && deadlines.pauseCredit > 0n && <p className="tier-b">{format('positions.loanPauseCredit', { credit: formatSpan(Number(deadlines.pauseCredit)) })}</p>}
      <p className="tier-b">{row.healthFactor > 0n ? format('positions.loanHealth', { hf: formatScaled(row.healthFactor) }) : text('positions.loanHealthNone')}</p>
      <Link className="btn btn-primary" to={`/positions/${id}`}>
        {format('positions.loanOpen', { id })}
      </Link>
    </li>
  );
}

/** The loan's final due date and, for the side that bears it, the
 *  consequence of missing it. An NFT rental has no collateral, so its renter
 *  is told what a default does to the prepaid rent instead. */
export function StageLine({ stage, borrowerSide, rental }: { stage: LoanStage; borrowerSide: boolean; rental: boolean }) {
  const { text, format } = useCopy();
  const nowSec = Math.floor(useNow() / 1000);
  switch (stage.kind) {
    case 'fallback':
      return <p className="tier-a stage">{text('positions.loanFallback')}</p>;
    case 'deadline-unknown':
      return <p className="tier-a stage">{text('positions.loanDeadlineUnknown')}</p>;
    case 'running':
      return <p className="tier-b stage">{format(rental ? 'positions.rentalDue' : 'positions.loanDue', { when: formatUtc(stage.dueAt) })}</p>;
    case 'due-soon': {
      const vars = { when: formatUtc(stage.dueAt), left: formatSpan(stage.dueAt - nowSec) };
      if (borrowerSide) return <p className="tier-a stage">{format(rental ? 'positions.loanDueSoonRenter' : 'positions.loanDueSoonBorrower', vars)}</p>;
      return <p className="tier-b stage">{format(rental ? 'positions.loanDueSoonOwner' : 'positions.loanDueSoonLender', vars)}</p>;
    }
    case 'in-grace': {
      const vars = { due: formatUtc(stage.dueAt), graceEnd: formatUtc(stage.graceEndsAt) };
      if (borrowerSide) return <p className="tier-a stage">{format(rental ? 'positions.loanInGraceRenter' : 'positions.loanInGraceBorrower', vars)}</p>;
      return <p className="tier-b stage">{format('positions.loanInGraceLender', vars)}</p>;
    }
    case 'grace-over': {
      const key = borrowerSide ? (rental ? 'positions.loanGraceOverRenter' : 'positions.loanGraceOverBorrower') : 'positions.loanGraceOverLender';
      return <p className="tier-a stage">{format(key, { when: formatUtc(stage.graceEndedAt) })}</p>;
    }
  }
}

/** An owed periodic-interest checkpoint, named with the interest still owed
 *  in the principal asset and, for the borrower, the sale that follows its
 *  grace. Shown beside the due date, whichever comes first. */
export function InterestLine({ stage, borrowerSide, amountOf }: { stage: InterestStage; borrowerSide: boolean; amountOf: (v: bigint) => string }) {
  const { format } = useCopy();
  const nowSec = Math.floor(useNow() / 1000);
  switch (stage.kind) {
    case 'interest-later':
      return <p className="tier-b interest">{format('positions.interestNext', { when: formatUtc(stage.dueAt) })}</p>;
    case 'interest-soon': {
      const vars = { amount: amountOf(stage.shortfall), when: formatUtc(stage.dueAt), left: formatSpan(stage.dueAt - nowSec) };
      return borrowerSide ? (
        <p className="tier-a interest">{format('positions.interestSoonBorrower', vars)}</p>
      ) : (
        <p className="tier-b interest">{format('positions.interestSoonLender', vars)}</p>
      );
    }
    case 'interest-in-grace': {
      const vars = { amount: amountOf(stage.shortfall), due: formatUtc(stage.dueAt), graceEnd: formatUtc(stage.graceEndsAt) };
      return borrowerSide ? (
        <p className="tier-a interest">{format('positions.interestInGraceBorrower', vars)}</p>
      ) : (
        <p className="tier-b interest">{format('positions.interestInGraceLender', vars)}</p>
      );
    }
    case 'interest-overdue':
      return (
        <p className="tier-a interest">
          {format(borrowerSide ? 'positions.interestOverdueBorrower' : 'positions.interestOverdueLender', {
            amount: amountOf(stage.shortfall),
            when: formatUtc(stage.graceEndedAt),
          })}
        </p>
      );
  }
}

const ENDED_STATUS_KEYS = {
  repaid: 'positions.statusRepaid',
  defaulted: 'positions.statusDefaulted',
  settled: 'positions.statusSettled',
  matched: 'positions.statusMatched',
} as const;

/**
 * LN-05 / LN-10 — held positions on loans that have ended, most recent
 * first: the status in words (one this build does not know is named by its
 * number, never guessed), the loan's terms, and a ready payout called out
 * with where it is collected. `payoutKeys` holds the positions the pending
 * view lists as ready.
 */
export function EndedSection({ read, meta, payoutKeys }: { read: OwnRead<EndedLoans>; meta: TokenMetaMap | null; payoutKeys: ReadonlySet<string> }) {
  const { text } = useCopy();
  if (settledEmpty(read, (d) => d.complete && d.rows.length === 0)) return null;
  return (
    <section className="home-section" aria-labelledby="positions-ended">
      <h2 id="positions-ended">{text('positions.endedTitle')}</h2>
      <ReadState read={read}>
        {(data) => (
          <>
            {!data.complete && <p className="tier-a">{text('positions.incomplete')}</p>}
            <ul className="rows">
              {data.rows.map((r) => (
                <EndedCard key={positionKey(r)} row={r} meta={meta} payout={payoutKeys.has(positionKey(r))} />
              ))}
            </ul>
          </>
        )}
      </ReadState>
    </section>
  );
}

function EndedCard({ row, meta, payout }: { row: EndedLoanRow; meta: TokenMetaMap | null; payout: boolean }) {
  const { text, format } = useCopy();
  const l = row.loan;
  const id = l.id.toString();
  const side = text(row.borrowerSide ? 'positions.sideBorrower' : 'positions.sideLender');
  const name = loanStatusName(l.status);
  const status =
    name === 'repaid' || name === 'defaulted' || name === 'settled' || name === 'matched'
      ? text(ENDED_STATUS_KEYS[name])
      : format('positions.statusUnknown', { number: String(l.status) });
  return (
    <li className="card loan" data-loan-id={id} data-status={name}>
      <h3>{format('positions.endedHead', { id, side })}</h3>
      <p className="tier-b">
        {l.assetType === ASSET_ERC20
          ? format('positions.loanTerms', { amount: tokenAmount(l.principal, l.principalAsset, meta, format), rate: formatBps(l.interestRateBps), days: l.durationDays.toString() })
          : format('positions.loanRental', { asset: format('asset.nft', { id: l.tokenId.toString(), asset: assetName(l.principalAsset, meta) }), days: l.durationDays.toString() })}
      </p>
      <p className="tier-a stage">{status}</p>
      {payout && (
        <p className="tier-a">
          <Link to="/claims">{text('positions.endedPayout')}</Link>
        </p>
      )}
      <Link className="btn" to={`/positions/${id}`}>
        {format('positions.loanOpen', { id })}
      </Link>
    </li>
  );
}
