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

import { useTranslation } from 'react-i18next';
import { Link, Navigate } from 'react-router-dom';
import Navbar from '../components/Navbar';
import Footer from '../components/Footer';
import {
  KNOB_CATEGORY_LABELS,
  KNOB_CATEGORY_ORDER,
  knobsByCategory,
} from '../lib/adminKnobsZones';
import { isAdminDashboardPublic } from '../lib/adminVisibility';
import { useAdminKnobValues } from '../hooks/useAdminKnobValues';
import { KnobCard } from '../components/admin/KnobCard';

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

  return (
    <div className="public-page">
      <Navbar />
      <main style={{ maxWidth: 1200, margin: '0 auto', padding: '24px 16px' }}>
        <header style={{ marginBottom: 24 }}>
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
        </header>

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
                  />
                ))}
              </div>
            </section>
          );
        })}
      </main>
      <Footer />
    </div>
  );
}

