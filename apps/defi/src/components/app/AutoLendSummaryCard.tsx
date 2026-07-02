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
 * Dashboard. Shows the wallet's active-intent count (or a "set up" prompt at
 * zero) and deep-links to the page. The zero-state CTA is deliberate: auto-lend
 * sits in the Advanced nav group, so this widget is how a Basic-mode lender
 * discovers the feature.
 *
 * Self-hides when there's no connected wallet or the per-owner intent read
 * errors (e.g. the intent/auto-lend facet set isn't cut on the current chain) —
 * so it never renders a link into a page that can't function here.
 */
export function AutoLendSummaryCard({ address }: Props) {
  const { t } = useTranslation();
  const { total, loading, error } = useLenderIntentsByOwner(
    (address as Address | null) ?? null,
  );

  if (!address) return null;
  // Facet not cut on this chain (or read failed) — hide rather than link into a
  // page whose cards would all self-hide.
  if (error) return null;
  // Avoid a flash before the first read resolves.
  if (loading && total === 0n) return null;

  const count = Number(total);
  const hasIntents = count > 0;

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
          {hasIntents
            ? t('autoLendSummary.active', { count })
            : t('autoLendSummary.setupPrompt')}
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
        {hasIntents
          ? t('autoLendSummary.manage')
          : t('autoLendSummary.setup')}
        <ChevronRight size={16} aria-hidden="true" />
      </span>
    </Link>
  );
}
