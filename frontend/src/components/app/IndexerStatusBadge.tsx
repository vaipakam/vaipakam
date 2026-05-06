/**
 * Top-bar indexer freshness signal — slim glance-only pill.
 *
 * Single source of truth: the gap between the watcher's last-indexed
 * `safe` block and the chain's current `safe` head, in block-space.
 * No time projections, no "X min ago" framing — the gap captures both
 * indexer lag and watcher health (a stuck cron lets the gap balloon).
 *
 * Five states drive five colours:
 *
 *   - **Caught up (green)** — gap < CAUGHT_UP_GAP_BLOCKS. Page is
 *     rendering the latest finalised chain state.
 *   - **Catching up (amber)** — CAUGHT_UP_GAP_BLOCKS ≤ gap < SEVERE_GAP_BLOCKS.
 *     Indexer trailing the chain head, cron working.
 *   - **Behind (red)** — gap ≥ SEVERE_GAP_BLOCKS. Either watcher cron
 *     stalled or chain spike caused a backlog. Operator-actionable.
 *   - **Live chain scan (amber)** — indexer cache unreachable, browser
 *     falls back to direct RPC reads. Different from "catching up" —
 *     same colour family, distinct background tone.
 *   - **Local dev (blue)** — wallet on Anvil/Hardhat (31337/1337);
 *     cloud indexer doesn't cover local nodes.
 *
 * The info icon dispatches a window-level `vp:open-diagnostics` event
 * that the DiagnosticsDrawer subscribes to (see
 * `ChainDiagnosticsPanel.tsx`). The drawer holds the full state
 * breakdown — heading, body explanation, all rows (chain safe head,
 * indexed block, gap, source, browser storage, build version,
 * footnote on what "safe block" means).
 *
 * Manual "Rescan" was deliberately omitted: an RPC-quota abuse vector
 * + wrong mental model that users "need" to refresh. Auto-refetch on
 * tab-focus + 60 s background tail + post-tx confirmation is the
 * modern DeFi pattern.
 */

import { useTranslation } from 'react-i18next';
import { Info, Wifi, WifiOff, Cpu, RefreshCw, AlertTriangle } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useOfferStats } from '../../hooks/useOfferStats';
import { useReadChain } from '../../contracts/useDiamond';
import { useLiveWatermark } from '../../hooks/useLiveWatermark';
import { watermarkPolicy } from '../../hooks/watermarkPolicy';
import { OPEN_DIAGNOSTICS_EVENT } from './DiagnosticsDrawer';
import './IndexerStatusBadge.css';

/** Block-space thresholds — single source of truth here AND mirrored
 *  in `ChainDiagnosticsPanel.tsx`. Bumping these requires touching
 *  both sites; the duplication is intentional to avoid a circular
 *  import (panel imports from this file would need it). */
const CAUGHT_UP_GAP_BLOCKS = 100;
const SEVERE_GAP_BLOCKS = 5000;

const LOCAL_DEV_CHAIN_IDS: ReadonlySet<number> = new Set([31337, 1337]);

interface Props {
  /** Hide the descriptive text on narrow viewports — keeps just the
   *  colour-coded icon + info button so the pill collapses cleanly. */
  compact?: boolean;
}

export function IndexerStatusBadge({ compact }: Props) {
  const { t } = useTranslation();
  const { stats } = useOfferStats();
  const chain = useReadChain();
  // Independent watermark probe at the badge level. `useOfferStats`
  // upstream runs its own; at 20 s 'warm' cadence the cost of two
  // subscribers is trivial and avoids prop-drilling.
  const { snapshot: watermarkSnapshot } = useLiveWatermark(
    watermarkPolicy('warm'),
  );

  const isLocalDev =
    chain.chainId !== undefined && LOCAL_DEV_CHAIN_IDS.has(chain.chainId);

  // Resolve to one of five (variantClass, icon, label) tuples. Keeping
  // the resolution flat avoids the prior 3-branch return tree.
  let variantClass: string;
  let Icon: LucideIcon;
  let label: string;

  if (isLocalDev) {
    variantClass = 'indexer-badge--localdev';
    Icon = Cpu;
    label = t('indexerBadge.localDev');
  } else if (!stats || !stats.indexer) {
    variantClass = 'indexer-badge--live';
    Icon = WifiOff;
    label = t('indexerBadge.live');
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
    } else if (blockGap >= CAUGHT_UP_GAP_BLOCKS) {
      variantClass = 'indexer-badge--catching-up';
      Icon = RefreshCw;
      label = t('indexerBadge.catchingUp', { n: blockGap.toLocaleString() });
    } else {
      variantClass = 'indexer-badge--cached';
      Icon = Wifi;
      label = `${t('indexerBadge.lastSafeBlock')}: ${lastIndexedBlock.toLocaleString()}`;
    }
  }

  return (
    <span className={`indexer-badge ${variantClass}`}>
      <Icon size={12} />
      {!compact && <span>{label}</span>}
      <button
        type="button"
        className="indexer-badge-info"
        onClick={(e) => {
          e.stopPropagation();
          // Decoupled drawer-open via window event — avoids dragging
          // a state library in for one cross-component handshake.
          // DiagnosticsDrawer.tsx subscribes to OPEN_DIAGNOSTICS_EVENT
          // and flips its `open` state to true.
          window.dispatchEvent(new CustomEvent(OPEN_DIAGNOSTICS_EVENT));
        }}
        title={t('indexerBadge.openDiagnosticsTitle', {
          defaultValue: 'Open diagnostics',
        })}
        aria-label={t('indexerBadge.openDiagnosticsTitle', {
          defaultValue: 'Open diagnostics',
        })}
      >
        <Info size={12} />
      </button>
    </span>
  );
}
