/**
 * Top-bar data-freshness signal — a colour-coded pill whose state
 * answers "is what I'm looking at on this page near-real-time?".
 *
 * Two independent inputs:
 *
 *  1. **Frontier freshness** — `chainSafeHead - maxFrontier`, where
 *     `maxFrontier` is the highest block any data source on the page
 *     has confirmed it covers. That's NOT just the central indexer's
 *     `lastBlock`: the client-side RPC tail-scans (`useIndexedActiveOffers`
 *     / `useIndexedLoans`, which run a chunked `eth_getLogs` catch-up
 *     over `[indexer.lastBlock+1, watermark.safeBlock]` on top of the
 *     indexer page) routinely push the effective frontier to the chain
 *     head even when the central indexer is thousands of blocks behind.
 *     Both flow through `DataFreshnessContext`; the badge reads the max.
 *
 *  2. **Idle** — `anyLoading` from the same context: true while any
 *     registered data fetch is in flight. A fresh frontier doesn't mean
 *     the DOM is done painting (a `getLoanDetails` multicall fan-out or
 *     an offer-page paginator can still be running). "Live" — the
 *     trustworthy state — means fresh frontier AND idle.
 *
 * States:
 *
 *   - **Live (green, Wifi)** — gap < CAUGHT_UP_GAP_BLOCKS AND idle.
 *     What you see = what's on chain right now.
 *   - **Live · updating (green, spinning)** — gap < CAUGHT_UP_GAP_BLOCKS
 *     but a fetch is in flight. Data on screen is fresh; a refresh may
 *     surface a row or two more in a moment.
 *   - **Catching up (amber)** — gap below SEVERE_GAP_BLOCKS.
 *   - **Behind (red)** — gap ≥ SEVERE_GAP_BLOCKS. Operator-actionable.
 *   - **Loading (amber, spinning)** — cold load in progress, no frontier
 *     reported yet.
 *   - **Live (direct RPC) (green)** — indexer worker unreachable, but
 *     the watermark probe is healthy and the page is reading live from
 *     chain via the log-scan path (which always catches up to head).
 *   - **Live chain scan (amber)** — indexer AND watermark both unhealthy.
 *   - **Local dev (blue)** — wallet on Anvil/Hardhat.
 *
 * The ⓘ popover anchors the at-a-glance detail (state · chain · freshest
 * data block + source · chain safe head · gap · fetch-in-progress); the
 * full diagnostics drawer hosts the deeper rows.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Info, Wifi, WifiOff, Cpu, RefreshCw, AlertTriangle } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useDiamondPublicClient, useReadChain } from '../../contracts/useDiamond';
import { useLiveWatermark } from '../../hooks/useLiveWatermark';
import { watermarkPolicy } from '../../hooks/watermarkPolicy';
import { useDataFreshness } from '../../context/DataFreshnessContext';
import './IndexerStatusBadge.css';

/** Block-space thresholds — single source of truth here AND mirrored
 *  in `ChainDiagnosticsPanel.tsx`. Bumping requires touching both. */
const CAUGHT_UP_GAP_BLOCKS = 100;
const SEVERE_GAP_BLOCKS = 5000;

/** A watermark snapshot older than this (seconds) is treated as stale —
 *  the RPC probe isn't returning fresh data, so "direct RPC" isn't a
 *  healthy fallback. */
const WATERMARK_STALE_SEC = 90;

/** Cadence for the popover's live safe-block poll. Only runs while the
 *  popover is open, so the RPC cost is bounded by how long the user
 *  keeps it open (seconds, not hours). 2 s is faster than every chain's
 *  block time except Arbitrum's sub-second cadence, so the displayed
 *  number visibly ticks up on rollups and snaps forward in jumps on L1
 *  Sepolia (where `safe` only advances on epoch finality). */
const LIVE_SAFE_BLOCK_POLL_MS = 2_000;

const LOCAL_DEV_CHAIN_IDS: ReadonlySet<number> = new Set([31337, 1337]);

/** DataFreshnessContext source keys for the client-side RPC tail-scans
 *  (the chunked `eth_getLogs` catch-up over `[indexer.lastBlock+1,
 *  safeHead]` that `useIndexedActiveOffers` / `useIndexedActiveLoans`
 *  run). `offerStats` reports the central indexer's `lastBlock`; these
 *  report how far the page's own RPC scan has reached. */
const RPC_TAIL_FRONTIER_SOURCES = ['activeOffers', 'activeLoans'] as const;

