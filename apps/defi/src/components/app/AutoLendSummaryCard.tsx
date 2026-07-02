import { useTranslation } from 'react-i18next';
import { Repeat, ChevronRight } from 'lucide-react';
import type { Address } from 'viem';
import { L as Link } from '../L';
import { useLenderIntentsByOwner } from '../../hooks/useLenderIntentsByOwner';

interface Props {
  address: string | null | undefined;
}

/**
 * #878 — compact Dashboard entry point for the auto-lend surface, which now
 * lives on its own {@link AutoLend} page (`/auto-lend`).
 *
 * Replaces the full create-card + multi-intent list that used to sit on the
 * Dashboard: shows the wallet's standing-intent count and deep-links to the
 * page.
 *
 * Renders ONLY when the wallet actually holds at least one standing intent
 * (`total > 0`). This is deliberate (Codex #886 P2): `useLenderIntentsByOwner`
 * returns an empty NON-error result on chains where the intent facet set isn't
 * cut, so gating on `error` would still surface a live link into a page whose
 * cards all self-hide. A positive count instead guarantees the feature exists
 * on this chain and the wallet has something to manage. First-time discovery
 * (zero intents) is served by the Advanced nav's "Auto-lend" entry, not this
 * widget — matching #878's "compact summary, or nothing" acceptance option.
 *
 * The count is the wallet's TOTAL standing intents (active + paused), so the
 * label says "standing intents", never "active" (Codex #886 P2 — `total`
 * includes paused entries in the owner registry).
 */
export function AutoLendSummaryCard({ address }: Props) {
  const { t } = useTranslation();
  const { total } = useLenderIntentsByOwner(
    (address as Address | null) ?? null,
  );

  if (!address) return null;
  // Only surface once the wallet holds ≥1 standing intent — see the docstring
  // for why a count, not an error check, is the right feature gate here.
  if (total <= 0n) return null;

  const count = Number(total);

  return (
    <Link
      to="/auto-lend"
      className="card"
      style={{
        marginBottom: 20,
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        textDecoration: 'none',
        color: 'inherit',
      }}
    >
      <div
        aria-hidden="true"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 36,
          height: 36,
          borderRadius: 8,
          background: 'rgba(99, 102, 241, 0.1)',
          color: 'var(--brand, #6366f1)',
          flexShrink: 0,
        }}
      >
        <Repeat size={18} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600 }}>{t('autoLendSummary.title')}</div>
        <div style={{ fontSize: 13, color: 'var(--muted)' }}>
          {t('autoLendSummary.standing', { count })}
        </div>
      </div>
      <span
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          fontSize: 13,
          fontWeight: 600,
          color: 'var(--brand, #6366f1)',
          flexShrink: 0,
        }}
      >
        {t('autoLendSummary.manage')}
        <ChevronRight size={16} aria-hidden="true" />
      </span>
    </Link>
  );
}
