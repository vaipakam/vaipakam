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
 *  - Signed off-chain rows (#1131 slice D) merge into the same levels
 *    with a "Signed" badge (they are always indexer-sourced — the badge
 *    carries that per-row source honesty) and their own inline Fill
 *    affordance instead of the guided-accept deep link.
 *  - When the book is crossed AND the contract's previewMatch confirms
 *    the top-of-book pair is matchable, the MatchBand strip renders at
 *    the mid row (#1131 slice B).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { BookOpen, LoaderCircle } from 'lucide-react';
import { Link } from 'react-router-dom';
import { copy } from '../../content/copy';
import { EmptyState, UnavailableState } from '../EmptyState';
import { formatBpsAsPercent, formatTokenAmount } from '../../lib/format';
import {
  ladderFlashIds,
  levelFlashId,
  snapshotLadder,
  type LadderSnapshot,
} from '../../lib/ladderFlash';
import {
  signedOrderIsSingleValue,
  type SignedRowMeta,
} from '../../lib/signedOffer';
import {
  signedFillCandidate,
  takerCandidate,
  type DeskLadder,
  type LadderLevel,
} from '../../data/desk';
import { MatchBand } from './MatchBand';
import { SignedFillConfirm } from './SignedFillConfirm';

const MAX_LEVELS = 12;

/** UX-028 — a FIXED 2-decimal rate for the ladder rows so the decimal
 *  points line up (`formatBpsAsPercent` trims trailing zeros, giving the
 *  "5%" over "12.25%" wobble the finding calls out). Ladder-local: the
 *  header/mid/stats keep the trimmed form. */
function fixedPct(bps: number): string {
  return `${(bps / 100).toFixed(2)}%`;
}

function LevelRow({
  level,
  side,
  decimals,
  takeHref,
  takeLabel,
  flash,
  onPick,
  signedFill,
  onFillSigned,
}: {
  level: LadderLevel;
  side: 'ask' | 'bid';
  decimals: number | undefined;
  takeHref: string | null;
  takeLabel: string;
  /** Book delta pulse (#1131): the level's size changed (or the level
   *  appeared) within the same market — play one background flash.
   *  The render key embeds the size, so the changed row REMOUNTS and
   *  the CSS animation restarts without any timers. */
  flash: boolean;
  onPick: (rateBps: number) => void;
  /** The level's fillable (not-own, remaining > 0) signed order, from
   *  `signedFillCandidate` — arms the inline signed-fill affordance
   *  (#1131 slice D). Null = no affordance. */
  signedFill: SignedRowMeta | null;
  onFillSigned: (signed: SignedRowMeta) => void;
}) {
  // Any signed depth at this level gets the badge — the level may mix
  // on-chain and signed rows at the same rate.
  const hasSigned = level.offers.some((o) => o.signed !== undefined);
  // When the level's only signed depth is PARTIALLY MATCHED (fill
  // ledger non-zero ⇒ direct accept reverts SignedOfferConsumed, so
  // `signedFillCandidate` armed no button — Codex #1145 round-1 P2
  // #5), the badge tooltip explains why there's depth but no Fill:
  // the remainder fills through the matcher path only.
  const signedPartialOnly =
    hasSigned &&
    signedFill === null &&
    level.offers.some(
      (o) => o.signed !== undefined && BigInt(o.amountFilled || '0') > 0n,
    );
  // RANGE-shaped signed depth with no Fill button (Codex #1145 round-2
  // P2 — `signedFillCandidate` gates direct fills to single-value rows
  // because a ranged direct accept floor-binds while ceiling-consuming
  // the fill ledger). The row is NOT partially matched — it is
  // range-SHAPED, so it gets its own copy rather than the partial one.
  // Partial takes precedence when the level holds both shapes.
  const signedRangedOnly =
    hasSigned &&
    signedFill === null &&
    !signedPartialOnly &&
    level.offers.some(
      (o) => o.signed !== undefined && !signedOrderIsSingleValue(o.signed.order),
    );
  // UX-028 — the interactive pick target is the RATE cell (a real
  // button), NOT the whole row. That un-nests the Take / Fill controls,
  // which used to sit inside a `role="button"` row (a nested-interactive
  // a11y violation); they are now siblings of the rate button.
  const rateTitle = `${level.rateBps} bps · ${level.offers.length} offer${
    level.offers.length === 1 ? '' : 's'
  }${level.own ? ` · ${copy.desk.yourOrderMark}` : ''} — tap to pre-fill this rate`;
  return (
    <div
      className={`desk-ladder-row${level.own ? ' desk-own' : ''}${
        flash ? ' desk-row-flash' : ''
      }`}
    >
      <button
        type="button"
        className={`desk-rate-btn ${side === 'ask' ? 'desk-rate-ask' : 'desk-rate-bid'}`}
        title={rateTitle}
        onClick={() => onPick(level.rateBps)}
      >
        {fixedPct(level.rateBps)}
      </button>
      <span className="desk-num">
        {decimals !== undefined ? formatTokenAmount(level.size, decimals) : '…'}
      </span>
      <span className="desk-num muted">
        {decimals !== undefined ? formatTokenAmount(level.cumulative, decimals) : '…'}
      </span>
      <span className="desk-ladder-action">
        {hasSigned ? (
          <span
            className="desk-signed-chip"
            title={
              signedPartialOnly
                ? copy.desk.signed.partialBadgeTooltip
                : signedRangedOnly
                  ? copy.desk.signed.rangedBadgeTooltip
                  : copy.desk.signed.badgeTooltip
            }
          >
            {copy.desk.signed.badge}
          </span>
        ) : null}
        {level.own ? (
          <>
            <span className="desk-own-dot" aria-hidden />
            <span className="visually-hidden">{copy.desk.yourOrderMark}</span>
          </>
        ) : null}
        {takeHref ? (
          <Link to={takeHref} className="btn btn-secondary btn-sm">
            {takeLabel}
          </Link>
        ) : null}
        {signedFill ? (
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            title={copy.desk.signed.badgeTooltip}
            onClick={() => onFillSigned(signedFill)}
          >
            {copy.desk.signed.fill}
          </button>
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
  // Book delta animations (#1131 phase 3). Diff the incoming ladder
  // against the snapshot committed on the PREVIOUS render; only levels
  // that changed within the same (pair, tenor) market flash — a market
  // switch or first population re-stamps the snapshot silently.
  // Memoised on the ladder's identity so unrelated re-renders reuse the
  // same set (recomputing against the updated ref would strip the class
  // mid-animation); the ref itself is only advanced post-commit, which
  // keeps render pure (StrictMode double-render safe).
  const prevRef = useRef<LadderSnapshot>({ marketKey: null, sizes: new Map() });
  const flashIds = useMemo(
    () => ladderFlashIds(prevRef.current, ladder, chainId),
    [ladder, chainId],
  );
  useEffect(() => {
    prevRef.current = snapshotLadder(ladder, chainId);
  }, [ladder, chainId]);

  // Signed-fill inline confirm (#1131 slice D). Keyed by order hash so
  // a book refresh that drops the selected order also drops the panel
  // (the confirm re-vets everything live at submit anyway).
  const [fillTarget, setFillTarget] = useState<SignedRowMeta | null>(null);

  // A stale fill target must not outlive the book it was armed from
  // (Codex #1145 round-1 P2 #4): switching market/tenor swaps the
  // ladder under the panel, and a refetch can drop the order (filled /
  // cancelled elsewhere) — either way the lingering confirm would offer
  // a fill for a row the rendered book no longer shows. Clear it as
  // soon as a REAL ladder no longer lists the target's order hash. A
  // routine refetch that still contains the order never trips the
  // containment check, so an open confirm is never closed spuriously
  // mid-fill; `ladder === null` (loading / transient unavailability)
  // deliberately keeps the target — the early returns below hide the
  // confirm then anyway, and a blip must not eat an in-progress fill.
  useEffect(() => {
    if (fillTarget === null || ladder === null) return;
    const listed = [...ladder.asks, ...ladder.bids].some((lvl) =>
      lvl.offers.some((o) => o.signed?.orderHash === fillTarget.orderHash),
    );
    if (!listed) setFillTarget(null);
  }, [ladder, fillTarget]);

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
              // Size in the key: a size change remounts the row so the
              // flash animation plays once per delta (#1131).
              key={`ask-${l.rateBps}:${l.size}`}
              level={l}
              side="ask"
              decimals={decimals}
              flash={flashIds.has(levelFlashId('ask', l.rateBps))}
              onPick={onPickRate}
              takeLabel={copy.desk.takeAsk}
              takeHref={
                askTake && l.rateBps === ladder.bestAskBps
                  ? `/borrow?offer=${askTake.offerId}&chain=${chainId}`
                  : null
              }
              signedFill={signedFillCandidate(l, wallet)?.signed ?? null}
              onFillSigned={setFillTarget}
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

          {/* Crossable-band previewMatch strip (#1131 slice B) — sits
              directly at the mid row; renders nothing unless the
              contract's own preview says the top-of-book pair is
              matchable AND the partial-fill master flag is on. */}
          <MatchBand ladder={ladder} decimals={decimals} symbol={symbol} />

          <div className="desk-ladder-side-label">{copy.desk.bidsHeading}</div>
          {bidsShown.map((l) => (
            <LevelRow
              key={`bid-${l.rateBps}:${l.size}`}
              level={l}
              side="bid"
              decimals={decimals}
              flash={flashIds.has(levelFlashId('bid', l.rateBps))}
              onPick={onPickRate}
              takeLabel={copy.desk.takeBid}
              takeHref={
                bidTake && l.rateBps === ladder.bestBidBps
                  ? `/lend?offer=${bidTake.offerId}&chain=${chainId}`
                  : null
              }
              signedFill={signedFillCandidate(l, wallet)?.signed ?? null}
              onFillSigned={setFillTarget}
            />
          ))}
        </div>
      )}
      {fillTarget ? (
        <SignedFillConfirm
          key={fillTarget.orderHash}
          signed={fillTarget}
          onDone={() => setFillTarget(null)}
        />
      ) : null}
      {!empty ? (
        <p className="muted" style={{ marginTop: 8, fontSize: '0.8rem' }}>
          {copy.desk.rowPrefills}
        </p>
      ) : null}
    </div>
  );
}
