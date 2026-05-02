/**
 * /admin — Admin Configurable Knobs & Switches dashboard.
 *
 * Phase 1 stub: reads the curated knob catalogue from
 * `lib/adminKnobsZones.ts` and renders per-category sections with
 * placeholder cards. Subsequent phases wire:
 *   - Phase 2: live on-chain values + clean-theme cards.
 *   - Phase 3: cockpit-theme variant for admin wallets.
 *   - Phase 4: Safe deep-link composer + timelock proposal reader.
 *
 * Public read-only by design — anyone can see every protocol
 * parameter's current value and recommended operational range. Admin
 * actions (Phase 4) appear only when an admin / governance wallet
 * connects and explicitly opts into the cockpit overlay.
 *
 * Companion document: `docs/ops/AdminConfigurableKnobsAndSwitches.md`
 * (mirrored at `frontend/src/content/admin/`). Each knob card has an
 * info-icon that deep-links to the matching heading anchor in that
 * runbook so an auditor can read the full policy rationale alongside
 * the current value.
 */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, Navigate, useLocation } from 'react-router-dom';
import Navbar from '../components/Navbar';
import Footer from '../components/Footer';
import {
  KNOB_CATEGORY_LABELS,
  KNOB_CATEGORY_ORDER,
  knobsByCategory,
} from '../lib/adminKnobsZones';
import { isAdminDashboardPublic } from '../lib/adminVisibility';
import {
  type AdminThemeMode,
  persistAdminTheme,
  readPersistedAdminTheme,
  readUrlAdminTheme,
} from '../lib/adminTheme';
import { useIsAdminWallet } from '../lib/useIsAdminWallet';
import { useReadChain } from '../contracts/useDiamond';
import { useAdminKnobValues } from '../hooks/useAdminKnobValues';
import { useTimelockPendingChanges } from '../hooks/useTimelockPendingChanges';
import { KnobCard } from '../components/admin/KnobCard';
import { GraceBucketsCard } from '../components/admin/GraceBucketsCard';
import { AdminThemeToggle } from '../components/admin/AdminThemeToggle';
import '../components/admin/admin-theme.css';

