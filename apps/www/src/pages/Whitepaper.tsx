/**
 * /help/technical — the full Vaipakam Technical Whitepaper.
 *
 * Renders the technical whitepaper from
 * `apps/www/src/content/whitepaper/Whitepaper.<locale>.md`, resolved by the
 * same rule that decides which language copies are indexed
 * (`resolveBody`, #1314). Only the English file exists today: translation
 * drift on a technical specification is a worse failure mode than asking
 * non-English readers to use English here, and the legal-style "English
 * only" notice says so to them. A translation added later is served, and
 * indexed, by itself.
 *
 * Layout matches Overview: HelpTabs strip on top, sticky sidebar TOC
 * on desktop, accordion TOC on mobile. The TOC is derived from
 * the markdown's H2/H3 headings (the whitepaper uses numbered
 * sections like "## 11. VPFI Token and Tokenomics" → "### 11.1 Token
 * Parameters", so the TOC reads as a navigable spec outline).
 */

import { useMemo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import { remarkInlineAnchorToId } from '../lib/remarkInlineAnchorToId';
import remarkGfm from 'remark-gfm';
import Navbar from '../components/Navbar';
import Footer from '../components/Footer';
import { EnglishOnlyNotice } from '../components/EnglishOnlyNotice';
import { HelpTabs } from '../components/HelpTabs';
import { HelpToc } from '../components/HelpToc';
import {
  extractMarkdownToc,
  markdownComponents,
} from '../lib/markdownToc';
import { usePageMeta } from '../lib/usePageMeta';
import { resolveBody } from '../lib/indexedLocales';
import { useArticleJsonLd } from '../lib/useArticleJsonLd';
import './UserGuide.css';
import { useActiveLocale } from '../i18n/useActiveLocale';

const WHITEPAPER_FILES = import.meta.glob('../content/whitepaper/*.md', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>;


export default function Whitepaper() {
  const { i18n } = useTranslation();
  const location = useLocation();
  usePageMeta({
    titleKey: 'pageMeta.whitepaper.title',
    descriptionKey: 'pageMeta.whitepaper.description',
    bodyFiles: WHITEPAPER_FILES,
  });
  const lang = useActiveLocale();
  const body = useMemo(() => resolveBody('/help/technical', lang, WHITEPAPER_FILES), [lang]);
  const { text, fellBackToEnglish } = body;
  useArticleJsonLd({
    titleKey: 'pageMeta.whitepaper.title',
    descriptionKey: 'pageMeta.whitepaper.description',
    // Advertise the language of the markdown actually rendered.
    contentLanguage: body.locale,
  });
  const toc = useMemo(() => extractMarkdownToc(text), [text]);
  const basePath = location.pathname.replace(/\/$/, '');

  const collapseEnclosingDetails = (e: React.MouseEvent<HTMLAnchorElement>) => {
    const details = e.currentTarget.closest('details');
    if (details) details.removeAttribute('open');
  };

  // The language of the body actually rendered, not the route's: an
  // English body on a locale-prefixed URL must format as English
  // (#1610 review r5 — the UI locale rendered German grouping inside
  // English prose).
  const headingComps = useMemo(() => markdownComponents(body.locale), [body.locale]);

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
            {fellBackToEnglish && <EnglishOnlyNotice variant="legal" />}
            {lang === 'en' && (
              <p>
                This page renders the canonical technical whitepaper. The repository root README
                is the GitHub-facing project overview; legacy section citations are mapped in
                docs/LegacyReadmeSectionMap.md.
              </p>
            )}
            <ReactMarkdown
              remarkPlugins={[remarkGfm, remarkInlineAnchorToId] as never}
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
