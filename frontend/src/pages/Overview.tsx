/**
 * /help/overview — friendly product tour.
 *
 * Renders the canonical Overview markdown from
 * `frontend/src/content/overview/Overview.<locale>.md`. Falls back to
 * the English source with a translation-pending notice when the
 * requested locale isn't available yet.
 *
 * No role tabs (unlike UserGuide), no per-card anchors. Just a
 * top-to-bottom prose tour that introduces the product to a reader
 * who knows nothing about Vaipakam. Pairs with HelpTabs at the page
 * top so the reader can flip to the User Guide or Technical tabs
 * without leaving the help section.
 */

import { useMemo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import Navbar from '../components/Navbar';
import Footer from '../components/Footer';
import { EnglishOnlyNotice } from '../components/app/EnglishOnlyNotice';
import { HelpTabs } from '../components/HelpTabs';
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
  const lang = i18n.resolvedLanguage ?? 'en';
  const { text, fellBackToEnglish } = useMemo(() => resolveOverview(lang), [lang]);

  return (
    <div className="user-guide-page">
      <Navbar />
      <main className="user-guide-main">
        <div className="user-guide-layout user-guide-layout--single">
          <article className="user-guide-content">
            <HelpTabs />
            {fellBackToEnglish && <EnglishOnlyNotice variant="guide" />}
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {text as ReactNode as string}
            </ReactMarkdown>
          </article>
        </div>
      </main>
      <Footer />
    </div>
  );
}