export default function AdminDashboard() {
  const { t, i18n } = useTranslation();
  // T-042 Phase 1d — public-visibility gate. Phase 1 hard-redirects
  // when the env flag is off (no wallet-aware admin detection yet).
  // Phase 4 will refine this to "redirect unless admin wallet
  // connected" so signers can still reach the cockpit when the
  // public surface is hidden.
  if (!isAdminDashboardPublic()) {
    return <Navigate to="/" replace />;
  }
  const grouped = knobsByCategory();
  const lang = i18n.resolvedLanguage ?? 'en';
  const docsPath = lang === 'en' ? '/admin/docs' : `/${lang}/admin/docs`;
  const values = useAdminKnobValues();
  const isAdminWallet = useIsAdminWallet();
  const location = useLocation();
  const readChain = useReadChain();
  const pendingChanges = useTimelockPendingChanges();

  // Theme resolution: URL > localStorage > admin-wallet-auto > default.
  const [themeMode, setThemeMode] = useState<AdminThemeMode>(() => {
    const fromUrl = readUrlAdminTheme(location.search);
    if (fromUrl) return fromUrl;
    const persisted = readPersistedAdminTheme();
    if (persisted) return persisted;
    return isAdminWallet ? 'terminal' : 'public';
  });

  // Auto-engage terminal mode when an admin wallet connects (only
  // when the user hasn't already chosen a mode manually). Phase 3
  // ships with `useIsAdminWallet()` stubbed to false; Phase 4 wires
  // the real on-chain check + this auto-engage path becomes live.
  useEffect(() => {
    const persisted = readPersistedAdminTheme();
    const fromUrl = readUrlAdminTheme(location.search);
    if (persisted || fromUrl) return; // user override wins
    setThemeMode(isAdminWallet ? 'terminal' : 'public');
  }, [isAdminWallet, location.search]);

  const onToggle = () => {
    setThemeMode((prev) => {
      const next: AdminThemeMode = prev === 'public' ? 'terminal' : 'public';
      persistAdminTheme(next);
      return next;
    });
  };

  return (
    <div className="public-page">
      <Navbar />
      <main
        className="admin-dashboard-wrap"
        data-admin-theme={themeMode}
        style={{ maxWidth: 1200, margin: '0 auto', padding: '24px 16px' }}
      >
        <header
          style={{
            marginBottom: 24,
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'flex-start',
            gap: 12,
            flexWrap: 'wrap',
          }}
        >
          <div style={{ flex: '1 1 480px', minWidth: 280 }}>
            <h1 style={{ marginBottom: 8 }}>
              {t('adminDashboard.title', 'Admin Configurable Knobs & Switches')}
            </h1>
            <p style={{ opacity: 0.85, fontSize: '0.95rem', lineHeight: 1.5 }}>
              {t(
                'adminDashboard.subtitle',
                "Public read-only view of every governance-tunable protocol parameter. The current value, the contract's hard min/max, and the operational safe / mid / caution zones are surfaced here for transparency. Admin actions become available when an admin wallet connects.",
              )}
            </p>
            <p style={{ marginTop: 12, fontSize: '0.9rem', opacity: 0.75 }}>
              <Link to={docsPath} style={{ color: 'var(--brand)' }}>
                {t('adminDashboard.docsLink', 'Read the Knobs & Switches reference →')}
              </Link>
            </p>
          </div>
          <AdminThemeToggle mode={themeMode} onToggle={onToggle} />
        </header>

        {pendingChanges.all.length > 0 && (
          <div
            style={{
              border: '1px solid rgba(245,158,11,0.45)',
              background: 'rgba(245,158,11,0.08)',
              padding: '10px 14px',
              borderRadius: 4,
              fontSize: '0.85rem',
              marginBottom: 12,
              lineHeight: 1.5,
            }}
          >
            <strong>{pendingChanges.all.length} governance change{pendingChanges.all.length === 1 ? '' : 's'} queued in the timelock.</strong>{' '}
            {pendingChanges.all.filter((p) => p.ready).length > 0
              ? `${pendingChanges.all.filter((p) => p.ready).length} ready to execute now.`
              : 'All still in delay window.'}
            {' '}Affected parameters carry a "PENDING" badge below.
          </div>
        )}

        {isAdminWallet && (
          <div
            style={{
              border: '1px solid rgba(0,255,136,0.4)',
              background: 'rgba(0,255,136,0.08)',
              padding: '10px 14px',
              borderRadius: 4,
              fontSize: '0.85rem',
              marginBottom: 16,
              lineHeight: 1.5,
            }}
          >
            <strong>Admin role detected.</strong> Each card has a "Propose"
            button that composes the setter calldata and opens Safe with
            the transaction pre-filled. <em>You sign in Safe</em> — Vaipakam
            never signs on your behalf. Proposals also pass through the
            timelock delay before they take effect on-chain.
          </div>
        )}

        {KNOB_CATEGORY_ORDER.map((cat) => {
          const knobs = grouped[cat] ?? [];
          if (knobs.length === 0) return null;
          return (
            <section key={cat} style={{ marginBottom: 32 }}>
              <h2 style={{ borderBottom: '1px solid var(--border)', paddingBottom: 8 }}>
                {KNOB_CATEGORY_LABELS[cat]}
              </h2>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
                  gap: 16,
                  marginTop: 12,
                }}
              >
                {knobs.map((knob) => (
                  <KnobCard
                    key={knob.id}
                    knob={knob}
                    read={
                      values[knob.id] ?? {
                        value: null,
                        loading: true,
                      }
                    }
                    docsBase={docsPath}
                    canPropose={isAdminWallet}
                    diamondAddress={readChain.diamondAddress ?? undefined}
                    chainId={readChain.chainId}
                    pending={pendingChanges.byKnob[knob.id]}
                  />
                ))}
                {/* T-044 — array-shaped knob (loan-default grace
                    schedule) lives at the bottom of the Risk
                    section. Rendered as a bespoke card because the
                    fixed 6-slot table doesn't fit the scalar KnobMeta
                    shape every other knob shares. */}
                {cat === 'risk' && (
                  <div style={{ gridColumn: '1 / -1' }}>
                    <GraceBucketsCard
                      docsBase={docsPath}
                      canPropose={isAdminWallet}
                      diamondAddress={readChain.diamondAddress ?? undefined}
                      chainId={readChain.chainId}
                    />
                  </div>
                )}
              </div>
            </section>
          );
        })}
      </main>
      <Footer />
    </div>
  );
}

