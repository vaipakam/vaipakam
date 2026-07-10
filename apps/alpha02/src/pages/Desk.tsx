/**
 * Rate Desk (#1129 phase 1) — the advanced-only trading terminal for
 * the offer book, per docs/DesignsAndPlans/ProRateTerminalDesign.md.
 *
 * One dense screen for a (pair, tenor) market: header strip (pair +
 * tenor chips + last fill / quoted mid / spread), the rate ladder
 * (two-step on-chain read with indexer fallback), the order ticket
 * (createOffer with expiry + fill-mode chips), the tape (executed
 * fills), and bottom tabs for Open orders (cancel + the first amend
 * UI, #193) and Positions (current-holder reads + HF badges).
 *
 * A market = (lendingAsset, collateralAsset, durationDays) — the
 * on-chain matcher requires EXACT duration equality, so depth exists
 * per tenor and the tenor chip is a first-class market selector.
 *
 * Phase 2 (#1130) adds the executed-rate chart (central panel on
 * desktop; behind the mobile Book|Chart toggle per the ratified
 * mobile pattern — the primary mobile view stays ladder + ticket
 * side-by-side, with the chart AND tape behind the bottom segmented
 * toggle) and the History bottom tab (the wallet's permanent desk
 * activity via the historical-participant route).
 *
 * The chart component is React.lazy-loaded: `lightweight-charts`
 * lands in RateChart's own chunk, so users who never open /desk never
 * download it (§7 of the design doc).
 *
 * Route rule: hidden from Basic navigation but URL-reachable in both
 * modes (the shell's hidden-not-blocked doctrine, same as /offers).
 */
import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import { copy } from '../content/copy';
import { useActiveChain } from '../chain/useActiveChain';
import { MarketFreshnessNote } from '../components/MarketFreshnessNote';
import { DeskHeader } from '../components/desk/DeskHeader';
import { RateLadder } from '../components/desk/RateLadder';
import { OrderTicket } from '../components/desk/OrderTicket';
import { TapePanel } from '../components/desk/TapePanel';
import { OpenOrdersPanel } from '../components/desk/OpenOrdersPanel';
import { PositionsPanel } from '../components/desk/PositionsPanel';
import { HistoryPanel } from '../components/desk/HistoryPanel';
import { useTokenMeta } from '../contracts/erc20';
import { OFFER_DURATION_DEFAULT_DAYS } from '../lib/offerSchema';
import {
  buildLadder,
  useDeskBook,
  useDeskMarkets,
  useDeskTape,
  type DeskPair,
} from '../data/desk';

/** Lazy boundary — keeps lightweight-charts out of the entry chunk. */
const RateChart = lazy(() => import('../components/desk/RateChart'));

type BottomTab = 'orders' | 'positions' | 'history';
type MobileView = 'book' | 'chart';

