/**
 * /admin/docs — Admin Configurable Knobs & Switches reference.
 *
 * Renders `frontend/src/content/admin/AdminConfigurableKnobsAndSwitches.en.md`
 * (mirrored from `docs/ops/AdminConfigurableKnobsAndSwitches.md` via
 * `contracts/script/sync-admin-knobs-doc.sh`). English-only on
 * purpose — same translation policy as the Whitepaper, since the
 * runbook is auditor-facing technical copy where translation drift
 * would harm more than it would help.
 *
 * Each knob's heading uses an H3 with a slug-derived `id` so the
 * dashboard's info-icon can deep-link directly (`/admin/docs#staking-apr`).
 * The slug helper lives in `lib/markdownToc.tsx` and is the same one
 * used by the Whitepaper / Overview / User Guide pages.
 */

import { useMemo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, Navigate } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import { isProtocolConsolePublic } from '../lib/protocolConsoleVisibility';
import remarkGfm from 'remark-gfm';
import Navbar from '../components/Navbar';
import Footer from '../components/Footer';
import { EnglishOnlyNotice } from '../components/app/EnglishOnlyNotice';
import { HelpToc } from '../components/HelpToc';
import { HelpTabs } from '../components/HelpTabs';
import { extractMarkdownToc, markdownComponents } from '../lib/markdownToc';
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
  // Same visibility gate as the dashboard route. Hide the prose
  // reference when the parameter values themselves are hidden.
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
