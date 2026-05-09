import { useTranslation } from 'react-i18next';
import { L as Link } from '../components/L';
import {
  Gift,
  TrendingUp,
  ShieldCheck,
  ArrowRight,
  Coins,
} from 'lucide-react';

/**
 * Public-route marketing page for VPFI (mounted at `/buy-vpfi`).
 *
 * Pure pitch — no wallet connection. The actual buy / stake / unstake
 * surfaces live inside the app at `/app/buy-vpfi` (wallet-gated like
 * every other in-app page). The CTA at the bottom opens that surface
 * in a new tab so a marketing-page visitor never has to navigate
 * back to read more.
 *
 * Three cards in the same order the dropdown lists actions:
 *   1. Tiered fee discount  — pitch for borrowers / lenders
 *   2. Staking yield        — pitch for anyone with VPFI sitting idle
 *   3. How it works         — concrete next steps
 *
 * Read-only protocol stats (TVL / circulating supply / etc.) live on
 * the public Analytics page — keeping that out of here lets this
 * page stay pitch-focused without competing for attention.
 */
export default function BuyVPFIMarketing() {
  const { t } = useTranslation();
  return (
    <div className="buy-vpfi-marketing" style={{ maxWidth: 760, margin: '0 auto' }}>
      <div className="page-header">
        <h1 className="page-title">{t('buyVpfi.title')}</h1>
        <p className="page-subtitle">{t('buyVpfi.preconnect.tagline')}</p>
      </div>

      {/* "What is VPFI?" intro — first-time visitors clicking
          "Learn about VPFI" land here and need a plain-language
          explanation before the benefit cards make sense. Kept
          intentionally short and jargon-free; the technical token
          spec lives in the whitepaper, linked from the help menu. */}
      <div className="card" style={{ marginTop: 16 }}>
        <div
          className="card-title"
          style={{ display: 'flex', alignItems: 'center', gap: 8 }}
        >
          <Coins size={16} />
          {t('buyVpfi.preconnect.whatTitle')}
        </div>
        <p>{t('buyVpfi.preconnect.whatBody1')}</p>
        <p>{t('buyVpfi.preconnect.whatBody2')}</p>
        <p style={{ marginBottom: 0, opacity: 0.85 }}>
          {t('buyVpfi.preconnect.whatBody3')}
        </p>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <div
          className="card-title"
          style={{ display: 'flex', alignItems: 'center', gap: 8 }}
        >
          <Gift size={16} />
          {t('buyVpfi.preconnect.discountTitle')}
        </div>
        <p>{t('buyVpfi.preconnect.discountBody')}</p>
        <ul style={{ margin: '8px 0 0 0', paddingLeft: 20 }}>
          <li>{t('buyVpfi.preconnect.discountBullet1')}</li>
          <li>{t('buyVpfi.preconnect.discountBullet2')}</li>
        </ul>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <div
          className="card-title"
          style={{ display: 'flex', alignItems: 'center', gap: 8 }}
        >
          <TrendingUp size={16} />
          {t('buyVpfi.preconnect.stakingTitle')}
        </div>
        <p>{t('buyVpfi.preconnect.stakingBody')}</p>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <div
          className="card-title"
          style={{ display: 'flex', alignItems: 'center', gap: 8 }}
        >
          <ShieldCheck size={16} />
          {t('buyVpfi.preconnect.howTitle')}
        </div>
        <p>{t('buyVpfi.preconnect.howBody')}</p>
        <p style={{ marginTop: 12, opacity: 0.75, fontSize: '0.85rem' }}>
          {t('buyVpfi.preconnect.analyticsHint')}{' '}
          <Link to="/analytics" style={{ color: 'var(--brand)' }}>
            {t('buyVpfi.preconnect.analyticsLink')}
          </Link>
          .
        </p>
      </div>

      {/* Launch-App CTA — opens the in-app `/app/buy-vpfi` surface in a
          new tab so the marketing page stays open behind. The new-tab
          behaviour matches the public Navbar's Launch App and the
          VPFI dropdown's Buy / Stake-Unstake action items, so users
          land on the same expectation regardless of entry point. */}
      <div style={{ marginTop: 32, textAlign: 'center' }}>
        <a
          href="/app/buy-vpfi#step-1"
          target="_blank"
          rel="noopener noreferrer"
          className="btn btn-primary btn-lg"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}
        >
          {t('buyVpfi.preconnect.launchAppCta')}
          <ArrowRight size={18} />
        </a>
        <p
          style={{
            marginTop: 12,
            fontSize: '0.78rem',
            opacity: 0.65,
          }}
        >
          {t('buyVpfi.preconnect.launchAppHint')}
        </p>
      </div>
    </div>
  );
}
