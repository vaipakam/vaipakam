/**
 * /help/overview — friendly product tour.
 *
 * Renders the canonical Overview markdown from
 * `frontend/src/content/overview/Overview.<locale>.md`. Falls back to
 * the English source with a translation-pending notice when the
 * requested locale isn't available yet.
 *
 * Layout: HelpTabs strip on top, two-column grid with a sticky
 * sidebar TOC on desktop and a collapsible accordion TOC on mobile
 * (mirrors the User Guide's chrome for visual consistency).
 *
 * The TOC is derived from the markdown's H2/H3 headings via
 * `extractMarkdownToc` and the headings receive matching ids via
 * `headingComponents()` so anchor navigation works without an
 * explicit per-section anchor registry.
 */

import { useMemo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import Navbar from '../components/Navbar';
import Footer from '../components/Footer';
import { EnglishOnlyNotice } from '../components/app/EnglishOnlyNotice';
import { HelpTabs } from '../components/HelpTabs';
import { HelpToc } from '../components/HelpToc';
import {
  extractMarkdownToc,
  markdownComponents,
} from '../lib/markdownToc';
import './UserGuide.css';

const OVERVIEW_FILES = import.meta.glob('../content/overview/*.md', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>;

function resolveOverview(locale: string): {
  text: string;
  fellBackToEnglish: boolean;
} {
  const wanted = `../content/overview/Overview.${locale}.md`;
  const fallback = `../content/overview/Overview.en.md`;
  if (OVERVIEW_FILES[wanted]) {
    return { text: OVERVIEW_FILES[wanted], fellBackToEnglish: false };
  }
  return {
    text: OVERVIEW_FILES[fallback] ?? '',
    fellBackToEnglish: locale !== 'en',
  };
}

export default function Overview() {
  const { i18n } = useTranslation();
  const location = useLocation();
  const lang = i18n.resolvedLanguage ?? 'en';
  const { text, fellBackToEnglish } = useMemo(() => resolveOverview(lang), [lang]);
  const toc = useMemo(() => extractMarkdownToc(text), [text]);
  // Use the actual current pathname so locale-prefixed routes
  // (`/ta/help/overview`) and the unprefixed default route both
  // produce TOC hrefs that don't accidentally drop the locale.
  const basePath = location.pathname.replace(/\/$/, '');

  // Same accordion-collapse handler the User Guide uses, applied to
  // the mobile TOC details element so the section list folds away
  // after a tap.
  const collapseEnclosingDetails = (e: React.MouseEvent<HTMLAnchorElement>) => {
    const details = e.currentTarget.closest('details');
    if (details) details.removeAttribute('open');
  };

  const headingComps = useMemo(() => markdownComponents(), []);

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
            {fellBackToEnglish && <EnglishOnlyNotice variant="guide" />}
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
