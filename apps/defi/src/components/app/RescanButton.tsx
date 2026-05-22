/**
 * Shared "Refresh / Rescan" button — one source of truth for the
 * affordance that previously had a hand-rolled, slightly-drifting copy
 * on the Dashboard, VaultAssets ("Your Vaipakam Vault"), OfferBook and
 * Activity pages.
 *
 * Wraps a `useRescanCooldown` result: clicking calls `cooldown.trigger()`
 * (which starts the adaptive spam-resistant cooldown) and then the
 * page-supplied `onRescan` (which re-fetches *that page's* data — the
 * only thing that legitimately differs per page). The three button
 * states come from the cooldown's `status`:
 *   - idle    → `<RefreshCw/> Refresh`
 *   - syncing → `<RefreshCw spin/> Refreshing… {N}s`   (N = seconds left)
 *   - synced  → `<Check/> {N}s`                        (cooldown still ticking)
 * plus the progress-bar fill via the `--rescan-progress` CSS var and
 * the `data-rescan-status` attribute the `.rescan-btn` styles read.
 *
 * `disabled` is an *extra* condition ANDed with the cooldown's own
 * (e.g. "no vault deployed yet", "a load is already in flight").
 */
import { type CSSProperties } from 'react';
import { Check, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { useRescanCooldown } from '../../hooks/useRescanCooldown';

interface RescanButtonProps {
  cooldown: ReturnType<typeof useRescanCooldown>;
  /** Re-fetch this page's data. `cooldown.trigger()` runs first,
   *  inside the button, so this is just the refetch side. */
  onRescan: () => void;
  /** Native `title` tooltip — the place to put page-specific detail
   *  ("Re-scan on-chain logs", etc.) since the label stays generic. */
  tooltip?: string;
  /** Extra disable condition, ANDed with `cooldown.disabled`. */
  disabled?: boolean;
}

export function RescanButton({ cooldown, onRescan, tooltip, disabled }: RescanButtonProps) {
  const { t } = useTranslation();
  const refreshLabel = t('common.refresh', { defaultValue: 'Refresh' });
  return (
    <button
      type="button"
      className="btn btn-secondary btn-sm rescan-btn"
      onClick={() => {
        cooldown.trigger();
        onRescan();
      }}
      disabled={cooldown.disabled || Boolean(disabled)}
      data-rescan-status={cooldown.status}
      style={{ '--rescan-progress': `${cooldown.remaining * 100}%` } as CSSProperties}
      aria-label={refreshLabel}
      title={tooltip}
    >
      {cooldown.status === 'syncing' ? (
        <>
          <RefreshCw size={14} className="spin" style={{ marginRight: 4 }} />
          {t('common.refreshing', { defaultValue: 'Refreshing… ' })}
          <span className="rescan-btn-secs">{cooldown.secondsRemaining}</span>
          {t('common.secondsSuffix', { defaultValue: 's' })}
        </>
      ) : cooldown.status === 'synced' ? (
        <>
          <Check size={14} style={{ marginRight: 4 }} />
          <span className="rescan-btn-secs">{cooldown.secondsRemaining}</span>
          {t('common.secondsSuffix', { defaultValue: 's' })}
        </>
      ) : (
        <>
          <RefreshCw size={14} style={{ marginRight: 4 }} />
          {refreshLabel}
        </>
      )}
    </button>
  );
}
