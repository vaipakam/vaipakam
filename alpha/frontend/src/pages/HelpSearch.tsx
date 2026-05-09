/**
 * /help/search — documentation search results.
 *
 * Reads the query from `?q=` and renders hits from the client-side
 * index built in {@link docSearch}. Hits are grouped by doc kind
 * (Overview, User Guide Basic / Advanced, Whitepaper) so the user can
 * scan by source. Each hit links to the section anchor — same anchor
 * the in-page TOC uses, so a click lands on the exact heading.
 *
 * Below the results, a "Search the web ↗" link opens a Google
 * site-search for vaipakam.com. That's the hybrid escape hatch — the
 * primary path is the in-app index (instant, anchor-aware, no
 * tracking), but users who want web-style search across the live site
 * get one click to it without any embed cost.
 */

import { useMemo, useEffect, useRef, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { ExternalLink } from 'lucide-react';
import Navbar from '../components/Navbar';
import Footer from '../components/Footer';
import { HelpTabs } from '../components/HelpTabs';
import {
  searchDocs,
  googleSiteSearchUrl,
  type DocKind,
  type SearchHit,
} from '../lib/docSearch';
import './UserGuide.css';

const DOC_KIND_ORDER: DocKind[] = [
  'overview',
  'userguide-basic',
  'userguide-advanced',
  'whitepaper',
];

export default function HelpSearch() {
  const { t, i18n } = useTranslation();
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const inputRef = useRef<HTMLInputElement>(null);

  const query = params.get('q') ?? '';
  const lang = i18n.resolvedLanguage ?? 'en';

  const hits = useMemo(
    () => (query.length >= 2 ? searchDocs(query, lang, t) : []),
    [query, lang, t],
  );

  const grouped = useMemo(() => {
    const m = new Map<DocKind, SearchHit[]>();
    for (const h of hits) {
      const arr = m.get(h.docKind) ?? [];
      arr.push(h);
      m.set(h.docKind, arr);
    }
    return m;
  }, [hits]);

  // Auto-focus the in-page search input when the page loads, so the
  // user can refine their query immediately without reaching for the
  // top-strip search box.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    const q = String(data.get('q') ?? '').trim();
    if (q) setParams({ q });
  };

  const isNonEnglishWhitepaperNote = lang !== 'en' && grouped.has('whitepaper');

  return (
    <div className="user-guide-page">
      <Navbar />
      <main className="user-guide-main">
        <div className="user-guide-layout user-guide-layout-wide">
          <article
            className="user-guide-content"
            style={{ maxWidth: 880, margin: '0 auto' }}
          >
            <HelpTabs />

            <h1 style={{ marginTop: 24 }}>{t('helpSearch.heading')}</h1>

            <form
              onSubmit={handleSubmit}
              style={{ display: 'flex', gap: 8, margin: '16px 0' }}
            >
              <input
                ref={inputRef}
                type="search"
                name="q"
                defaultValue={query}
                className="form-input"
                placeholder={t('helpSearch.placeholder')}
                aria-label={t('helpSearch.placeholder')}
                style={{ flex: 1 }}
              />
              <button type="submit" className="btn btn-primary">
                {t('helpSearch.submit')}
              </button>
            </form>

            {query.length === 0 && (
              <p style={{ opacity: 0.75 }}>{t('helpSearch.emptyHint')}</p>
            )}

            {query.length > 0 && query.length < 2 && (
              <p style={{ opacity: 0.75 }}>{t('helpSearch.tooShort')}</p>
            )}

            {query.length >= 2 && hits.length === 0 && (
              <p style={{ opacity: 0.75 }}>
                {t('helpSearch.noResults', { query })}
              </p>
            )}

            {hits.length > 0 && (
              <p style={{ opacity: 0.75 }}>
                {t('helpSearch.resultCount', { count: hits.length, query })}
              </p>
            )}

            {DOC_KIND_ORDER.map((dk) => {
              const list = grouped.get(dk);
              if (!list || list.length === 0) return null;
              return (
                <section key={dk} style={{ marginTop: 24 }}>
                  <h2>{list[0].docKindLabel}</h2>
                  <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                    {list.map((hit) => (
                      <li
                        key={`${dk}:${hit.anchor}:${hit.title}`}
                        style={{
                          padding: '12px 0',
                          borderBottom: '1px solid var(--border)',
                        }}
                      >
                        <Link
                          to={hit.href}
                          state={{ fromSearch: location.pathname + location.search }}
                          style={{
                            display: 'block',
                            color: 'var(--text-primary)',
                            textDecoration: 'none',
                          }}
                        >
                          <strong style={{ color: 'var(--brand)' }}>
                            {hit.title}
                          </strong>
                          <p
                            style={{
                              margin: '4px 0 0',
                              opacity: 0.85,
                              fontSize: '0.92rem',
                            }}
                          >
                            {renderSnippet(hit.snippet)}
                          </p>
                        </Link>
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })}

            {isNonEnglishWhitepaperNote && (
              <p style={{ marginTop: 16, opacity: 0.7, fontSize: '0.85rem' }}>
                {t('helpSearch.whitepaperEnglishOnly')}
              </p>
            )}

            {query.length >= 2 && (
              <p style={{ marginTop: 32, opacity: 0.85 }}>
                <a
                  href={googleSiteSearchUrl(query)}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    color: 'var(--brand)',
                  }}
                >
                  {t('helpSearch.searchTheWeb', { query })}
                  <ExternalLink size={13} />
                </a>
              </p>
            )}
          </article>
        </div>
      </main>
      <Footer />
    </div>
  );
}

/**
 * Render the structured `{ prefix, match, suffix }` snippet built by
 * docSearch into a JSX tree, wrapping the match in `<mark>`. Returning
 * a structured triple from the indexer (instead of a sentinel-laced
 * string) keeps the snippet output regex-free at render time.
 */
function renderSnippet(snippet: { prefix: string; match: string; suffix: string }): ReactNode {
  return (
    <>
      {snippet.prefix}
      {snippet.match && <mark>{snippet.match}</mark>}
      {snippet.suffix}
    </>
  );
}
