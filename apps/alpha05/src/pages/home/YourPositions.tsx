import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useCopy } from '../../shared/copy/useCopy';
import { WhyLink } from '../../shared/help/WhyLink';
import { assetName, tokenAmount, type TokenMetaMap } from '../../shared/reads/tokens';
import type { OwnRead } from '../../shared/reads/useOwnRead';
import { formatAge, formatBps, formatScaled, formatSpan, formatUtc } from '../../shared/ui/format';
import { OwnStamp } from '../../shared/ui/OwnStamp';
import { useNow } from '../../shared/ui/useNow';
import {
  ASSET_ERC20,
  OFFER_TYPE_LENDER,
  compareStages,
  exposure,
  groupByOffer,
  loanStage,
  positionKey,
  type Deadlines,
  type LiveLoanRow,
  type LoanEntry,
  type LoanStage,
  type OfferGroup,
} from './model';
import type { LiveLoans, OpenOffer, OpenOffers, Payouts } from './reads';
import type { HomeBook } from './useHomeBook';

/** How many open offers Home lists before pointing at Offers. */
const OFFERS_SHOWN = 3;

type Hex = `0x${string}`;

/**
 * RW-70: the connected wallet's book on this chain, in the order a reader
 * needs it: payouts confirmed ready to collect first, then live loans (the
 * most urgent deadline first, the children of one offer grouped), then the
 * wallet's open offers. Each section states its own reading, failure or
 * incompleteness; "nothing yet" is said only when all three were read in
 * full and are empty. Each position's button OPENS it: whether an action is
 * open is decided on the position's page by the shared verdict (RB-ELIG),
 * never here.
 */
export function YourPositions({ book }: { book: HomeBook }) {
  const { text, format } = useCopy();
  const { chain, loans, payouts, offers, numeraire, meta, empty } = book;
  if (!chain) return null;
  return (
    <>
      <OwnStamp reads={[loans, offers]} />
      {empty ? (
        <p className="tier-b home-empty">{format('home.empty', { chain: chain.name })}</p>
      ) : (
        <>
          <PayoutsSection read={payouts} />
          <LoansSection read={loans} meta={meta} unit={numeraire.data ?? text('home.exposureUnit')} />
          <OffersSection read={offers} meta={meta} />
        </>
      )}
    </>
  );
}

/** A section's read, stated: still reading, failed, or answered; and an
 *  answer kept after a failed re-read is labelled with its age, never shown
 *  as current. */
function ReadState<T>({ read, children }: { read: OwnRead<T>; children: (data: T) => ReactNode }) {
  const { text, format } = useCopy();
  const now = useNow();
  if (read.state === 'failed') return <p className="tier-a notice-warn">{format('home.failed', { reason: read.error ?? '' })}</p>;
  if (read.data === null) return <p className="tier-b">{text('home.reading')}</p>;
  return (
    <>
      {read.error !== null && read.readAt !== null && (
        <p className="tier-a notice-warn">{format('home.stale', { reason: read.error, age: formatAge((now - read.readAt) / 1000) })}</p>
      )}
      {children(read.data)}
    </>
  );
}

/** A section is left out only when its whole inventory was read, the
 *  latest re-read succeeded, and there is nothing in it. */
function settledEmpty<T>(read: OwnRead<T>, isEmpty: (data: T) => boolean): boolean {
  return read.data !== null && read.error === null && isEmpty(read.data);
}

function PayoutsSection({ read }: { read: OwnRead<Payouts> }) {
  const { text, format } = useCopy();
  if (settledEmpty(read, (d) => d.complete && d.rows.length === 0 && d.unlisted === 0)) return null;
  return (
    <section className="home-section" aria-labelledby="home-payouts">
      <h2 id="home-payouts">{text('home.payoutsTitle')}</h2>
      <ReadState read={read}>
        {(data) => (
          <>
            {!data.complete && <p className="tier-a">{text('home.incomplete')}</p>}
            <ul className="rows">
              {data.rows.map((p) => (
                <li key={`${p.side}:${p.loanId}`} className="card" data-payout={`${p.side}:${p.loanId}`}>
                  <p className="row-head">
                    {format('home.payoutRow', { id: p.loanId.toString(), side: text(p.side === 'lender' ? 'home.sideLender' : 'home.sideBorrower') })}
                  </p>
                </li>
              ))}
            </ul>
            {data.unlisted > 0 && <p className="tier-b">{format('home.payoutsUnlisted', { count: String(data.unlisted) })}</p>}
            <WhyLink summaryKey="home.payoutsNote" detailKey="home.payoutsWhy" />
            <Link className="btn btn-primary" to="/claims">
              {text('home.payoutsAction')}
            </Link>
          </>
        )}
      </ReadState>
    </section>
  );
}

