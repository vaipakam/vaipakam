/**
 * /admin — Admin Configurable Knobs & Switches dashboard.
 *
 * Phase 1 stub: reads the curated knob catalogue from
 * `lib/protocolConsoleKnobs.ts` and renders per-category sections with
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

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, Navigate, useLocation } from 'react-router-dom';
import Navbar from '../components/Navbar';
import Footer from '../components/Footer';
import {
  KNOB_CATEGORY_LABELS,
  KNOB_CATEGORY_ORDER,
  knobsByCategory,
} from '../lib/protocolConsoleKnobs';
import { isProtocolConsolePublic } from '../lib/protocolConsoleVisibility';
import {
  type ProtocolConsoleThemeMode,
  persistConsoleTheme,
  readPersistedConsoleTheme,
  readUrlConsoleTheme,
} from '../lib/protocolConsoleTheme';
import { useIsProtocolAdmin } from '../lib/useIsProtocolAdmin';
import { useTheme } from '../context/ThemeContext';
import { useReadChain } from '../contracts/useDiamond';
import { useAdminKnobValues } from '../hooks/useAdminKnobValues';
import { useTimelockPendingChanges } from '../hooks/useTimelockPendingChanges';
import { KnobCard } from '../components/admin/KnobCard';
import { GraceBucketsCard } from '../components/admin/GraceBucketsCard';
import { AdminThemeToggle } from '../components/admin/AdminThemeToggle';
import '../components/admin/admin-theme.css';

interface Props {
  /** When true, render WITHOUT the public Navbar/Footer chrome — the
   *  page is being mounted inside `<AppLayout>`'s Outlet for an
   *  admin-only in-app variant. The route at `/app/protocol-console`
   *  passes `inApp` so admins can review / propose without losing the
   *  in-app sidebar context. The public route at `/protocol-console`
   *  passes nothing and gets the full Navbar + Footer wrapper. */
  inApp?: boolean;
}

