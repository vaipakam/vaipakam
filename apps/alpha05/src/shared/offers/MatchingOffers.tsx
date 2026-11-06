import { useCopy, type CopyKey } from '../copy/useCopy';
import { WhyLink } from '../help/WhyLink';
import { roleTerms } from './acceptTerms';
import { acceptFigures, lenderFigures, refinancePayoff, type AcceptRole } from './model';
import { tokenAmount, type TokenMetaMap } from '../reads/tokens';
import { Notice } from '../ui/Notice';
import { formatBps, formatUtc } from '../ui/format';
import { needFromAcceptCode } from '../risk/riskAccess';
import { acceptErrorText, cadenceText, gateBlockText, stateText } from '../accept/acceptReview';
import { MATCH_PAGE, type Matches, type MatchRow } from './matches';

type Hex = `0x${string}`;

/** The keys each side's list is written with: a borrower takes lender
 *  offers, a lender funds borrow requests. */
const KEYS = {
  borrower: {
    rowTitle: 'borrow.rowTitle',
    rowCollateral: 'borrow.rowCollateral',
    rowFullTerm: 'borrow.rowFullTerm',
    rowFullTermPartial: 'borrow.rowFullTermPartial',
    rowProRata: 'borrow.rowProRata',
    rowPartial: 'borrow.rowPartial',
    rowCadence: 'borrow.rowCadence',
    rowRiskStep: 'borrow.rowRiskStep',
    take: 'borrow.take',
    takeWithStep: 'borrow.takeWithStep',
    takeConnect: 'borrow.takeConnect',
    matchesTitle: 'borrow.matchesTitle',
    matchesReading: 'borrow.matchesReading',
    matchesFailed: 'borrow.matchesFailed',
    matchesStale: 'borrow.matchesStale',
    matchesEmpty: 'borrow.matchesEmpty',
    matchesEmptyPart: 'borrow.matchesEmptyPart',
    matchesOrder: 'borrow.matchesOrder',
    matchesMore: 'borrow.matchesMore',
    unreadRow: 'borrow.unreadRow',
    endedCount: 'borrow.endedCount',
    skippedOwn: 'borrow.skippedOwn',
    skippedOther: 'borrow.skippedOther',
    offersSummary: 'borrow.offersSummary',
    offersWhy: 'borrow.offersWhy',
  },
  lender: {
    rowTitle: 'lend.rowTitle',
    rowCollateral: 'lend.rowCollateral',
    rowFullTerm: 'lend.rowFullTerm',
    rowFullTermPartial: 'lend.rowFullTermPartial',
    rowProRata: 'lend.rowProRata',
    rowPartial: 'lend.rowPartial',
    rowCadence: 'lend.rowCadence',
    rowRiskStep: 'lend.rowRiskStep',
    take: 'lend.take',
    takeWithStep: 'lend.takeWithStep',
    takeConnect: 'lend.takeConnect',
    matchesTitle: 'lend.matchesTitle',
    matchesReading: 'lend.matchesReading',
    matchesFailed: 'lend.matchesFailed',
    matchesStale: 'lend.matchesStale',
    matchesEmpty: 'lend.matchesEmpty',
    matchesEmptyPart: 'lend.matchesEmptyPart',
    matchesOrder: 'lend.matchesOrder',
    matchesMore: 'lend.matchesMore',
    unreadRow: 'lend.unreadRow',
    endedCount: 'lend.endedCount',
    skippedOwn: 'lend.skippedOwn',
    skippedOther: 'lend.skippedOther',
    offersSummary: 'lend.offersSummary',
    offersWhy: 'lend.offersWhy',
  },
} as const satisfies Record<AcceptRole, Record<string, CopyKey>>;

export interface MatchesView {
  data: Matches | null;
  state: 'no-identity' | 'reading' | 'ready' | 'failed';
  error: string | null;
}

