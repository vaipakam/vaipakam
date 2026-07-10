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
 * No chart panel in phase 1 (§8) and no History tab (phase 2) —
 * neither is faked with placeholders.
 *
 * Route rule: hidden from Basic navigation but URL-reachable in both
 * modes (the shell's hidden-not-blocked doctrine, same as /offers).
 */
import { useEffect, useMemo, useState } from 'react';
import { copy } from '../content/copy';
import { useActiveChain } from '../chain/useActiveChain';
import { MarketFreshnessNote } from '../components/MarketFreshnessNote';
import { DeskHeader } from '../components/desk/DeskHeader';
import { RateLadder } from '../components/desk/RateLadder';
import { OrderTicket } from '../components/desk/OrderTicket';
import { TapePanel } from '../components/desk/TapePanel';
import { OpenOrdersPanel } from '../components/desk/OpenOrdersPanel';
import { PositionsPanel } from '../components/desk/PositionsPanel';
import { useTokenMeta } from '../contracts/erc20';
import { OFFER_DURATION_DEFAULT_DAYS } from '../lib/offerSchema';
import {
  buildLadder,
  useDeskBook,
  useDeskMarkets,
  useDeskTape,
  type DeskPair,
} from '../data/desk';

type BottomTab = 'orders' | 'positions';

export function Desk() {
  const { address, readChain } = useActiveChain();

  const [pair, setPair] = useState<DeskPair | null>(null);
  const [days, setDays] = useState<number>(OFFER_DURATION_DEFAULT_DAYS);
  const [prefill, setPrefill] = useState<{ rateBps: number; nonce: number } | null>(
    null,
  );
  const [tab, setTab] = useState<BottomTab>('orders');

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
  // per-chain) — reset to rediscover from that chain's markets.
  useEffect(() => {
    setPair(null);
    setPrefill(null);
  }, [readChain.chainId]);

  const book = useDeskBook(pair);
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
    <div>
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

      <div className="desk-main">
        <div className="desk-book-col">
          {pair === null ? (
            <div className="card">
              <h2 className="card-title">{copy.desk.bookTitle}</h2>
              <p className="muted">
                {markets.isLoading ? 'Loading markets…' : copy.desk.pickPair}
              </p>
            </div>
          ) : (
            <>
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
              <TapePanel
                fills={tape.data}
                loading={tape.isLoading}
                decimals={lendingMeta.data?.decimals}
                symbol={lendingMeta.data?.symbol}
              />
            </>
          )}
        </div>
        <div className="desk-ticket-col">
          <OrderTicket pair={pair} days={days} prefill={prefill} />
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <div className="segmented" style={{ marginBottom: 12, maxWidth: 360 }}>
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
        </div>
        {tab === 'orders' ? <OpenOrdersPanel /> : <PositionsPanel />}
      </div>
    </div>
  );
}
