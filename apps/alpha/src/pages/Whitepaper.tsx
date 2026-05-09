/**
 * /help/technical — the full Vaipakam Technical Whitepaper.
 *
 * Renders the canonical English whitepaper from
 * `frontend/src/content/whitepaper/Whitepaper.en.md`. The whitepaper
 * is intentionally **not translated** — translation drift on a
 * technical specification is a worse failure mode than asking
 * non-English readers to use English here. The legal-style "English
 * only" notice surfaces this clearly to non-English visitors.
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

const WHITEPAPER_FILES = import.meta.glob('../content/whitepaper/*.md', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>;

function resolveWhitepaper(): string {
  return WHITEPAPER_FILES['../content/whitepaper/Whitepaper.en.md'] ?? '';
}

export default function Whitepaper() {
  const { i18n } = useTranslation();
  const location = useLocation();
  const text = useMemo(() => resolveWhitepaper(), []);
  const toc = useMemo(() => extractMarkdownToc(text), [text]);
  const basePath = location.pathname.replace(/\/$/, '');
  const isNonEnglish = (i18n.resolvedLanguage ?? 'en') !== 'en';

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