/** One offer, written as the reader's side would live with it (OFF-40):
 *  the amount and at what rate for how long, the collateral, the ratio
 *  when it can be worked out (and why not when it cannot), the interest
 *  mode and schedule, the expiry, what taking it moves, and why it cannot
 *  be taken when the protocol says so. */
function OfferRow({
  role,
  row,
  matcherBps,
  meta,
  connected,
  onTake,
  takeDisabled,
}: {
  role: AcceptRole;
  row: MatchRow;
  matcherBps: bigint | null;
  meta: TokenMetaMap | null;
  connected: boolean;
  onTake: (id: bigint) => void;
  takeDisabled: boolean;
}) {
  const copy = useCopy();
  const { text, format } = copy;
  const k = KEYS[role];
  const o = row.offer;
  const terms = roleTerms(o);
  const amt = (asset: Hex, v: bigint) => tokenAmount(v, asset, meta, format);
  const cadence = cadenceText(o.periodicInterestCadence, copy);
  const blocked = row.blocked;
  // A risk-access block this wallet can clear itself in the review (never
  // the lender's own): the row says so and the review stays one tap away.
  const ownStep = blocked?.kind === 'gate' && !blocked.block.creator && needFromAcceptCode(blocked.block.code) !== null;
  let blockedText: string | null = null;
  if (blocked?.kind === 'state') blockedText = stateText(blocked.state, copy, role);
  else if (blocked?.kind === 'refused') blockedText = acceptErrorText(blocked.error, copy, null, role);
  else if (ownStep) blockedText = text(k.rowRiskStep);
  else if (blocked?.kind === 'gate') blockedText = gateBlockText(blocked.block, copy, role);
  else if (blocked?.kind === 'unread') blockedText = blocked.reason;
  const f = row.preview && matcherBps !== null ? acceptFigures(row.preview, o.durationDays, matcherBps) : null;
  // A lender's line needs no protocol share: it states what leaves the
  // wallet and the fee share that comes back, both from the preview.
  const payoff = role === 'lender' ? refinancePayoff(o) : null;
  const lf = role === 'lender' && row.preview && matcherBps !== null ? lenderFigures(row.preview, o.durationDays, matcherBps, 0n) : null;

  return (
    <li className="card offer-row" data-offer-id={o.id.toString()} data-takeable={blocked ? 'false' : 'true'} data-risk-step={ownStep ? 'true' : undefined}>
      <h3>
        {format(k.rowTitle, {
          id: o.id.toString(),
          amount: amt(o.lendingAsset, terms.amount),
          rate: formatBps(terms.rateBps),
          days: o.durationDays.toString(),
        })}
      </h3>
      <p className="tier-b">
        {format(k.rowCollateral, {
          amount: amt(o.collateralAsset, o.collateralAmount),
        })}
      </p>
      <p className="tier-b">
        {row.ltv.kind === 'bps'
          ? format('borrow.rowLtv', { ltv: formatBps(row.ltv.bps) })
          : row.ltv.kind === 'illiquid'
            ? text('borrow.rowLtvIlliquid')
            : format('borrow.rowLtvNone', { reason: row.ltv.reason })}
      </p>
      <p className="tier-b">{text(o.useFullTermInterest ? (o.allowsPartialRepay ? k.rowFullTermPartial : k.rowFullTerm) : k.rowProRata)}</p>
      {o.allowsPartialRepay && !o.useFullTermInterest && <p className="tier-b">{text(k.rowPartial)}</p>}
      {cadence && <p className="tier-a">{format(k.rowCadence, { cadence })}</p>}
      <p className="tier-b">
        {o.expiresAt === 0n
          ? text('borrow.rowNoExpiry')
          : format('borrow.rowExpires', {
              time: formatUtc(Number(o.expiresAt)),
            })}
      </p>
      {role === 'borrower' && f && (!blocked || ownStep) && (
        <p className="tier-b">
          {format('borrow.rowReceive', {
            amount: amt(o.lendingAsset, f.received),
            fee: amt(o.lendingAsset, f.fee),
          })}
        </p>
      )}
      {payoff !== null && <p className="tier-a">{format('lend.rowRefinance', { id: payoff.toString() })}</p>}
      {lf && (!blocked || ownStep) && (
        <p className="tier-b">
          {format('lend.rowLend', {
            amount: amt(o.lendingAsset, lf.principal),
            back: amt(o.lendingAsset, lf.feeBack),
            fee: amt(o.lendingAsset, lf.fee),
          })}
        </p>
      )}
      {blockedText !== null && (
        <Notice tone={ownStep ? 'info' : 'warn'} tier="A">
          {blockedText}
        </Notice>
      )}
      {(!blocked || ownStep) &&
        (connected ? (
          <button type="button" className="btn btn-primary" disabled={takeDisabled} onClick={() => onTake(o.id)}>
            {text(ownStep ? k.takeWithStep : k.take)}
          </button>
        ) : (
          <p className="tier-b">{text(k.takeConnect)}</p>
        ))}
    </li>
  );
}