export function Desk() {
  const { address, readChain } = useActiveChain();

  const [pair, setPair] = useState<DeskPair | null>(null);
  const [days, setDays] = useState<number>(OFFER_DURATION_DEFAULT_DAYS);
  const [prefill, setPrefill] = useState<{ rateBps: number; nonce: number } | null>(
    null,
  );
  const [tab, setTab] = useState<BottomTab>('orders');
  const [mobileView, setMobileView] = useState<MobileView>('book');

  const markets = useDeskMarkets();

  // Default market: the most active one (the endpoint orders by live
  // offer count) once the list lands, if the user hasn't picked one.
  // The TENOR comes with the pair — a market is the full (pair, tenor)
  // triple, and keeping the hard-coded 30d default would land on an
  // empty book whenever the most active market trades another tenor.
  useEffect(() => {
    if (pair !== null) return;
    const first = markets.data?.[0];
    if (first) {
      setPair({
        lendingAsset: first.lendingAsset,
        collateralAsset: first.collateralAsset,
      });
      setDays(first.durationDays);
    }
  }, [markets.data, pair]);

  // Chain switch invalidates the selected pair (addresses are
  // per-chain) — reset to rediscover from that chain's markets. Gated
  // to ACTUAL post-mount chain changes (Codex #1134 round-6 P3): an
  // unconditional first run also fires on remount with the markets
  // list already cached, where its queued setPair(null) lands after
  // the default-market pick above — and the default effect never
  // re-runs (same markets.data, pair null both renders), stranding
  // the desk on "Pick a market".
  const prevChainId = useRef(readChain.chainId);
  useEffect(() => {
    if (prevChainId.current === readChain.chainId) return;
    prevChainId.current = readChain.chainId;
    setPair(null);
    setPrefill(null);
  }, [readChain.chainId]);

  const book = useDeskBook(pair, days);
  const tape = useDeskTape(pair, days);
  const lendingMeta = useTokenMeta(pair?.lendingAsset);

  const ladder = useMemo(() => {
    if (!Array.isArray(book.data?.rows)) return null;
    return buildLadder(
      book.data.rows,
      days,
      Math.floor(Date.now() / 1000),
      address,
    );
  }, [book.data, days, address]);

  const lastFill = tape.data === undefined ? undefined : (tape.data?.[0] ?? null);

  return (
    // The desk-container class establishes a size container so the
    // desk's layout breakpoints key on the width the desk ACTUALLY
    // has — the app shell's sidebar consumes ~350px, so a viewport
    // media query overstates the available width by that much (the
    // CI 1280px viewport leaves only ~812px here, which crushed the
    // three-column ladder to zero-width rate cells — spec 17's
    // first fork-tier failure on this branch).
    <div className="desk-container">
      <h1 className="page-title">{copy.desk.title}</h1>
      <p className="page-lede">{copy.desk.lede}</p>

      <MarketFreshnessNote />

      <DeskHeader
        markets={markets.data}
        marketsUnavailable={!markets.isLoading && markets.data === null}
        pair={pair}
        onPair={(p) => {
          setPair(p);
          setPrefill(null);
        }}
        days={days}
        onDays={setDays}
        bookRows={book.data?.rows}
        ladder={ladder}
        lastFill={lastFill}
      />

      <div
        className={`desk-main${mobileView === 'chart' ? ' desk-mobile-chart' : ''}`}
      >
        {/* Chart column — central panel on desktop (chart above the
            tape, mirroring the reference terminals' chart-center-left
            arrangement); behind the Book|Chart toggle on mobile. */}
        <div className="desk-chart-col">
          <Suspense
            fallback={
              <div className="card desk-chart-card">
                <h2 className="card-title">{copy.desk.chart.title}</h2>
                <p className="muted">{copy.desk.chart.loading}</p>
              </div>
            }
          >
            <RateChart
              pair={pair}
              days={days}
              decimals={lendingMeta.data?.decimals}
              symbol={lendingMeta.data?.symbol}
              quotedMidBps={ladder?.midBps ?? null}
              // The whole tape, not just the newest fill (#1139): sparse
              // mode draws one marker per tape fill, and the empty-copy
              // split needs to know whether older fills exist at all.
              tape={tape.data}
            />
          </Suspense>
          {pair !== null ? (
            <TapePanel
              fills={tape.data}
              loading={tape.isLoading}
              decimals={lendingMeta.data?.decimals}
              symbol={lendingMeta.data?.symbol}
            />
          ) : null}
        </div>
        <div className="desk-book-col">
          {pair === null ? (
            <div className="card">
              <h2 className="card-title">{copy.desk.bookTitle}</h2>
              <p className="muted">
                {markets.isLoading ? 'Loading markets…' : copy.desk.pickPair}
              </p>
            </div>
          ) : (
            <RateLadder
              ladder={ladder}
              loading={book.isLoading}
              unavailable={!book.isLoading && book.data === null}
              source={book.data?.source ?? null}
              decimals={lendingMeta.data?.decimals}
              symbol={lendingMeta.data?.symbol}
              chainId={readChain.chainId}
              wallet={address}
              onPickRate={(rateBps) =>
                setPrefill({ rateBps, nonce: Date.now() })
              }
            />
          )}
        </div>
        <div className="desk-ticket-col">
          <OrderTicket pair={pair} days={days} prefill={prefill} />
        </div>
      </div>

      {/* Mobile-only bottom-center toggle (ratified pattern §3): the
          primary view stays ladder + ticket; chart + tape sit behind
          the Chart segment. Hidden ≥ 720px where all columns render. */}
      <div className="desk-view-toggle">
        <div
          className="segmented"
          role="group"
          aria-label={copy.desk.chart.mobileViewLabel}
        >
          <button
            type="button"
            className={mobileView === 'book' ? 'active' : ''}
            onClick={() => setMobileView('book')}
          >
            {copy.desk.chart.mobileBook}
          </button>
          <button
            type="button"
            className={mobileView === 'chart' ? 'active' : ''}
            onClick={() => setMobileView('chart')}
          >
            {copy.desk.chart.mobileChart}
          </button>
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <div className="segmented" style={{ marginBottom: 12, maxWidth: 420 }}>
          <button
            type="button"
            className={tab === 'orders' ? 'active' : ''}
            onClick={() => setTab('orders')}
          >
            {copy.desk.orders.tab}
          </button>
          <button
            type="button"
            className={tab === 'positions' ? 'active' : ''}
            onClick={() => setTab('positions')}
          >
            {copy.desk.positions.tab}
          </button>
          <button
            type="button"
            className={tab === 'history' ? 'active' : ''}
            onClick={() => setTab('history')}
          >
            {copy.desk.history.tab}
          </button>
        </div>
        {tab === 'orders' ? (
          <OpenOrdersPanel />
        ) : tab === 'positions' ? (
          <PositionsPanel />
        ) : (
          <HistoryPanel />
        )}
      </div>
    </div>
  );
}