export default function AdminDashboard({ inApp = false }: Props = {}) {
  const { t, i18n } = useTranslation();
  // T-042 Phase 1d — public-visibility gate. Phase 1 hard-redirects
  // when the env flag is off (no wallet-aware admin detection yet).
  // Phase 4 will refine this to "redirect unless admin wallet
  // connected" so signers can still reach the cockpit when the
  // public surface is hidden.
  if (!isProtocolConsolePublic()) {
    return <Navigate to="/" replace />;
  }
  const grouped = knobsByCategory();
  const lang = i18n.resolvedLanguage ?? 'en';
  const docsPath = lang === 'en' ? '/protocol-console/docs' : `/${lang}/protocol-console/docs`;
  const values = useAdminKnobValues();
  const isAdminWallet = useIsProtocolAdmin();
  const location = useLocation();
  const readChain = useReadChain();
  const pendingChanges = useTimelockPendingChanges();

  // Theme resolution: URL > localStorage > admin-wallet-auto > default.
  const [themeMode, setThemeMode] = useState<ProtocolConsoleThemeMode>(() => {
    const fromUrl = readUrlConsoleTheme(location.search);
    if (fromUrl) return fromUrl;
    const persisted = readPersistedConsoleTheme();
    if (persisted) return persisted;
    return isAdminWallet ? 'terminal' : 'public';
  });

  // Auto-engage terminal mode when a protocol-admin wallet connects
  // (only when the user hasn't already chosen a mode manually).
  useEffect(() => {
    const persisted = readPersistedConsoleTheme();
    const fromUrl = readUrlConsoleTheme(location.search);
    if (persisted || fromUrl) return; // user override wins
    setThemeMode(isAdminWallet ? 'terminal' : 'public');
  }, [isAdminWallet, location.search]);

  // Site-wide dark theme while mission-control view is engaged.
  // Forces every page (Navbar, Footer, sidebar, in-app shell — every
  // surface outside this component too) to render against dark CSS-
  // variable tokens so the cockpit aesthetic flows seamlessly with
  // its surroundings instead of looking like a dark island on a
  // light page. Cleared on:
  //   - mode toggle back to public view (effect re-runs with
  //     themeMode === 'public', applies `null`)
  //   - navigation away from the dashboard (effect cleanup runs and
  //     applies `null`, restoring the user's pre-cockpit theme)
  // The override is held in ThemeContext as a non-persistent state,
  // so closing the browser tab mid-mission-control doesn't lock the
  // user into dark on next visit.
  const { setThemeOverride, themeOverridden } = useTheme();
  useEffect(() => {
    if (themeMode === 'terminal') {
      setThemeOverride('dark');
      return () => setThemeOverride(null);
    }
    setThemeOverride(null);
  }, [themeMode, setThemeOverride]);

  // If the site-theme button clears the override while we still
  // think we're in terminal mode, follow it: flip the toggle pill
  // (and the persisted preference) back to public so the in-page
  // UI doesn't lie about which view is engaged. We track the prior
  // override state in a ref so the initial mount — when the effect
  // above hasn't engaged the override yet — doesn't trip this.
  const wasOverridden = useRef(false);
  useEffect(() => {
    if (wasOverridden.current && !themeOverridden && themeMode === 'terminal') {
      setThemeMode('public');
      persistConsoleTheme('public');
    }
    wasOverridden.current = themeOverridden;
  }, [themeOverridden, themeMode]);

  const onToggle = () => {
    setThemeMode((prev) => {
      const next: ProtocolConsoleThemeMode = prev === 'public' ? 'terminal' : 'public';
      persistConsoleTheme(next);
      return next;
    });
  };

  // Chrome differs between the public route and the in-app variant:
  //   - Public (`inApp=false`): wrap in `.public-page` + `<Navbar />` +
  //     `<Footer />`, with 104px top padding to clear the fixed navbar.
  //   - In-app (`inApp=true`): no Navbar/Footer (AppLayout owns the
  //     topbar + sidebar already), no top padding (AppLayout's content
  //     wrapper handles spacing).
  const wrapStyle: React.CSSProperties = inApp
    ? { maxWidth: 1200, margin: '0 auto', padding: '0' }
    : { maxWidth: 1200, margin: '0 auto', padding: '104px 16px 24px' };

  return (
    <div className={inApp ? '' : 'public-page'}>
      {!inApp && <Navbar />}
      <main
        className="admin-dashboard-wrap"
        data-admin-theme={themeMode}
        // First-paint robustness: stamp `data-theme="dark"` on the
        // wrapper immediately while in terminal mode, in case the
        // site-wide ThemeContext override (effect-based, runs after
        // render) hasn't applied yet on the very first frame. Once
        // the override engages it cascades to `<html>`, making this
        // attribute redundant (but harmless — same value). Public
        // view leaves it unset so the wrapper inherits site theme.
        data-theme={themeMode === 'terminal' ? 'dark' : undefined}
        style={wrapStyle}
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
              {t('protocolConsole.title', 'Protocol Console')}
            </h1>
            <p style={{ opacity: 0.85, fontSize: '0.95rem', lineHeight: 1.5 }}>
              {t(
                'protocolConsole.subtitle',
                "Public read-only view of every governance-tunable protocol parameter. The current value, the contract's hard min/max, and the operational safe / mid / caution zones are surfaced here for transparency. Protocol-admin actions become available when an admin wallet connects.",
              )}
            </p>
            <p style={{ marginTop: 12, fontSize: '0.9rem', opacity: 0.75 }}>
              {inApp ? (
                /* From inside the app shell, open the docs in a new
                 *  tab so the admin doesn't lose the in-app sidebar
                 *  context. The docs route mounts the public Navbar
                 *  + Footer wrapper. */
                <a
                  href={docsPath}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ color: 'var(--brand)' }}
                >
                  {t('protocolConsole.docsLink', 'Read the Knobs & Switches reference →')}
                </a>
              ) : (
                <Link to={docsPath} style={{ color: 'var(--brand)' }}>
                  {t('protocolConsole.docsLink', 'Read the Knobs & Switches reference →')}
                </Link>
              )}
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
            <strong>Protocol-admin role detected.</strong> Each card has a
            "Propose" button that composes the setter calldata and opens
            Safe with the transaction pre-filled. <em>You sign in Safe</em>
            — Vaipakam never signs on your behalf. Proposals also pass
            through the timelock delay before they take effect on-chain.
          </div>
        )}

        {KNOB_CATEGORY_ORDER.map((cat) => {
          // VPFIBuyReceiver knobs only have a target on canonical-VPFI
          // chains (Base / Base Sepolia). On every mirror chain the
          // receiver address is null and the read would fail with
          // `no-target` — hide those cards instead of surfacing the
          // confusing error to users who can't act on it from here
          // anyway (the receiver lives on a different chain).
          const knobs = (grouped[cat] ?? []).filter(
            (k) =>
              k.getter.facet !== 'VPFIBuyReceiver' ||
              readChain.isCanonicalVPFI === true,
          );
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
      {!inApp && <Footer />}
    </div>
  );
}

