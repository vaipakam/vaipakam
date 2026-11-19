/**
 * #3770 / #3772 — the site's short guides: one markdown body per guide,
 * English today, rendered like the other help pages.
 *
 *   /help/shared-accounts      shared accounts with a contract wallet (#3770)
 *   /help/run-your-own-agent   keepers and the reference keeper (#3772)
 *
 * The body and its indexing follow `bodySources.json` like every help page,
 * so a translation added later (`<Name>.<locale>.md` beside the English) is
 * served, advertised and prerendered without a change here (#1314).
 */
import { useMemo, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import Navbar from '../components/Navbar';
import Footer from '../components/Footer';
import { EnglishOnlyNotice } from '../components/EnglishOnlyNotice';
import { HelpToc } from '../components/HelpToc';
import { HelpTabs } from '../components/HelpTabs';
import { extractMarkdownToc, markdownComponents } from '../lib/markdownToc';
import { resolveBody } from '../lib/indexedLocales';
import { usePageMeta } from '../lib/usePageMeta';
import { useActiveLocale } from '../i18n/useActiveLocale';
import './UserGuide.css';

const SHARED_ACCOUNT_FILES = import.meta.glob('../content/guides/SharedAccounts.*.md', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>;

const AGENT_FILES = import.meta.glob('../content/guides/RunYourOwnAgent.*.md', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>;

const GUIDES = {
  sharedAccounts: { route: '/help/shared-accounts', files: SHARED_ACCOUNT_FILES, meta: 'pageMeta.sharedAccounts' },
  runYourOwnAgent: { route: '/help/run-your-own-agent', files: AGENT_FILES, meta: 'pageMeta.runYourOwnAgent' },
} as const;

export type GuideName = keyof typeof GUIDES;

export default function GuidePage({ guide }: { guide: GuideName }) {
  const { route, files, meta } = GUIDES[guide];
  const location = useLocation();
  usePageMeta({ titleKey: `${meta}.title`, descriptionKey: `${meta}.description`, bodyFiles: files });
  const lang = useActiveLocale();
  const body = useMemo(() => resolveBody(route, lang, files), [route, lang, files]);
  const { text, fellBackToEnglish } = body;
  const toc = useMemo(() => extractMarkdownToc(text), [text]);
  const basePath = location.pathname.replace(/\/$/, '');
  const headingComps = useMemo(() => markdownComponents(body.locale), [body.locale]);

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
            {fellBackToEnglish && <EnglishOnlyNotice variant="legal" />}
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={headingComps as never}>
              {text as ReactNode as string}
            </ReactMarkdown>
          </article>
        </div>
      </main>
      <Footer />
    </div>
  );
}
