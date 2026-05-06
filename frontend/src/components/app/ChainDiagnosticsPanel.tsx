/**
 * Operator/dev-facing chain & indexer diagnostics panel rendered at
 * the top of the DiagnosticsDrawer (above the journey-events list).
 *
 * Surfaces the same gap-vs-safe-head signal the top-bar IndexerStatusBadge
 * uses to colour itself, but expanded with the full block-space numbers
 * and the local-storage / build-version context an operator wants when
 * the badge has gone amber/red. Lives in the drawer (not in the badge's
 * inline popover) per the 2026-05-06 design pivot — the badge stays a
 * glance-only signal; deep details live where they're already adjacent
 * to the failure-events feed.
 *
 * Reuses the `indexerBadge.*` i18n namespace for state headings + body
 * + footnote (same English strings either way) and adds a small
 * `chainDiagnostics.*` namespace for panel-specific labels.
 */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Trash2, ChevronDown, ChevronRight } from 'lucide-react';
import { useOfferStats } from '../../hooks/useOfferStats';
import { useReadChain } from '../../contracts/useDiamond';
import { useLiveWatermark } from '../../hooks/useLiveWatermark';
import { watermarkPolicy } from '../../hooks/watermarkPolicy';
import { useMode } from '../../context/ModeContext';

/** Mirror the badge's block-space thresholds — single source of truth
 *  in the badge file would be cleaner, but keeping the constants local
 *  to the panel avoids a circular import (badge → panel reuse). The
 *  numbers are stable; if they change, update both sites. */
const CAUGHT_UP_GAP_BLOCKS = 100;
const SEVERE_GAP_BLOCKS = 5000;

interface StorageEstimate {
  usage?: number;
  quota?: number;
}