/** OFF-44 — the offers open for the pair from the other side, taken whole. */
export function MatchingOffers({
  role,
  view,
  meta,
  connected,
  onTake,
  takeDisabled,
}: {
  role: AcceptRole;
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
  const k = KEYS[role];
  const otherSkipped = m ? m.skipped['other-side'] + m.skipped['not-erc20'] : 0;

  return (
    <section className="borrow-section matches" aria-labelledby="borrow-matches">
      <h2 id="borrow-matches">{text(k.matchesTitle)}</h2>
      <WhyLink summaryKey={k.offersSummary} detailKey={k.offersWhy} />
      {view.state === 'reading' && <p className="tier-b">{text(k.matchesReading)}</p>}
      {view.state === 'failed' && (
        <Notice tone="warn" tier="A">
          {format(k.matchesFailed, {
            reason: view.error ?? 'no answer',
          })}
        </Notice>
      )}
      {m && (
        <>
          {view.error !== null && <p className="tier-b">{text(k.matchesStale)}</p>}
          {live.length === 0 &&
            m.unread.length === 0 &&
            (BigInt(m.scanned) < m.total ? (
              // Only part of the pair was read: say what was read, never that no offer exists.
              <p className="tier-b">{format(k.matchesEmptyPart, { shown: String(m.scanned), total: m.total.toString() })}</p>
            ) : (
              <p className="tier-b">{text(k.matchesEmpty)}</p>
            ))}
          {live.length > 1 && <p className="tier-b">{text(k.matchesOrder)}</p>}
          {live.length > 0 && (
            <ul className="rows offer-rows">
              {live.map((r) => (
                <OfferRow key={r.offer.id.toString()} role={role} row={r} matcherBps={m.matcherBps} meta={meta} connected={connected} onTake={onTake} takeDisabled={takeDisabled} />
              ))}
            </ul>
          )}
          {m.unread.map((u) => (
            <Notice key={u.id.toString()} tone="warn" tier="A">
              {format(k.unreadRow, {
                id: u.id.toString(),
                reason: u.reason,
              })}
            </Notice>
          ))}
          {BigInt(m.scanned) < m.total && live.length > 0 && (
            <p className="tier-b">
              {format(k.matchesMore, {
                shown: String(Math.min(m.scanned, MATCH_PAGE)),
                total: m.total.toString(),
              })}
            </p>
          )}
          {ended > 0 && <p className="tier-b">{format(k.endedCount, { count: String(ended) })}</p>}
          {m.skipped.own > 0 && <p className="tier-b">{format(k.skippedOwn, { count: String(m.skipped.own) })}</p>}
          {otherSkipped > 0 && <p className="tier-b">{format(k.skippedOther, { count: String(otherSkipped) })}</p>}
          {m.skipped['position-sale'] > 0 && <p className="tier-b">{format('lend.skippedSale', { count: String(m.skipped['position-sale']) })}</p>}
        </>
      )}
    </section>
  );
}
