/**
 * Top-bar indexer freshness signal — a colour-coded pill driven purely
 * by the gap between the watcher's last-indexed `safe` block and the
 * chain's current `safe` head, in block-space. Five states:
 *
 *   - **Caught up (green)** — gap < CAUGHT_UP_GAP_BLOCKS.
 *   - **Catching up (amber)** — gap below SEVERE_GAP_BLOCKS.
 *   - **Behind (red)** — gap ≥ SEVERE_GAP_BLOCKS. Operator-actionable.
 *   - **Live chain scan (amber)** — indexer cache unreachable.
 *   - **Local dev (blue)** — wallet on Anvil/Hardhat.
 *
 * Clicking the small ⓘ icon opens a concise popover anchored to the
 * pill — heading + plain-language body + the three block-space rows
 * (state, last safe block, gap) + a footnote explaining "safe block".
 * The popover is the at-a-glance answer; the full diagnostics drawer
 * (independent FAB) hosts deeper rows like browser-storage usage,
 * frontend build hash, and the dev-only purge affordance.
 */

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Info, Wifi, WifiOff, Cpu, RefreshCw, AlertTriangle } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useOfferStats } from '../../hooks/useOfferStats';
import { useReadChain } from '../../contracts/useDiamond';
import { useLiveWatermark } from '../../hooks/useLiveWatermark';
import { watermarkPolicy } from '../../hooks/watermarkPolicy';
import './IndexerStatusBadge.css';

/** Block-space thresholds — single source of truth here AND mirrored
 *  in `ChainDiagnosticsPanel.tsx`. Bumping requires touching both. */
const CAUGHT_UP_GAP_BLOCKS = 100;
const SEVERE_GAP_BLOCKS = 5000;

const LOCAL_DEV_CHAIN_IDS: ReadonlySet<number> = new Set([31337, 1337]);

interface Props {
  /** Hide the descriptive text on narrow viewports. */
  compact?: boolean;
}

interface PopoverContent {
  heading: string;
  body: string;
  stateLabel: string;
  /** Optional rows shown only when the indexer cache is reachable. */
  showBlockRows: boolean;
  lastIndexedBlock: number | null;
  safeHead: number | null;
  blockGap: number | null;
}

