import { useCopy } from '../../shared/copy/useCopy';
import { WhyLink } from '../../shared/help/WhyLink';
import { roleTerms } from '../../shared/offers/acceptTerms';
import { acceptFigures } from '../../shared/offers/model';
import { tokenAmount, type TokenMetaMap } from '../../shared/reads/tokens';
import { Notice } from '../../shared/ui/Notice';
import { formatBps, formatUtc } from '../../shared/ui/format';
import { acceptErrorText, cadenceText, stateText } from './acceptReview';
import { MATCH_PAGE, type Matches, type MatchRow } from './matches';

type Hex = `0x${string}`;

export interface MatchesView {
  data: Matches | null;
  state: 'no-identity' | 'reading' | 'ready' | 'failed';
  error: string | null;
}

/** One offer, written as the borrower would live with it (OFF-40): what
 *  they receive and at what rate for how long, the collateral asked, the
 *  ratio when it can be worked out (and why not when it cannot), the
 *  interest mode and schedule, the expiry, and why it cannot be taken
 *  when the protocol says so. */
function OfferRow({
  row,
  meta,
  connected,
  onTake,
  takeDisabled,
}: {
  row: MatchRow;
  meta: TokenMetaMap | null;
  connected: boolean;
  onTake: (id: bigint) => void;
  takeDisabled: boolean;
}) {
  const copy = useCopy();
  const { text, format } = copy;
  const o = row.offer;
  const terms = roleTerms(o);
  const amt = (asset: Hex, v: bigint) => tokenAmount(v, asset, meta, format);
  const cadence = cadenceText(o.periodicInterestCadence, copy);
  const blocked = row.blocked;
  let blockedText: string | null = null;
  if (blocked?.kind === 'state') blockedText = stateText(blocked.state, copy);
  else if (blocked?.kind === 'refused') blockedText = acceptErrorText(blocked.error, copy);
  else if (blocked?.kind === 'unread') blockedText = blocked.reason;
  const f = row.preview ? acceptFigures(row.preview, o.durationDays) : null;

  return (
    <li className="card offer-row" data-offer-id={o.id.toString()} data-takeable={blocked ? 'false' : 'true'}>
      <h3>
        {format('borrow.rowTitle', {
          id: o.id.toString(),
          amount: amt(o.lendingAsset, terms.amount),
          rate: formatBps(terms.rateBps),
          days: o.durationDays.toString(),
        })}
      </h3>
      <p className="tier-b">
        {format('borrow.rowCollateral', {
          amount: amt(o.collateralAsset, o.collateralAmount),
        })}
      </p>
      <p className="tier-b">{row.ltv.kind === 'bps' ? format('borrow.rowLtv', { ltv: formatBps(row.ltv.bps) }) : format('borrow.rowLtvNone', { reason: row.ltv.reason })}</p>
      <p className="tier-b">{text(o.useFullTermInterest ? (o.allowsPartialRepay ? 'borrow.rowFullTermPartial' : 'borrow.rowFullTerm') : 'borrow.rowProRata')}</p>
      {o.allowsPartialRepay && !o.useFullTermInterest && <p className="tier-b">{text('borrow.rowPartial')}</p>}
      {cadence && <p className="tier-a">{format('borrow.rowCadence', { cadence })}</p>}
      <p className="tier-b">
        {o.expiresAt === 0n
          ? text('borrow.rowNoExpiry')
          : format('borrow.rowExpires', {
              time: formatUtc(Number(o.expiresAt)),
            })}
      </p>
      {f && !blocked && (
        <p className="tier-b">
          {format('borrow.rowReceive', {
            amount: amt(o.lendingAsset, f.received),
            fee: amt(o.lendingAsset, f.fee),
          })}
        </p>
      )}
      {blockedText !== null && (
        <Notice tone="warn" tier="A">
          {blockedText}
        </Notice>
      )}
      {!blocked &&
        (connected ? (
          <button type="button" className="btn btn-primary" disabled={takeDisabled} onClick={() => onTake(o.id)}>
            {text('borrow.take')}
          </button>
        ) : (
          <p className="tier-b">{text('borrow.takeConnect')}</p>
        ))}
    </li>
  );
}

/** OFF-44 — the lender offers open for the pair, taken whole. */
export function MatchingOffers({
  view,
  meta,
  connected,
  onTake,
  takeDisabled,
}: {
  view: MatchesView;
  meta: TokenMetaMap | null;
  connected: boolean;
  onTake: (id: bigint) => void;
  takeDisabled: boolean;
}) {
  const { text, format } = useCopy();
  const m = view.data;
  const live = m?.rows.filter((r) => r.state === 'open') ?? [];
  const ended = (m?.rows.length ?? 0) - live.length;
  const otherSkipped = m ? m.skipped['not-lender'] + m.skipped['not-erc20'] : 0;

  return (
    <section className="borrow-section matches" aria-labelledby="borrow-matches">
      <h2 id="borrow-matches">{text('borrow.matchesTitle')}</h2>
      <WhyLink summaryKey="borrow.offersSummary" detailKey="borrow.offersWhy" />
      {view.state === 'reading' && <p className="tier-b">{text('borrow.matchesReading')}</p>}
      {view.state === 'failed' && (
        <Notice tone="warn" tier="A">
          {format('borrow.matchesFailed', {
            reason: view.error ?? 'no answer',
          })}
        </Notice>
      )}
      {m && (
        <>
          {view.error !== null && <p className="tier-b">{text('borrow.matchesStale')}</p>}
          {live.length === 0 && m.unread.length === 0 && <p className="tier-b">{text('borrow.matchesEmpty')}</p>}
          {live.length > 1 && <p className="tier-b">{text('borrow.matchesOrder')}</p>}
          {live.length > 0 && (
            <ul className="rows offer-rows">
              {live.map((r) => (
                <OfferRow key={r.offer.id.toString()} row={r} meta={meta} connected={connected} onTake={onTake} takeDisabled={takeDisabled} />
              ))}
            </ul>
          )}
          {m.unread.map((u) => (
            <Notice key={u.id.toString()} tone="warn" tier="A">
              {format('borrow.unreadRow', {
                id: u.id.toString(),
                reason: u.reason,
              })}
            </Notice>
          ))}
          {BigInt(m.scanned) < m.total && (
            <p className="tier-b">
              {format('borrow.matchesMore', {
                shown: String(Math.min(m.scanned, MATCH_PAGE)),
                total: m.total.toString(),
              })}
            </p>
          )}
          {ended > 0 && <p className="tier-b">{format('borrow.endedCount', { count: String(ended) })}</p>}
          {m.skipped.own > 0 && <p className="tier-b">{format('borrow.skippedOwn', { count: String(m.skipped.own) })}</p>}
          {otherSkipped > 0 && <p className="tier-b">{format('borrow.skippedOther', { count: String(otherSkipped) })}</p>}
        </>
      )}
    </section>
  );
}
