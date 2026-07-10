/**
 * Rate Desk header strip (#1129 §3): pair chip + tenor chips + the
 * market stats (last fill / quoted mid / spread).
 *
 * Markets come from the indexer's `/offers/markets` summary. When that
 * list is unavailable the header says so honestly and tenor emphasis
 * degrades to the selected pair's own book rows (the only market the
 * desk can still see). Deliberately NO 24h %-change ticker — on a thin
 * market that is noise sold as signal (§5.3); the header shows the
 * last fill's rate and age instead.
 */
import { useMemo, useState } from 'react';
import { copy } from '../../content/copy';
import { SelectMenu, type SelectMenuOption } from '../SelectMenu';
import { isAddressLike } from '../../contracts/erc20';
import {
  OFFER_DURATION_BUCKETS_DAYS,
} from '../../lib/offerSchema';
import {
  formatBpsAsPercent,
  formatDurationDays,
  formatTimeAgo,
  shortAddress,
} from '../../lib/format';
import type { MarketSummary, IndexedLoan, IndexedOffer } from '../../data/indexer';
import {
  isLiveMarketRow,
  pairKey,
  useSymbolMap,
  type DeskLadder,
  type DeskPair,
} from '../../data/desk';

const CUSTOM = '__custom__';

export function DeskHeader({
  markets,
  marketsUnavailable,
  pair,
  onPair,
  days,
  onDays,
  bookRows,
  ladder,
  lastFill,
}: {
  /** undefined = loading, null = unavailable, [] = truly none. */
  markets: MarketSummary[] | null | undefined;
  marketsUnavailable: boolean;
  pair: DeskPair | null;
  onPair: (pair: DeskPair) => void;
  days: number;
  onDays: (days: number) => void;
  /** The selected pair's book rows (tenor-emphasis fallback when the
   *  markets list is unavailable). */
  bookRows: IndexedOffer[] | undefined;
  ladder: DeskLadder | null;
  /** Newest tape row for the (pair, tenor) market — tenor-scoped by
   *  construction (a 7d fill must never seed the 30d header). */
  lastFill: IndexedLoan | null | undefined;
}) {
  const [customOpen, setCustomOpen] = useState(false);
  const [customLend, setCustomLend] = useState('');
  const [customColl, setCustomColl] = useState('');

  // Distinct pairs from the markets summary (a pair may span tenors).
  const pairs = useMemo((): DeskPair[] => {
    const seen = new Map<string, DeskPair>();
    for (const m of markets ?? []) {
      const p = { lendingAsset: m.lendingAsset, collateralAsset: m.collateralAsset };
      if (!seen.has(pairKey(p))) seen.set(pairKey(p), p);
    }
    // Keep a custom-picked pair selectable even when it has no market
    // row yet (the ticket can post the first offer into it).
    if (pair && !seen.has(pairKey(pair))) seen.set(pairKey(pair), pair);
    return [...seen.values()];
  }, [markets, pair]);

  const symbolMap = useSymbolMap(
    useMemo(
      () => pairs.flatMap((p) => [p.lendingAsset, p.collateralAsset]),
      [pairs],
    ),
  );
  const sym = (addr: string) => symbolMap[addr.toLowerCase()] ?? shortAddress(addr);

  const pairOptions = useMemo((): SelectMenuOption[] => {
    const opts: SelectMenuOption[] = pairs.map((p) => ({
      value: pairKey(p),
      label: `${sym(p.lendingAsset)} / ${sym(p.collateralAsset)}`,
      sub: `${shortAddress(p.lendingAsset)} · ${shortAddress(p.collateralAsset)}`,
    }));
    opts.push({ value: CUSTOM, label: copy.desk.customPair });
    return opts;
    // symbolMap identity is captured via `sym` — pairs + map are the deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pairs, symbolMap]);

  // Tenor chips: the fixed buckets UNION whatever tenors the markets
  // summary advertises for the selected pair — a discovered non-bucket
  // market (say 45d, posted by a power user against the Diamond
  // directly) must be selectable, not advertised-yet-unreachable. The
  // currently-selected tenor stays a chip too (a market emptying out
  // must not strand the active selection). The selected pair's own
  // book rows join the union as well (Codex #1134 round-3): when
  // /offers/markets is unavailable or lagging, a custom pair's
  // non-bucket tenor discovered in the CHAIN book would otherwise be
  // unreachable — visible in the ladder's source rows yet with no
  // chip to select it. Non-bucket chips render identically; live
  // emphasis below is unchanged.
  const tenorChips = useMemo((): number[] => {
    const out = new Set<number>(OFFER_DURATION_BUCKETS_DAYS);
    out.add(days);
    if (Array.isArray(markets) && pair) {
      for (const m of markets) {
        if (
          m.lendingAsset.toLowerCase() === pair.lendingAsset.toLowerCase() &&
          m.collateralAsset.toLowerCase() === pair.collateralAsset.toLowerCase()
        ) {
          out.add(m.durationDays);
        }
      }
    }
    const nowSec = Math.floor(Date.now() / 1000);
    for (const o of bookRows ?? []) {
      // Same liveness rule the emphasis fallback uses — a tenor whose
      // only rows are expired/empty should not mint a chip.
      if (isLiveMarketRow(o, o.durationDays, nowSec)) out.add(o.durationDays);
    }
    return [...out].sort((a, b) => a - b);
  }, [markets, pair, days, bookRows]);

  // Tenor emphasis: which durations have live offers for the selected
  // pair. Markets summary first; the pair's own book rows as the
  // fallback when that list is unavailable.
  const tenorLive = useMemo((): Set<number> => {
    const out = new Set<number>();
    if (Array.isArray(markets) && pair) {
      for (const m of markets) {
        if (
          m.lendingAsset.toLowerCase() === pair.lendingAsset.toLowerCase() &&
          m.collateralAsset.toLowerCase() === pair.collateralAsset.toLowerCase() &&
          m.lenderOffers + m.borrowerOffers > 0
        ) {
          out.add(m.durationDays);
        }
      }
      return out;
    }
    const nowSec = Math.floor(Date.now() / 1000);
    for (const o of bookRows ?? []) {
      if (isLiveMarketRow(o, o.durationDays, nowSec)) out.add(o.durationDays);
    }
    return out;
  }, [markets, pair, bookRows]);

  const selectCustom = () => {
    if (isAddressLike(customLend) && isAddressLike(customColl)) {
      onPair({ lendingAsset: customLend, collateralAsset: customColl });
      setCustomOpen(false);
    }
  };

  return (
    <div className="card desk-header">
      <div className="cluster" style={{ flexWrap: 'wrap', gap: 12, alignItems: 'flex-end' }}>
        <div className="field" style={{ margin: 0, minWidth: 220 }}>
          <label htmlFor="desk-pair">{copy.desk.marketLabel}</label>
          <SelectMenu
            id="desk-pair"
            value={customOpen ? CUSTOM : pair ? pairKey(pair) : ''}
            placeholder={copy.desk.pickPair}
            onChange={(v) => {
              if (v === CUSTOM) {
                setCustomOpen(true);
                return;
              }
              setCustomOpen(false);
              const next = pairs.find((p) => pairKey(p) === v);
              if (next) onPair(next);
            }}
            options={pairOptions}
          />
        </div>

        <div className="field" style={{ margin: 0 }}>
          <label>{copy.desk.tenorLabel}</label>
          <div className="desk-chips" role="group" aria-label={copy.desk.tenorLabel}>
            {tenorChips.map((d) => (
              <button
                key={d}
                type="button"
                className={`desk-chip${d === days ? ' active' : ''}${
                  tenorLive.has(d) ? ' has-liquidity' : ''
                }`}
                title={
                  tenorLive.has(d)
                    ? `${formatDurationDays(d)} — live offers on the book`
                    : `${formatDurationDays(d)} — no live offers yet`
                }
                onClick={() => onDays(d)}
              >
                {d}d
              </button>
            ))}
          </div>
        </div>
      </div>

      {customOpen ? (
        <div className="cluster" style={{ flexWrap: 'wrap', gap: 12, marginTop: 12 }}>
          <div className="field" style={{ margin: 0, flex: 1, minWidth: 200 }}>
            <label htmlFor="desk-custom-lend">{copy.desk.customLend}</label>
            <input
              id="desk-custom-lend"
              className="input"
              placeholder="0x…"
              value={customLend}
              onChange={(e) => setCustomLend(e.target.value.trim())}
              spellCheck={false}
              autoComplete="off"
            />
          </div>
          <div className="field" style={{ margin: 0, flex: 1, minWidth: 200 }}>
            <label htmlFor="desk-custom-coll">{copy.desk.customCollateral}</label>
            <input
              id="desk-custom-coll"
              className="input"
              placeholder="0x…"
              value={customColl}
              onChange={(e) => setCustomColl(e.target.value.trim())}
              spellCheck={false}
              autoComplete="off"
            />
          </div>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={!isAddressLike(customLend) || !isAddressLike(customColl)}
            onClick={selectCustom}
          >
            Load market
          </button>
        </div>
      ) : null}

      {marketsUnavailable ? (
        <p className="muted" style={{ marginTop: 8 }}>
          {copy.desk.marketsUnavailable}
        </p>
      ) : markets !== undefined && markets !== null && markets.length === 0 ? (
        <p className="muted" style={{ marginTop: 8 }}>
          {copy.desk.marketsEmpty}
        </p>
      ) : null}

      <div className="desk-stats" style={{ marginTop: 12 }}>
        <span className="desk-stat">
          <span className="desk-stat-label">{copy.desk.lastFill}</span>
          {lastFill ? (
            <span
              className="desk-stat-value"
              title={`${lastFill.interestRateBps} bps · loan #${lastFill.loanId}`}
            >
              {formatBpsAsPercent(lastFill.interestRateBps)} ·{' '}
              {formatTimeAgo(lastFill.startAt)}
            </span>
          ) : (
            <span className="desk-stat-value">{copy.desk.statUnknown}</span>
          )}
        </span>
        <span className="desk-stat">
          <span className="desk-stat-label">{copy.desk.quotedMid}</span>
          <span
            className="desk-stat-value"
            title={
              ladder?.midBps != null ? `${ladder.midBps} bps (quoted, not executed)` : undefined
            }
          >
            {ladder?.midBps != null
              ? formatBpsAsPercent(ladder.midBps)
              : copy.desk.statUnknown}
          </span>
        </span>
        <span className="desk-stat">
          <span className="desk-stat-label">{copy.desk.spread}</span>
          <span
            className="desk-stat-value"
            title={ladder?.spreadBps != null ? `${ladder.spreadBps} bps` : undefined}
          >
            {ladder?.spreadBps != null
              ? ladder.spreadBps < 0
                ? `${formatBpsAsPercent(Math.abs(ladder.spreadBps))} (${copy.desk.crossed})`
                : formatBpsAsPercent(ladder.spreadBps)
              : copy.desk.statUnknown}
          </span>
        </span>
      </div>
    </div>
  );
}
