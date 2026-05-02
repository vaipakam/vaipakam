/**
 * T-041 / T-047 — top-bar status badge surfacing the indexer cache
 * state, with an info icon (ⓘ) that opens a plain-English popover
 * explaining what each state means. Three states:
 *
 *   - **Cached (green)**: the worker is up and the indexer cursor
 *     is fresh. The page is reading from the cache; "Indexed N min
 *     ago" tells the user how stale the snapshot is. Click Rescan
 *     to force a fresh on-chain scan from the browser.
 *
 *   - **Live (amber)**: the indexer endpoint is unreachable / not
 *     configured / the chain isn't covered by the cache. The browser
 *     reads directly from the RPC, which is slower per page load
 *     but always authoritative. The popover asks the user to wait
 *     for all rows to render before submitting transactions — partial
 *     renders during a slow scan can mislead a tx that depends on
 *     "what's currently shown."
 *
 *   - **Local dev (blue)**: the wallet is connected to a local Anvil
 *     / Foundry node (chainId 31337). The cloud worker by definition
 *     can't reach a local dev node, so the badge is permanently in
 *     a "no indexer" state when developing — surfacing it as a
 *     distinct color + label avoids the confusion of a permanent
 *     amber warning during normal dev work.
 *
 * Lives in the in-app top bar so it's visible on every page (T-047),
 * removing the need for per-page badge instances.
 */

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Info, RefreshCw, Wifi, WifiOff, Cpu } from 'lucide-react';
import { useOfferStats } from '../../hooks/useOfferStats';
import { useReadChain } from '../../contracts/useDiamond';
import './IndexerStatusBadge.css';

interface Props {
  /** Optional: custom rescan callback. Defaults to a full page
   *  reload, which forces every hook to re-pull state. */
  onRescan?: () => void;
  /** Compact: hide the "ago" suffix on narrow viewports. */
  compact?: boolean;
}

/** Local development chain ids — Anvil / Foundry / Hardhat default
 *  to 31337. Detected so we can show a distinct "local dev" pill
 *  instead of a permanent amber "live chain scan" warning during
 *  normal dev work. */
const LOCAL_DEV_CHAIN_IDS: ReadonlySet<number> = new Set([31337, 1337]);

