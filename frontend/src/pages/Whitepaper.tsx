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
 * Pairs with HelpTabs at the page top so the reader can flip back to
 * the Overview or User Guide (which are translated) for a more
 * accessible explanation of the same material.
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
  const text = useMemo(() => resolveWhitepaper(), []);
  const isNonEnglish = (i18n.resolvedLanguage ?? 'en') !== 'en';

  return (
    <div className="user-guide-page">
      <Navbar />
      <main className="user-guide-main">
        <div className="user-guide-layout user-guide-layout--single">
          <article className="user-guide-content">
            <HelpTabs />
            {isNonEnglish && <EnglishOnlyNotice variant="legal" />}
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
