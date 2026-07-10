/**
 * Rate ladder — the two-sided order book for one (pair, tenor)
 * market (#1129 §3). Asks (lender offers) above the mid, bids
 * (borrow requests) below; every level shows remaining size + the
 * cumulative depth from the top of its side. Rate-first vocabulary
 * ("Rate (APR %)", never "price"); exact bps in title tooltips.
 *
 *  - Tapping a level pre-fills the ticket at that rate (maker path).
 *  - The taker affordance appears ONLY at the top of each side and
 *    only on unfilled, unexpired, not-own rows — it deep-links into
 *    the existing guided accept (/borrow?offer=N for lender offers,
 *    /lend?offer=N for borrow requests); phase 1 never rebuilds the
 *    accept flow.
 *  - Own orders are highlighted (creator === connected wallet).
 */
import { BookOpen, LoaderCircle } from 'lucide-react';
import { Link } from 'react-router-dom';
import { copy } from '../../content/copy';
import { EmptyState, UnavailableState } from '../EmptyState';
import { formatBpsAsPercent, formatTokenAmount } from '../../lib/format';
import { takerCandidate, type DeskLadder, type LadderLevel } from '../../data/desk';

const MAX_LEVELS = 12;

function LevelRow({
  level,
  side,
  decimals,
  takeHref,
  takeLabel,
  onPick,
}: {
  level: LadderLevel;
  side: 'ask' | 'bid';
  decimals: number | undefined;
  takeHref: string | null;
  takeLabel: string;
  onPick: (rateBps: number) => void;
}) {
  return (
    <div
      className={`desk-ladder-row${level.own ? ' desk-own' : ''}`}
      role="button"
      tabIndex={0}
      title={`${level.rateBps} bps · ${level.offers.length} offer${
        level.offers.length === 1 ? '' : 's'
      }${level.own ? ` · ${copy.desk.yourOrderMark}` : ''}`}
      onClick={() => onPick(level.rateBps)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onPick(level.rateBps);
        }
      }}
    >
      <span className={side === 'ask' ? 'desk-rate-ask' : 'desk-rate-bid'}>
        {formatBpsAsPercent(level.rateBps)}
      </span>
      <span>{decimals !== undefined ? formatTokenAmount(level.size, decimals) : '…'}</span>
      <span className="muted">
        {decimals !== undefined ? formatTokenAmount(level.cumulative, decimals) : '…'}
      </span>
      <span className="desk-ladder-action">
        {level.own ? <span className="desk-own-dot" aria-hidden /> : null}
        {takeHref ? (
          <Link
            to={takeHref}
            className="btn btn-secondary btn-sm"
            onClick={(e) => e.stopPropagation()}
          >
            {takeLabel}
          </Link>
        ) : null}
      </span>
    </div>
  );
}

export function RateLadder({
  ladder,
  loading,
  unavailable,
  source,
  decimals,
  symbol,
  chainId,
  wallet,
  onPickRate,
}: {
  ladder: DeskLadder | null;
  loading: boolean;
  unavailable: boolean;
  source: 'chain' | 'indexer' | null;
  decimals: number | undefined;
  symbol: string | undefined;
  chainId: number;
  wallet: string | undefined;
  onPickRate: (rateBps: number) => void;
}) {
  if (loading) {
    return (
      <div className="card">
        <h2 className="card-title">{copy.desk.bookTitle}</h2>
        <EmptyState icon={LoaderCircle} title="Loading the order book…" />
      </div>
    );
  }
  if (unavailable || ladder === null) {
    return (
      <div className="card">
        <h2 className="card-title">{copy.desk.bookTitle}</h2>
        <UnavailableState body={copy.desk.bookUnavailable} />
      </div>
    );
  }

  const empty = ladder.asks.length === 0 && ladder.bids.length === 0;

  // Direct-accept candidates at the top of each side only.
  const askTake = takerCandidate(ladder.asks[0], wallet);
  const bidTake = takerCandidate(ladder.bids[0], wallet);
  // Asks render worst-first so the best ask sits just above the mid.
  const asksShown = ladder.asks.slice(0, MAX_LEVELS).reverse();
  const bidsShown = ladder.bids.slice(0, MAX_LEVELS);

  return (
    <div className="card">
      <h2 className="card-title">{copy.desk.bookTitle}</h2>
      {source === 'indexer' ? (
        <p className="muted" style={{ marginBottom: 8 }}>
          {copy.desk.bookIndexedCopy}
        </p>
      ) : null}
      {empty ? (
        <EmptyState icon={BookOpen} title={copy.desk.bookEmpty} />
      ) : (
        <div className="desk-ladder">
          <div className="desk-ladder-head">
            <span>{copy.desk.rateHeading}</span>
            <span>
              {copy.desk.sizeHeading}
              {symbol ? ` (${symbol})` : ''}
            </span>
            <span title="Cumulative depth from the top of the side">
              {copy.desk.cumHeading}
            </span>
            <span />
          </div>

          <div className="desk-ladder-side-label">{copy.desk.asksHeading}</div>
          {asksShown.map((l) => (
            <LevelRow
              key={`ask-${l.rateBps}`}
              level={l}
              side="ask"
              decimals={decimals}
              onPick={onPickRate}
              takeLabel={copy.desk.takeAsk}
              takeHref={
                askTake && l.rateBps === ladder.bestAskBps
                  ? `/borrow?offer=${askTake.offerId}&chain=${chainId}`
                  : null
              }
            />
          ))}

          <div className="desk-mid-row" title={
            ladder.midBps != null ? `${ladder.midBps} bps quoted mid` : undefined
          }>
            {ladder.midBps != null
              ? `mid ${formatBpsAsPercent(ladder.midBps)}${
                  ladder.spreadBps != null
                    ? ` · spread ${
                        ladder.spreadBps < 0
                          ? `${formatBpsAsPercent(Math.abs(ladder.spreadBps))} (${copy.desk.crossed})`
                          : formatBpsAsPercent(ladder.spreadBps)
                      }`
                    : ''
                }`
              : 'one-sided book'}
          </div>

          <div className="desk-ladder-side-label">{copy.desk.bidsHeading}</div>
          {bidsShown.map((l) => (
            <LevelRow
              key={`bid-${l.rateBps}`}
              level={l}
              side="bid"
              decimals={decimals}
              onPick={onPickRate}
              takeLabel={copy.desk.takeBid}
              takeHref={
                bidTake && l.rateBps === ladder.bestBidBps
                  ? `/lend?offer=${bidTake.offerId}&chain=${chainId}`
                  : null
              }
            />
          ))}
        </div>
      )}
      {!empty ? (
        <p className="muted" style={{ marginTop: 8, fontSize: '0.8rem' }}>
          {copy.desk.rowPrefills}
        </p>
      ) : null}
    </div>
  );
}