export function IndexerStatusBadge({ onRescan, compact }: Props) {
  const { t } = useTranslation();
  const { stats } = useOfferStats();
  const chain = useReadChain();
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const [infoOpen, setInfoOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement | null>(null);

  // Tick once per minute so the "X min ago" label refreshes without
  // re-fetching from the worker.
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 60_000);
    return () => clearInterval(id);
  }, []);

  // Click-outside / Escape close the info popover.
  useEffect(() => {
    if (!infoOpen) return;
    function onPointerDown(e: PointerEvent) {
      if (wrapRef.current?.contains(e.target as Node)) return;
      setInfoOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setInfoOpen(false);
    }
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [infoOpen]);

  const handleRescan = () => {
    if (onRescan) onRescan();
    else window.location.reload();
  };

  const isLocalDev =
    chain.chainId !== undefined && LOCAL_DEV_CHAIN_IDS.has(chain.chainId);

  // ── Local dev (Anvil / Hardhat) ──────────────────────────────────
  if (isLocalDev) {
    return (
      <span className="indexer-badge indexer-badge--localdev" ref={wrapRef}>
        <Cpu size={12} />
        {!compact && (
          <span>
            {t('indexerBadge.localDev', { defaultValue: 'Local dev chain' })}
          </span>
        )}
        <InfoButton
          open={infoOpen}
          onToggle={() => setInfoOpen((o) => !o)}
          title={t('indexerBadge.infoTitle', {
            defaultValue: 'What does this mean?',
          })}
        />
        {infoOpen && (
          <InfoPopover
            heading={t('indexerBadge.localDevHeading', {
              defaultValue: 'Local development chain',
            })}
            body={t('indexerBadge.localDevBody', {
              defaultValue:
                'Your wallet is connected to a local Anvil or Hardhat node (chain id 31337). The cloud indexer can\'t reach local dev nodes, so the page reads directly from your local RPC. This is normal during development — no action needed.',
            })}
          />
        )}
      </span>
    );
  }

  // ── Worker unreachable / no cache yet ────────────────────────────
  if (!stats || !stats.indexer) {
    return (
      <span className="indexer-badge indexer-badge--live" ref={wrapRef}>
        <WifiOff size={12} />
        {!compact && (
          <span>
            {t('indexerBadge.live', { defaultValue: 'Live chain scan' })}
          </span>
        )}
        <InfoButton
          open={infoOpen}
          onToggle={() => setInfoOpen((o) => !o)}
          title={t('indexerBadge.infoTitle', {
            defaultValue: 'What does this mean?',
          })}
        />
        {infoOpen && (
          <InfoPopover
            heading={t('indexerBadge.liveHeading', {
              defaultValue: 'Reading directly from the chain',
            })}
            body={t('indexerBadge.liveBody', {
              defaultValue:
                'The indexer cache is unreachable, so your browser is fetching every offer / loan / activity row directly from the chain. The data is always authoritative, but pages take longer to load. Please wait for the page to finish loading before submitting any transaction — a tx that depends on data still being fetched might act on a partial view.',
            })}
          />
        )}
      </span>
    );
  }

  // ── Cache fresh ──────────────────────────────────────────────────
  const ageSec = Math.max(0, now - stats.indexer.updatedAt);
  const label =
    ageSec < 60
      ? t('indexerBadge.justNow', { defaultValue: 'just now' })
      : ageSec < 3600
      ? t('indexerBadge.minutes', {
          defaultValue: '{{min}} min ago',
          min: Math.floor(ageSec / 60),
        })
      : t('indexerBadge.hours', {
          defaultValue: '{{h}}h ago',
          h: Math.floor(ageSec / 3600),
        });

  return (
    <span className="indexer-badge indexer-badge--cached" ref={wrapRef}>
      <Wifi size={12} />
      {!compact && (
        <span>
          {t('indexerBadge.indexed', { defaultValue: 'Indexed' })} {label}
        </span>
      )}
      <button
        type="button"
        className="indexer-badge-rescan"
        onClick={handleRescan}
        title={t('indexerBadge.rescanTooltip', {
          defaultValue:
            'Force a fresh on-chain scan from your browser. Bypasses the cache.',
        })}
      >
        <RefreshCw size={12} />
        {!compact && (
          <span>{t('indexerBadge.rescan', { defaultValue: 'Rescan' })}</span>
        )}
      </button>
      <InfoButton
        open={infoOpen}
        onToggle={() => setInfoOpen((o) => !o)}
        title={t('indexerBadge.infoTitle', {
          defaultValue: 'What does this mean?',
        })}
      />
      {infoOpen && (
        <InfoPopover
          heading={t('indexerBadge.cachedHeading', {
            defaultValue: 'Reading from the indexer cache',
          })}
          body={t('indexerBadge.cachedBody', {
            defaultValue:
              'A backend worker indexes the chain every few minutes and caches every offer, loan, and activity event. The page reads from that cache for fast first-paint. The "Indexed N min ago" label is the cache age; click "Rescan" if you want to bypass the cache and re-read directly from the chain. Submitting transactions while green is safe — the page reflects on-chain state as of the cache age.',
          })}
        />
      )}
    </span>
  );
}

interface InfoButtonProps {
  open: boolean;
  onToggle: () => void;
  title: string;
}

function InfoButton({ open, onToggle, title }: InfoButtonProps) {
  return (
    <button
      type="button"
      className="indexer-badge-info"
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      aria-expanded={open}
      title={title}
    >
      <Info size={12} />
    </button>
  );
}

interface InfoPopoverProps {
  heading: string;
  body: string;
}

function InfoPopover({ heading, body }: InfoPopoverProps) {
  return (
    <div className="indexer-badge-popover" role="dialog">
      <div className="indexer-badge-popover-heading">{heading}</div>
      <div className="indexer-badge-popover-body">{body}</div>
    </div>
  );
}
