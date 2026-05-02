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
import { Link } from 'react-router-dom';
import { Info } from 'lucide-react';
import Navbar from '../components/Navbar';
import Footer from '../components/Footer';
import {
  KNOB_CATEGORY_LABELS,
  KNOB_CATEGORY_ORDER,
  knobsByCategory,
  type KnobMeta,
} from '../lib/adminKnobsZones';

export default function AdminDashboard() {
  const { t, i18n } = useTranslation();
  const grouped = knobsByCategory();
  const lang = i18n.resolvedLanguage ?? 'en';
  const docsPath = lang === 'en' ? '/admin/docs' : `/${lang}/admin/docs`;

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
                  <KnobCardStub key={knob.id} knob={knob} docsBase={docsPath} />
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

/**
 * Placeholder knob card. Phase 2 replaces this with the live-data
 * variant + the segmented colored bar showing safe / mid / caution
 * zones. The Phase 1 stub renders the static metadata so the
 * dashboard route is testable and the per-category layout is real.
 */
function KnobCardStub({ knob, docsBase }: { knob: KnobMeta; docsBase: string }) {
  const infoHref = `${docsBase}#${knob.infoAnchor}`;
  return (
    <div
      className="card"
      style={{
        padding: 16,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        minHeight: 140,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
        <h3 style={{ fontSize: '1rem', margin: 0 }}>{knob.label}</h3>
        <a
          href={infoHref}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`More info about ${knob.label}`}
          style={{ color: 'var(--brand)', flexShrink: 0 }}
        >
          <Info size={16} />
        </a>
      </div>
      <p style={{ margin: 0, fontSize: '0.85rem', opacity: 0.85 }}>{knob.short}</p>
      <p style={{ margin: 0, fontSize: '0.78rem', opacity: 0.6 }}>
        Hard range: {knob.hardMin} – {knob.hardMax} ({knob.unit}) ·{' '}
        Safe zone: {knob.safeMin} – {knob.safeMax}
      </p>
      <p style={{ margin: 0, fontSize: '0.75rem', opacity: 0.5 }}>
        {knob.setter.facet}.{knob.setter.fn}
      </p>
    </div>
  );
}