export function IndexerStatusBadge({ compact }: Props) {
  const { t } = useTranslation();
  const { stats } = useOfferStats();
  const chain = useReadChain();
  const { snapshot: watermarkSnapshot } = useLiveWatermark(
    watermarkPolicy('warm'),
  );
  const [popoverOpen, setPopoverOpen] = useState(false);
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

  const isLocalDev =
    chain.chainId !== undefined && LOCAL_DEV_CHAIN_IDS.has(chain.chainId);
  const chainLabel = chain.name
    ? `${chain.name} (${chain.chainId})`
    : `chainId ${chain.chainId ?? '?'}`;

  // Resolve all visual + popover content in one pass to keep the JSX flat.
  let variantClass: string;
  let Icon: LucideIcon;
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
      lastIndexedBlock: null,
      safeHead: null,
      blockGap: null,
    };
  } else if (!stats || !stats.indexer) {
    // Indexer cache unreachable (worker down, env mis-configured,
    // hosted-domain retired, etc.). Sub-state on whether the live RPC
    // tail is healthy: if the watermark probe has succeeded recently
    // AND we have a non-zero safeBlock, the page IS reading live from
    // chain successfully — this is a "synced via direct RPC" green
    // state, not a degraded state. Falls back to the legacy amber
    // "live chain scan" only when the watermark is stale or missing,
    // which means RPC itself is also unhealthy.
    const watermarkAgeSec = watermarkSnapshot
      ? Math.floor(Date.now() / 1000) - watermarkSnapshot.fetchedAt
      : null;
    const liveRpcHealthy =
      watermarkSnapshot &&
      watermarkSnapshot.safeBlock > 0n &&
      watermarkAgeSec !== null &&
      watermarkAgeSec < 90;

    if (liveRpcHealthy) {
      // Green — direct-from-chain reads are working; page renders
      // up to the chain `safe` head via the live RPC tail.
      const safeBlockNum = Number(watermarkSnapshot.safeBlock);
      variantClass = 'indexer-badge--cached';
      Icon = Wifi;
      label = `${t('indexerBadge.lastSafeBlock')}: ${safeBlockNum.toLocaleString()}`;
      popover = {
        heading: t('indexerBadge.liveRpcInSyncHeading'),
        body: t('indexerBadge.liveRpcInSyncBody'),
        stateLabel: t('indexerBadge.liveRpcInSync'),
        showBlockRows: true,
        // No indexer to compare against — skip the indexed-block row
        // and the gap row; show only the chain safe head.
        lastIndexedBlock: null,
        safeHead: safeBlockNum,
        blockGap: null,
      };
    } else {
      // Amber — legacy "live chain scan" state, kept for the case
      // where neither the indexer nor the watermark probe is
      // returning fresh data (RPC degraded or unreachable).
      variantClass = 'indexer-badge--live';
      Icon = WifiOff;
      label = t('indexerBadge.live');
      popover = {
        heading: t('indexerBadge.liveHeading'),
        body: t('indexerBadge.liveBody'),
        stateLabel: t('indexerBadge.live'),
        showBlockRows: false,
        lastIndexedBlock: null,
        safeHead: null,
        blockGap: null,
      };
    }
  } else {
    const lastIndexedBlock = stats.indexer.lastBlock;
    const safeBlockNum =
      watermarkSnapshot && watermarkSnapshot.safeBlock > 0n
        ? Number(watermarkSnapshot.safeBlock)
        : null;
    const blockGap =
      safeBlockNum !== null
        ? Math.max(0, safeBlockNum - lastIndexedBlock)
        : 0;

    if (blockGap >= SEVERE_GAP_BLOCKS) {
      variantClass = 'indexer-badge--behind';
      Icon = AlertTriangle;
      label = t('indexerBadge.behind', { n: blockGap.toLocaleString() });
      popover = {
        heading: t('indexerBadge.behindHeading'),
        body: t('indexerBadge.behindBody'),
        stateLabel: t('indexerBadge.behindState'),
        showBlockRows: true,
        lastIndexedBlock,
        safeHead: safeBlockNum,
        blockGap,
      };
    } else if (blockGap >= CAUGHT_UP_GAP_BLOCKS) {
      variantClass = 'indexer-badge--catching-up';
      Icon = RefreshCw;
      label = t('indexerBadge.catchingUp', { n: blockGap.toLocaleString() });
      popover = {
        heading: t('indexerBadge.catchingUpHeading'),
        body: t('indexerBadge.catchingUpBody'),
        stateLabel: t('indexerBadge.catchingUpState'),
        showBlockRows: true,
        lastIndexedBlock,
        safeHead: safeBlockNum,
        blockGap,
      };
    } else {
      variantClass = 'indexer-badge--cached';
      Icon = Wifi;
      label = `${t('indexerBadge.lastSafeBlock')}: ${lastIndexedBlock.toLocaleString()}`;
      popover = {
        heading: t('indexerBadge.caughtUpHeading'),
        body: t('indexerBadge.caughtUpBody'),
        stateLabel: t('indexerBadge.caughtUp'),
        showBlockRows: true,
        lastIndexedBlock,
        safeHead: safeBlockNum,
        blockGap,
      };
    }
  }

  return (
    <span className={`indexer-badge ${variantClass}`} ref={wrapRef}>
      <Icon size={12} />
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
            <Row
              label={t('indexerBadge.statusState')}
              value={popover.stateLabel}
            />
            <Row
              label={t('indexerBadge.statusChain')}
              value={chainLabel}
            />
            {popover.showBlockRows && popover.lastIndexedBlock !== null && (
              <Row
                label={t('indexerBadge.statusLastSafeBlock')}
                value={popover.lastIndexedBlock.toLocaleString()}
              />
            )}
            {popover.showBlockRows && (
              <Row
                label={t('indexerBadge.statusChainSafeHead')}
                value={
                  popover.safeHead !== null
                    ? popover.safeHead.toLocaleString()
                    : t('indexerBadge.statusChainSafeHeadUnknown')
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
  value: string;
}

function Row({ label, value }: RowProps) {
  return (
    <div className="indexer-badge-popover-status-row">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