/** Bytes → human-readable string. Returns "—" when undefined. */
function formatBytes(n: number | undefined): string {
  if (n === undefined || n === null) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MiB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GiB`;
}

export function ChainDiagnosticsPanel() {
  const { t } = useTranslation();
  const { mode } = useMode();
  const chain = useReadChain();
  const { stats } = useOfferStats();
  // Independent watermark probe — useLiveWatermark is per-call and cheap
  // at the 'warm' (20 s) cadence. The badge runs its own probe in
  // parallel; 2× the network cost on a non-critical path.
  const { snapshot: watermarkSnapshot } = useLiveWatermark(
    watermarkPolicy('warm'),
  );
  const [storage, setStorage] = useState<StorageEstimate | null>(null);
  const [storageError, setStorageError] = useState<boolean>(false);
  // Collapsed by default — operators usually open the drawer to inspect
  // failure events first; the chain panel is a "click to peek" affordance
  // so it doesn't push the events list below the fold on first open.
  const [expanded, setExpanded] = useState<boolean>(false);
  // Purge state — only used when `mode === 'advanced'` (the dev / debug
  // toggle on the user-mode picker). Tri-state UI:
  //   - 'idle': default, button enabled.
  //   - 'purging': disable while async work runs.
  //   - 'done' / 'failed': inline message; revert to 'idle' on next click.
  const [purgeState, setPurgeState] = useState<
    'idle' | 'purging' | 'done' | 'failed'
  >('idle');
  const [purgeMessage, setPurgeMessage] = useState<string | null>(null);

  useEffect(() => {
    // navigator.storage.estimate() is widely supported but absent in
    // some Safari/iOS contexts and in private-mode profiles; treat its
    // absence as "API unavailable" rather than swallowing silently.
    if (
      typeof navigator !== 'undefined' &&
      navigator.storage &&
      typeof navigator.storage.estimate === 'function'
    ) {
      navigator.storage
        .estimate()
        .then((est) => setStorage({ usage: est.usage, quota: est.quota }))
        .catch(() => setStorageError(true));
    } else {
      setStorageError(true);
    }
  }, []);

  // Build identifier — plumbed in via Vite at build time. The
  // `vite.config.ts` execSyncs `git rev-parse --short HEAD` and
  // assigns `process.env.VITE_BUILD_HASH` before defineConfig runs, so
  // this read sees a real short SHA in built bundles. In `npm run dev`
  // the same path runs (vite re-evaluates the config on dev start)
  // so the dev page shows the local working-tree HEAD.
  const buildHash =
    (import.meta.env.VITE_BUILD_HASH as string | undefined) ?? null;
  const buildTime =
    (import.meta.env.VITE_BUILD_TIME as string | undefined) ?? null;

  // Advanced-mode-only client-state purge. Clears IndexedDB databases,
  // localStorage, and sessionStorage so the next load is a true cold
  // start. Useful when:
  //   - the cached offer/loan rows in IndexedDB get into a weird shape
  //     after a contract redeploy (stale ABI decode, etc.);
  //   - a wallet auth handshake gets stuck and the user needs to reset
  //     all client state without nuking the entire browser profile.
  // Gated on `mode === 'advanced'` so the average user can't trip it
  // by accident — connecting wallets / settings / preferences all live
  // in localStorage and would be wiped.
  async function handlePurge() {
    if (purgeState === 'purging') return;
    // Confirm because this is destructive — wipes wallet-connect
    // handshake, dApp settings, every cached row.
    const confirmed = window.confirm(
      t('chainDiagnostics.purgeConfirm', {
        defaultValue:
          'Purge all browser-side state for this site (IndexedDB, localStorage, sessionStorage)? Connected wallets and saved preferences will be cleared. The page will need a reload.',
      }),
    );
    if (!confirmed) return;
    setPurgeState('purging');
    setPurgeMessage(null);
    try {
      // IndexedDB — `databases()` is widely supported (Firefox 126+,
      // Safari 16+, every Chromium). On the rare browser without it,
      // we silently skip; localStorage clear below is the more
      // important reset path anyway.
      if (
        typeof indexedDB !== 'undefined' &&
        typeof (indexedDB as unknown as { databases?: unknown }).databases ===
          'function'
      ) {
        const dbs = await indexedDB.databases();
        for (const db of dbs) {
          if (db.name) indexedDB.deleteDatabase(db.name);
        }
      }
      try { localStorage.clear(); } catch { /* private mode safari */ }
      try { sessionStorage.clear(); } catch { /* same */ }
      setPurgeState('done');
      setPurgeMessage(
        t('chainDiagnostics.purgeDone', {
          defaultValue: 'Purged. Reload the page to take effect.',
        }),
      );
    } catch (err) {
      setPurgeState('failed');
      setPurgeMessage(
        t('chainDiagnostics.purgeFailed', {
          defaultValue: 'Purge failed: {{err}}',
          err: String(err).slice(0, 120),
        }),
      );
    }
  }
  const apiOrigin =
    (import.meta.env.VITE_API_ORIGIN as string | undefined) ?? null;

  const chainLabel = chain.name
    ? `${chain.name} (${chain.chainId})`
    : `chainId ${chain.chainId}`;
  const isLocalDev =
    chain.chainId === 31337 || chain.chainId === 1337;
  const indexer = stats?.indexer ?? null;

  // Resolve which i18n heading + body to render. Three macro-states:
  //   localDev | live (cache unreachable) | indexer-state (caught-up /
  //   catching-up / behind based on block gap)
  let heading: string;
  let body: string;
  let stateLabel: string;
  let stateClass: string;
  let blockGap: number | null = null;

  if (isLocalDev) {
    heading = t('indexerBadge.localDevHeading');
    body = t('indexerBadge.localDevBody');
    stateLabel = t('indexerBadge.localDev');
    stateClass = 'chain-diag-state--localdev';
  } else if (!indexer) {
    heading = t('indexerBadge.liveHeading');
    body = t('indexerBadge.liveBody');
    stateLabel = t('indexerBadge.live');
    stateClass = 'chain-diag-state--catching-up';
  } else {
    const safeBlockNum =
      watermarkSnapshot && watermarkSnapshot.safeBlock > 0n
        ? Number(watermarkSnapshot.safeBlock)
        : null;
    blockGap =
      safeBlockNum !== null
        ? Math.max(0, safeBlockNum - indexer.lastBlock)
        : 0;
    if (blockGap >= SEVERE_GAP_BLOCKS) {
      heading = t('indexerBadge.behindHeading');
      body = t('indexerBadge.behindBody');
      stateLabel = t('indexerBadge.behindState');
      stateClass = 'chain-diag-state--behind';
    } else if (blockGap >= CAUGHT_UP_GAP_BLOCKS) {
      heading = t('indexerBadge.catchingUpHeading');
      body = t('indexerBadge.catchingUpBody');
      stateLabel = t('indexerBadge.catchingUpState');
      stateClass = 'chain-diag-state--catching-up';
    } else {
      heading = t('indexerBadge.caughtUpHeading');
      body = t('indexerBadge.caughtUpBody');
      stateLabel = t('indexerBadge.caughtUp');
      stateClass = 'chain-diag-state--caught-up';
    }
  }

  const safeHeadValue =
    watermarkSnapshot && watermarkSnapshot.safeBlock > 0n
      ? Number(watermarkSnapshot.safeBlock).toLocaleString()
      : t('indexerBadge.statusChainSafeHeadUnknown');

  const cursorIso = indexer
    ? new Date(indexer.updatedAt * 1000).toISOString()
    : null;

  const storageRowValue = storageError
    ? t('chainDiagnostics.localStorageUnavailable', {
        defaultValue: 'Storage API unavailable',
      })
    : storage
    ? `${formatBytes(storage.usage)} / ${formatBytes(storage.quota)}`
    : '…';

  return (
    <section
      className="chain-diag-panel"
      id="chain-diagnostics-panel"
      aria-labelledby="chain-diag-heading"
    >
      {/* Collapsed-by-default header. Clicking the whole row toggles —
          larger hit target for muscle-memory than a tight chevron-only
          target. State pill stays visible whether expanded or not so
          the operator gets the at-a-glance signal even when collapsed. */}
      <button
        type="button"
        className="chain-diag-header"
        aria-expanded={expanded}
        aria-controls="chain-diag-body-region"
        onClick={() => setExpanded((v) => !v)}
      >
        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <h4 id="chain-diag-heading" className="chain-diag-title">
          {t('chainDiagnostics.panelTitle', {
            defaultValue: 'Chain & Indexer',
          })}
        </h4>
        <span className={`chain-diag-state-pill ${stateClass}`}>
          {stateLabel}
        </span>
      </button>
      {expanded && (
      <div id="chain-diag-body-region">
      <div className={`chain-diag-state-line ${stateClass}`}>
        <span className="chain-diag-state-heading">{heading}</span>
      </div>
      <p className="chain-diag-body">{body}</p>
      <dl className="chain-diag-rows">
        <Row
          label={t('indexerBadge.statusChain', { defaultValue: 'Chain' })}
          value={chainLabel}
        />
        {indexer && (
          <Row
            label={t('indexerBadge.statusLastSafeBlock', {
              defaultValue: 'Last safe block (indexed)',
            })}
            value={indexer.lastBlock.toLocaleString()}
          />
        )}
        {!isLocalDev && (
          <Row
            label={t('indexerBadge.statusChainSafeHead', {
              defaultValue: 'Chain safe head',
            })}
            value={safeHeadValue}
          />
        )}
        {indexer && blockGap !== null && (
          <Row
            label={t('indexerBadge.statusBlockGap', {
              defaultValue: 'Blocks to catch up',
            })}
            value={
              blockGap < CAUGHT_UP_GAP_BLOCKS
                ? t('indexerBadge.statusBlockGapCaughtUp', {
                    defaultValue: '0 (caught up)',
                  })
                : blockGap.toLocaleString()
            }
          />
        )}
        {cursorIso && (
          <Row
            label={t('chainDiagnostics.cursorAdvancedAt', {
              defaultValue: 'Indexer cursor last advanced (UTC)',
            })}
            value={cursorIso}
          />
        )}
        <Row
          label={t('indexerBadge.statusSource', { defaultValue: 'Data source' })}
          value={
            isLocalDev
              ? t('indexerBadge.statusSourceLocalRpc', {
                  defaultValue: 'Local RPC (direct)',
                })
              : indexer
              ? t('indexerBadge.statusSourceCache', {
                  defaultValue: 'Indexer cache + RPC live tail',
                })
              : t('indexerBadge.statusSourceRpc', {
                  defaultValue: 'RPC (cache unreachable)',
                })
          }
        />
        {apiOrigin && !isLocalDev && (
          <Row
            label={t('chainDiagnostics.cacheOrigin', {
              defaultValue: 'Indexer endpoint',
            })}
            value={apiOrigin}
          />
        )}
        <Row
          label={t('chainDiagnostics.localStorageUsage', {
            defaultValue: 'Browser storage (used / quota)',
          })}
          value={storageRowValue}
        />
        <Row
          label={t('chainDiagnostics.frontendBuild', {
            defaultValue: 'Frontend build',
          })}
          value={
            buildHash ??
            t('chainDiagnostics.frontendBuildUnknown', {
              defaultValue: 'unknown',
            })
          }
        />
        {buildTime && (
          <Row
            label={t('chainDiagnostics.frontendBuildTime', {
              defaultValue: 'Frontend built (UTC)',
            })}
            value={buildTime}
          />
        )}
      </dl>
      {/* Advanced-mode-only client-state purge. The Trash2 / red text
          colour mirrors the journey-buffer `Delete` button below for
          consistency. Hidden in basic mode so the average user can't
          accidentally wipe their wallet-connect handshake. */}
      {mode === 'advanced' && (
        <div className="chain-diag-purge">
          <button
            type="button"
            className="btn btn-ghost btn-sm chain-diag-purge-btn"
            onClick={handlePurge}
            disabled={purgeState === 'purging'}
          >
            <Trash2 size={14} />
            {purgeState === 'purging'
              ? t('chainDiagnostics.purgeInProgress', {
                  defaultValue: 'Purging…',
                })
              : t('chainDiagnostics.purgeButton', {
                  defaultValue: 'Purge browser-side state',
                })}
          </button>
          {purgeMessage && (
            <span
              className={
                purgeState === 'failed'
                  ? 'chain-diag-purge-msg chain-diag-purge-msg--err'
                  : 'chain-diag-purge-msg'
              }
            >
              {purgeMessage}
            </span>
          )}
        </div>
      )}
      <p className="chain-diag-footnote">
        {t('indexerBadge.safeBlockFootnote')}
      </p>
      </div>
      )}
    </section>
  );
}

interface RowProps {
  label: string;
  value: string;
}

function Row({ label, value }: RowProps) {
  return (
    <div className="chain-diag-row">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