function LoansSection({ read, meta, unit }: { read: OwnRead<LiveLoans>; meta: TokenMetaMap | null; unit: string }) {
  const { text } = useCopy();
  if (settledEmpty(read, (d) => d.complete && d.rows.length === 0)) return null;
  return (
    <section className="home-section" aria-labelledby="home-loans">
      <h2 id="home-loans">{text('home.loansTitle')}</h2>
      <ReadState read={read}>{(data) => <LoanList data={data} meta={meta} unit={unit} />}</ReadState>
    </section>
  );
}

function LoanList({ data, meta, unit }: { data: LiveLoans; meta: TokenMetaMap | null; unit: string }) {
  const { text } = useCopy();
  const nowSec = Math.floor(useNow() / 1000);
  const deadlinesOf = (r: LiveLoanRow) => data.deadlines[positionKey(r)] ?? null;
  const stageOf = (r: LiveLoanRow) => loanStage(r, deadlinesOf(r), nowSec);
  const ordered = [...data.rows].sort((a, b) => compareStages(stageOf(a), stageOf(b)));
  const entries = groupByOffer(ordered);
  const exp = exposure(data.rows, (r) => data.values[positionKey(r)] ?? null, data.complete);
  return (
    <>
      <ExposureLine e={exp} unit={unit} />
      {!data.complete && <p className="tier-a">{text('home.incomplete')}</p>}
      <ul className="rows">
        {entries.map((e) => (
          <EntryCard key={e.kind === 'single' ? positionKey(e.row) : `g${e.group.offerId}:${e.group.borrowerSide}`} entry={e} meta={meta} stageOf={stageOf} deadlinesOf={deadlinesOf} />
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
  const tail = unvalued > 0 && e.larger !== 'unknown' && e.larger !== 'only-lent' && e.larger !== 'only-borrowed' ? (
    <p className="tier-b">{format('home.exposureUnvalued', { count: String(unvalued) })}</p>
  ) : null;
  switch (e.larger) {
    case 'none':
      return null;
    case 'only-lent':
      return <WhyLink summaryKey="home.exposureOnlyLent" detailKey="home.exposureWhy" vars={{ count: String(e.lentLoans) }} />;
    case 'only-borrowed':
      return <WhyLink summaryKey="home.exposureOnlyBorrowed" detailKey="home.exposureWhy" vars={{ count: String(e.borrowedLoans) }} />;
    case 'lent':
      return (
        <>
          <WhyLink summaryKey="home.exposureLent" detailKey="home.exposureWhy" vars={{ lent, borrowed, unit }} />
          {tail}
        </>
      );
    case 'borrowed':
      return (
        <>
          <WhyLink summaryKey="home.exposureBorrowed" detailKey="home.exposureWhy" vars={{ lent, borrowed, unit }} />
          {tail}
        </>
      );
    case 'even':
      return <WhyLink summaryKey="home.exposureEven" detailKey="home.exposureWhy" vars={{ lent, unit }} />;
    case 'unknown':
      return <WhyLink summaryKey="home.exposureUnknown" detailKey="home.exposureWhy" vars={{ lent, borrowed, unit, count: String(unvalued) }} />;
    case 'partial':
      return <WhyLink summaryKey="home.exposurePartial" detailKey="home.exposureWhy" vars={{ lent, borrowed, unit }} />;
  }
}

function EntryCard({
  entry,
  meta,
  stageOf,
  deadlinesOf,
}: {
  entry: LoanEntry;
  meta: TokenMetaMap | null;
  stageOf: (r: LiveLoanRow) => LoanStage;
  deadlinesOf: (r: LiveLoanRow) => Deadlines | null;
}) {
  if (entry.kind === 'single') return <LoanCard row={entry.row} meta={meta} stage={stageOf(entry.row)} deadlines={deadlinesOf(entry.row)} />;
  return <GroupCard group={entry.group} meta={meta} stageOf={stageOf} deadlinesOf={deadlinesOf} />;
}

function GroupCard({
  group,
  meta,
  stageOf,
  deadlinesOf,
}: {
  group: OfferGroup;
  meta: TokenMetaMap | null;
  stageOf: (r: LiveLoanRow) => LoanStage;
  deadlinesOf: (r: LiveLoanRow) => Deadlines | null;
}) {
  const { text, format } = useCopy();
  const side = text(group.borrowerSide ? 'home.sideBorrower' : 'home.sideLender');
  return (
    <li className="card group" data-offer-group={group.offerId.toString()}>
      <h3>{format('home.groupHead', { id: group.offerId.toString(), count: String(group.rows.length), side })}</h3>
      <p className="tier-b">{format('home.groupTerms', { amount: tokenAmount(group.principal, group.asset, meta, format), rate: formatBps(group.weightedRateBps) })}</p>
      {group.minHealthFactor !== null && <p className="tier-b">{format('home.groupHealth', { hf: formatScaled(group.minHealthFactor) })}</p>}
      {group.unpricedChildren > 0 && <p className="tier-b">{format('home.groupUnpriced', { count: String(group.unpricedChildren) })}</p>}
      <ul className="rows nested">
        {group.rows.map((r) => (
          <LoanCard key={positionKey(r)} row={r} meta={meta} stage={stageOf(r)} deadlines={deadlinesOf(r)} />
        ))}
      </ul>
    </li>
  );
}

function LoanCard({ row, meta, stage, deadlines }: { row: LiveLoanRow; meta: TokenMetaMap | null; stage: LoanStage; deadlines: Deadlines | null }) {
  const { text, format } = useCopy();
  const l = row.loan;
  const id = l.id.toString();
  const side = text(row.borrowerSide ? 'home.sideBorrower' : 'home.sideLender');
  const legText = (asset: Hex, assetType: number, amount: bigint, tokenId: bigint) =>
    assetType === ASSET_ERC20 ? tokenAmount(amount, asset, meta, format) : format('asset.nft', { id: tokenId.toString(), asset: assetName(asset, meta) });
  return (
    <li className="card loan" data-loan-id={id} data-stage={stage.kind}>
      <h3>{format('home.loanHead', { id, side })}</h3>
      <p className="tier-b">
        {l.assetType === ASSET_ERC20
          ? format('home.loanTerms', { amount: tokenAmount(l.principal, l.principalAsset, meta, format), rate: formatBps(l.interestRateBps), days: l.durationDays.toString() })
          : format('home.loanRental', { asset: legText(l.principalAsset, l.assetType, l.principal, l.tokenId), days: l.durationDays.toString() })}
      </p>
      {/* An NFT rental carries no collateral leg; its prepaid rent is what a default settles. */}
      {l.assetType === ASSET_ERC20 && (
        <p className="tier-b">{format('home.loanCollateral', { amount: legText(l.collateralAsset, l.collateralAssetType, l.collateralAmount, l.collateralTokenId) })}</p>
      )}
      <StageLine stage={stage} borrowerSide={row.borrowerSide} rental={l.assetType !== ASSET_ERC20} />
      {deadlines && deadlines.pauseCredit > 0n && <p className="tier-b">{format('home.loanPauseCredit', { credit: formatSpan(Number(deadlines.pauseCredit)) })}</p>}
      <p className="tier-b">{row.healthFactor > 0n ? format('home.loanHealth', { hf: formatScaled(row.healthFactor) }) : text('home.loanHealthNone')}</p>
      <Link className="btn btn-primary" to={`/positions/${id}`}>
        {format('home.loanOpen', { id })}
      </Link>
    </li>
  );
}

/** The loan's next date and, for the side that bears it, the consequence of
 *  missing it. An NFT rental has no collateral, so its renter is told what a
 *  default does to the prepaid rent instead. */
function StageLine({ stage, borrowerSide, rental }: { stage: LoanStage; borrowerSide: boolean; rental: boolean }) {
  const { text, format } = useCopy();
  const nowSec = Math.floor(useNow() / 1000);
  switch (stage.kind) {
    case 'fallback':
      return <p className="tier-a stage">{text('home.loanFallback')}</p>;
    case 'deadline-unknown':
      return <p className="tier-a stage">{text('home.loanDeadlineUnknown')}</p>;
    case 'running':
      return <p className="tier-b stage">{format(rental ? 'home.rentalDue' : 'home.loanDue', { when: formatUtc(stage.dueAt) })}</p>;
    case 'due-soon': {
      const vars = { when: formatUtc(stage.dueAt), left: formatSpan(stage.dueAt - nowSec) };
      if (borrowerSide) return <p className="tier-a stage">{format(rental ? 'home.loanDueSoonRenter' : 'home.loanDueSoonBorrower', vars)}</p>;
      return <p className="tier-b stage">{format(rental ? 'home.loanDueSoonOwner' : 'home.loanDueSoonLender', vars)}</p>;
    }
    case 'in-grace': {
      const vars = { due: formatUtc(stage.dueAt), graceEnd: formatUtc(stage.graceEndsAt) };
      if (borrowerSide) return <p className="tier-a stage">{format(rental ? 'home.loanInGraceRenter' : 'home.loanInGraceBorrower', vars)}</p>;
      return <p className="tier-b stage">{format('home.loanInGraceLender', vars)}</p>;
    }
    case 'grace-over': {
      const key = borrowerSide ? (rental ? 'home.loanGraceOverRenter' : 'home.loanGraceOverBorrower') : 'home.loanGraceOverLender';
      return <p className="tier-a stage">{format(key, { when: formatUtc(stage.graceEndedAt) })}</p>;
    }
  }
}

function OffersSection({ read, meta }: { read: OwnRead<OpenOffers>; meta: TokenMetaMap | null }) {
  const { text, format } = useCopy();
  if (settledEmpty(read, (d) => d.complete && d.rows.length === 0)) return null;
  return (
    <section className="home-section" aria-labelledby="home-offers">
      <h2 id="home-offers">{text('home.offersTitle')}</h2>
      <ReadState read={read}>
        {(data) => (
          <>
            {!data.complete && <p className="tier-a">{text('home.incomplete')}</p>}
            <ul className="rows">
              {data.rows.slice(0, OFFERS_SHOWN).map((o) => (
                <OfferCard key={o.id.toString()} offer={o} meta={meta} />
              ))}
            </ul>
            {data.rows.length > OFFERS_SHOWN && <p className="tier-b">{format('home.offersMore', { count: String(data.rows.length - OFFERS_SHOWN) })}</p>}
            <Link className="btn" to="/offers">
              {text('home.offersAction')}
            </Link>
          </>
        )}
      </ReadState>
    </section>
  );
}

function OfferCard({ offer: o, meta }: { offer: OpenOffer; meta: TokenMetaMap | null }) {
  const { text, format } = useCopy();
  const id = o.id.toString();
  const lend = o.offerType === OFFER_TYPE_LENDER;
  const erc20 = o.assetType === ASSET_ERC20;
  const amountOf = (v: bigint) => (erc20 ? tokenAmount(v, o.lendingAsset, meta, format) : format('asset.nft', { id: o.tokenId.toString(), asset: assetName(o.lendingAsset, meta) }));
  const rate = o.interestRateBpsMax > o.interestRateBps ? format('home.rateRange', { min: formatBps(o.interestRateBps), max: formatBps(o.interestRateBpsMax) }) : formatBps(o.interestRateBps);
  const common = { id, rate, days: o.durationDays.toString() };
  const line =
    erc20 && o.amountMax > o.amount
      ? format('home.offerRange', { ...common, side: text(lend ? 'home.offerSideLend' : 'home.offerSideBorrow'), min: amountOf(o.amount), max: amountOf(o.amountMax) })
      : format(lend ? 'home.offerLend' : 'home.offerBorrow', { ...common, amount: amountOf(o.amountMax > 0n ? o.amountMax : o.amount) });
  return (
    <li className="card" data-offer-id={id}>
      <p className="row-head">{line}</p>
      {erc20 && o.amountFilled > 0n && <p className="tier-b">{format('home.offerFilled', { filled: amountOf(o.amountFilled), max: amountOf(o.amountMax) })}</p>}
      {o.expiresAt > 0n && <p className="tier-b">{format('home.offerExpires', { when: formatUtc(Number(o.expiresAt)) })}</p>}
    </li>
  );
}
