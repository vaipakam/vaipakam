/**
 * /protocol-console/docs — Admin Configurable Knobs & Switches
 * reference. Renders
 * `apps/www/src/content/admin/AdminConfigurableKnobsAndSwitches.en.md`
 * (mirrored from `docs/ops/AdminConfigurableKnobsAndSwitches.md` via
 * `contracts/script/sync-admin-knobs-doc.sh`). English-only on
 * purpose — same translation policy as the Whitepaper, since the
 * runbook is auditor-facing technical copy where translation drift
 * would harm more than it would help.
 *
 * Each knob's heading uses an H3 with a slug-derived `id` so the
 * defi-side dashboard's info-icons can deep-link directly
 * (`https://vaipakam.com/protocol-console/docs#staking-apr`). The
 * slug helper lives in `lib/markdownToc.tsx` and is the same one
 * used by the Whitepaper / Overview / User Guide pages.
 *
 * Lives on the marketing site (this app) rather than the
 * connected-app surface because:
 *   - The docs are pure public-read content; no wallet, no API.
 *     The marketing site is the natural home for public-read
 *     explainer pages (Whitepaper / Overview / User Guide all
 *     live here).
 *   - The canonical public URL `https://vaipakam.com/protocol-
 *     console/docs` lines up with SEO best practice (marketing
 *     apex hosts the indexable content; the `defi.` subdomain
 *     is for interactive flows).
 *   - The connected-app `/protocol-console` dashboard's info-icons
 *     deep-link here via the `marketingUrl()` helper in apps/defi,
 *     so the two surfaces stay loosely coupled.
 */

import { useMemo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { usePageMeta } from '../lib/usePageMeta';
import { useLocation, Navigate } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import Navbar from '../components/Navbar';
import Footer from '../components/Footer';
import { EnglishOnlyNotice } from '../components/EnglishOnlyNotice';
import { HelpToc } from '../components/HelpToc';
import { HelpTabs } from '../components/HelpTabs';
import { extractMarkdownToc, markdownComponents } from '../lib/markdownToc';
import { isProtocolConsolePublic } from '../lib/protocolConsoleVisibility';
import './UserGuide.css';

const ADMIN_DOC_FILES = import.meta.glob('../content/admin/*.md', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>;

function resolveAdminDoc(): string {
  return (
    ADMIN_DOC_FILES['../content/admin/AdminConfigurableKnobsAndSwitches.en.md'] ?? ''
  );
}

export default function AdminKnobsDocs() {
  const { i18n } = useTranslation();
  const location = useLocation();
  // Per-route SEO meta — this route is in the sitemap/prerender set
  // (scripts/seo-routes.mjs, same env gate), so it needs its own
  // title/description/canonical like every other advertised page.
  // Called before the visibility gate below: hooks must run
  // unconditionally, and on the hidden-console redirect the target
  // route's own meta immediately overwrites this.
  usePageMeta({
    titleKey: 'pageMeta.adminKnobs.title',
    descriptionKey: 'pageMeta.adminKnobs.description',
  });
  // Same visibility gate as the defi-side dashboard route. Hide
  // the prose reference when the parameter values themselves are
  // hidden — the env flag VITE_ADMIN_DASHBOARD_PUBLIC must be set
  // identically on both Workers for the gates to stay in sync.
  if (!isProtocolConsolePublic()) {
    return <Navigate to="/" replace />;
  }
  const text = useMemo(() => resolveAdminDoc(), []);
  const toc = useMemo(() => extractMarkdownToc(text), [text]);
  const basePath = location.pathname.replace(/\/$/, '');
  const isNonEnglish = (i18n.resolvedLanguage ?? 'en') !== 'en';
  const headingComps = useMemo(() => markdownComponents(), []);

  const collapseEnclosingDetails = (e: React.MouseEvent<HTMLAnchorElement>) => {
    const details = e.currentTarget.closest('details');
    if (details) details.removeAttribute('open');
  };

  return (
    <div className="user-guide-page">
      <Navbar />
      <main className="user-guide-main">
        <div className="user-guide-layout">
          <div className="user-guide-sticky-mobile">
            <details className="user-guide-toc-mobile">
              <summary>Sections</summary>
              <div className="user-guide-toc-mobile-body">
                <HelpToc toc={toc} basePath={basePath} onItemClick={collapseEnclosingDetails} />
              </div>
            </details>
          </div>

          <aside className="user-guide-sidebar-desktop">
            <HelpToc toc={toc} basePath={basePath} />
          </aside>

          <article className="user-guide-content">
            <HelpTabs />
            {isNonEnglish && <EnglishOnlyNotice variant="legal" />}
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={headingComps as never}
            >
              {text as ReactNode as string}
            </ReactMarkdown>
          </article>
        </div>
      </main>
      <Footer />
    </div>
  );
}