interface Props {
  /** Hide the descriptive text on narrow viewports. */
  compact?: boolean;
}

interface PopoverContent {
  heading: string;
  body: string;
  stateLabel: string;
  /** When false, the block-detail rows are hidden (local-dev, or no
   *  block data available at all). */
  showBlockRows: boolean;
  /** = `maxFrontier` (max of the indexer frontier and the RPC-tail
   *  frontier) — what the on-screen data actually covers. `null` in
   *  local-dev / "no frontier reported" states. */
  freshestBlock: number | null;
  safeHead: number | null;
  blockGap: number | null;
  fetchInProgress: boolean;
}

export function IndexerStatusBadge({ compact }: Props) {
  const { t } = useTranslation();
  const chain = useReadChain();
  const publicClient = useDiamondPublicClient();
  const { snapshot: watermarkSnapshot } = useLiveWatermark(watermarkPolicy('warm'));
  const { maxFrontier, anyLoading, bySource } = useDataFreshness();
  const [popoverOpen, setPopoverOpen] = useState(false);
  // Live chain safe-head — polled directly only while the popover is
  // open. `null` until the first poll resolves (the popover seeds the
  // row with the watermark snapshot's safeBlock in the meantime, so
  // it's never blank). This is the chain's *actual* safe head, distinct
  // from `maxFrontier` (what the on-screen data covers — deliberately
  // separate; the data lags the chain head by design).
  const [liveSafeBlock, setLiveSafeBlock] = useState<number | null>(null);
  const wrapRef = useRef<HTMLSpanElement | null>(null);

  // Click-outside / Escape close.
  useEffect(() => {
    if (!popoverOpen) return;
    function onPointerDown(e: PointerEvent) {
      if (wrapRef.current?.contains(e.target as Node)) return;
      setPopoverOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setPopoverOpen(false);
    }
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [popoverOpen]);

  // Live safe-block poll — active only while the popover is open. One
  // `getBlock({safe})` per tick; stops the moment the popover closes
  // (or the component unmounts / chain switches). On close, we drop the
  // last value so the next open re-seeds from a fresh poll rather than
  // showing a stale number from a previous session.
  useEffect(() => {
    if (!popoverOpen) {
      setLiveSafeBlock(null);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    async function poll() {
      try {
        const blk = await publicClient.getBlock({ blockTag: 'safe' });
        if (!cancelled) setLiveSafeBlock(Number(blk.number));
      } catch {
        // RPC hiccup — keep the last value, retry on the next tick.
      }
      if (!cancelled) timer = setTimeout(poll, LIVE_SAFE_BLOCK_POLL_MS);
    }
    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [popoverOpen, publicClient]);

  const isLocalDev =
    chain.chainId !== undefined && LOCAL_DEV_CHAIN_IDS.has(chain.chainId);
  const chainLabel = chain.name
    ? `${chain.name} (${chain.chainId})`
    : `chainId ${chain.chainId ?? '?'}`;

  const safeHead =
    watermarkSnapshot && watermarkSnapshot.safeBlock > 0n
      ? Number(watermarkSnapshot.safeBlock)
      : null;
  const watermarkAgeSec = watermarkSnapshot
    ? Math.floor(Date.now() / 1000) - watermarkSnapshot.fetchedAt
    : null;
  const watermarkHealthy =
    safeHead !== null && watermarkAgeSec !== null && watermarkAgeSec < WATERMARK_STALE_SEC;

  // Per-source frontier breakdown for the popover. `indexerFrontier` is
  // the central indexer's `lastBlock`; `rpcTailFrontier` is how far the
  // page's own client-side RPC tail-scan has reached (only contributed
  // when an OfferBook / Dashboard hook is mounted — so it's `null` on
  // pages that don't run one). `freshestBlock` / `maxFrontier` is the
  // max of the two — what the on-screen data actually covers.
  const indexerFrontier = bySource['offerStats']?.frontier ?? null;
  const rpcTailFrontier = (() => {
    const vals: number[] = [];
    for (const key of RPC_TAIL_FRONTIER_SOURCES) {
      const f = bySource[key]?.frontier;
      if (f !== undefined) vals.push(f);
    }
    return vals.length > 0 ? Math.max(...vals) : null;
  })();

  const blockGap =
    maxFrontier !== null && safeHead !== null ? Math.max(0, safeHead - maxFrontier) : null;

  let variantClass: string;
  let Icon: LucideIcon;
  let iconSpinning = false;
  let label: string;
  let popover: PopoverContent;

  if (isLocalDev) {
    variantClass = 'indexer-badge--localdev';
    Icon = Cpu;
    label = t('indexerBadge.localDev');
    popover = {
      heading: t('indexerBadge.localDevHeading'),
      body: t('indexerBadge.localDevBody'),
      stateLabel: t('indexerBadge.localDev'),
      showBlockRows: false,
      freshestBlock: null,
      safeHead: null,
      blockGap: null,
      fetchInProgress: anyLoading,
    };
  } else if (maxFrontier === null && anyLoading) {
    // Cold load — nothing reported a frontier yet, fetches in flight.
    variantClass = 'indexer-badge--catching-up';
    Icon = RefreshCw;
    iconSpinning = true;
    label = t('indexerBadge.loading');
    popover = {
      heading: t('indexerBadge.loadingHeading'),
      body: t('indexerBadge.loadingBody'),
      stateLabel: t('indexerBadge.loadingState'),
      showBlockRows: true,
      freshestBlock: null,
      safeHead,
      blockGap: null,
      fetchInProgress: true,
    };
  } else if (maxFrontier === null) {
    // Cold load done, but no frontier — the indexer worker and the
    // RPC-tail hooks didn't report a block. Either the worker is
    // unreachable (page being served by the legacy log-scan path,
    // which always reaches head), or the page just has no data hooks
    // mounted that report a frontier. Sub-state on watermark health.
    if (watermarkHealthy) {
      variantClass = 'indexer-badge--cached';
      Icon = Wifi;
      label = `${t('indexerBadge.lastSafeBlock')}: ${safeHead!.toLocaleString()}`;
      popover = {
        heading: t('indexerBadge.liveRpcInSyncHeading'),
        body: t('indexerBadge.liveRpcInSyncBody'),
        stateLabel: t('indexerBadge.liveRpcInSync'),
        showBlockRows: true,
        freshestBlock: null,
        safeHead,
        blockGap: null,
        fetchInProgress: anyLoading,
      };
    } else {
      variantClass = 'indexer-badge--live';
      Icon = WifiOff;
      label = t('indexerBadge.live');
      popover = {
        heading: t('indexerBadge.liveHeading'),
        body: t('indexerBadge.liveBody'),
        stateLabel: t('indexerBadge.live'),
        showBlockRows: false,
        freshestBlock: null,
        safeHead: null,
        blockGap: null,
        fetchInProgress: anyLoading,
      };
    }
  } else {
    // We have a frontier. Colour purely on the gap; the spinner conveys
    // "and a fetch is in flight" without a colour change.
    const gap = blockGap ?? 0;
    if (gap >= SEVERE_GAP_BLOCKS) {
      variantClass = 'indexer-badge--behind';
      Icon = AlertTriangle;
      label = t('indexerBadge.behind', { n: gap.toLocaleString() });
      popover = {
        heading: t('indexerBadge.behindHeading'),
        body: t('indexerBadge.behindBody'),
        stateLabel: t('indexerBadge.behindState'),
        showBlockRows: true,
        freshestBlock: maxFrontier,
        safeHead,
        blockGap: gap,
        fetchInProgress: anyLoading,
      };
    } else if (gap >= CAUGHT_UP_GAP_BLOCKS) {
      variantClass = 'indexer-badge--catching-up';
      Icon = RefreshCw;
      iconSpinning = anyLoading;
      label = t('indexerBadge.catchingUp', { n: gap.toLocaleString() });
      popover = {
        heading: t('indexerBadge.catchingUpHeading'),
        body: t('indexerBadge.catchingUpBody'),
        stateLabel: t('indexerBadge.catchingUpState'),
        showBlockRows: true,
        freshestBlock: maxFrontier,
        safeHead,
        blockGap: gap,
        fetchInProgress: anyLoading,
      };
    } else if (anyLoading) {
      // Fresh frontier, but a fetch is still running — "Live · updating".
      // Green colour (the data on screen IS fresh) + spinning icon.
      variantClass = 'indexer-badge--cached';
      Icon = RefreshCw;
      iconSpinning = true;
      label = t('indexerBadge.liveUpdating', { n: maxFrontier.toLocaleString() });
      popover = {
        heading: t('indexerBadge.liveUpdatingHeading'),
        body: t('indexerBadge.liveUpdatingBody'),
        stateLabel: t('indexerBadge.liveUpdatingState'),
        showBlockRows: true,
        freshestBlock: maxFrontier,
        safeHead,
        blockGap: gap,
        fetchInProgress: true,
      };
    } else {
      // Fresh AND idle — the trustworthy "Live" state.
      variantClass = 'indexer-badge--cached';
      Icon = Wifi;
      label = `${t('indexerBadge.lastSafeBlock')}: ${maxFrontier.toLocaleString()}`;
      popover = {
        heading: t('indexerBadge.caughtUpHeading'),
        body: t('indexerBadge.caughtUpBody'),
        stateLabel: t('indexerBadge.caughtUp'),
        showBlockRows: true,
        freshestBlock: maxFrontier,
        safeHead,
        blockGap: gap,
        fetchInProgress: false,
      };
    }
  }

  return (
    <span className={`indexer-badge ${variantClass}`} ref={wrapRef}>
      <Icon size={12} className={iconSpinning ? 'indexer-badge-icon--spinning' : undefined} />
      {!compact && <span>{label}</span>}
      <button
        type="button"
        className="indexer-badge-info"
        onClick={(e) => {
          e.stopPropagation();
          setPopoverOpen((o) => !o);
        }}
        aria-expanded={popoverOpen}
        aria-label={t('indexerBadge.infoTitle')}
        title={t('indexerBadge.infoTitle')}
      >
        <Info size={12} />
      </button>
      {popoverOpen && (
        <div className="indexer-badge-popover" role="dialog">
          <div className="indexer-badge-popover-heading">{popover.heading}</div>
          <dl className="indexer-badge-popover-status">
            <Row label={t('indexerBadge.statusState')} value={popover.stateLabel} />
            <Row label={t('indexerBadge.statusChain')} value={chainLabel} />
            {popover.showBlockRows && popover.freshestBlock !== null && (
              <>
                <Row
                  label={t('indexerBadge.statusIndexerFrontier')}
                  value={
                    indexerFrontier !== null
                      ? indexerFrontier.toLocaleString()
                      : t('indexerBadge.statusFrontierIdle')
                  }
                />
                <Row
                  label={t('indexerBadge.statusRpcTailFrontier')}
                  value={
                    rpcTailFrontier !== null
                      ? rpcTailFrontier.toLocaleString()
                      : t('indexerBadge.statusRpcTailIdle')
                  }
                />
                <Row
                  label={t('indexerBadge.statusFreshestBlock')}
                  value={popover.freshestBlock.toLocaleString()}
                />
              </>
            )}
            {popover.showBlockRows && (
              <Row
                label={
                  liveSafeBlock !== null
                    ? t('indexerBadge.statusChainSafeHeadLive')
                    : t('indexerBadge.statusChainSafeHead')
                }
                value={
                  liveSafeBlock !== null ? (
                    <>
                      {liveSafeBlock.toLocaleString()}
                      <span
                        className="indexer-badge-live-dot"
                        title={t('indexerBadge.liveSafeBlockTooltip')}
                        aria-label={t('indexerBadge.liveSafeBlockTooltip')}
                      />
                    </>
                  ) : popover.safeHead !== null ? (
                    popover.safeHead.toLocaleString()
                  ) : (
                    t('indexerBadge.statusChainSafeHeadUnknown')
                  )
                }
              />
            )}
            {popover.showBlockRows && popover.blockGap !== null && (
              <Row
                label={t('indexerBadge.statusBlockGap')}
                value={
                  popover.blockGap < CAUGHT_UP_GAP_BLOCKS
                    ? t('indexerBadge.statusBlockGapCaughtUp')
                    : popover.blockGap.toLocaleString()
                }
              />
            )}
            {popover.showBlockRows && (
              <Row
                label={t('indexerBadge.statusFetchInProgress')}
                value={
                  popover.fetchInProgress
                    ? t('indexerBadge.statusFetchYes')
                    : t('indexerBadge.statusFetchNo')
                }
              />
            )}
          </dl>
          <div className="indexer-badge-popover-body">{popover.body}</div>
          <div className="indexer-badge-popover-footnote">
            {t('indexerBadge.safeBlockFootnote')}
          </div>
        </div>
      )}
    </span>
  );
}

interface RowProps {
  label: string;
  value: ReactNode;
}

function Row({ label, value }: RowProps) {
  return (
    <div className="indexer-badge-popover-status-row">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
