/**
 * /help/basic and /help/advanced — in-app rendering of the canonical
 * user-guide Markdown files in `docs/UserGuide-{Basic,Advanced}.md`.
 *
 * Why in-app and not a GitHub link
 * --------------------------------
 * Earlier the CardInfo "Learn more →" link pointed at the GitHub-
 * rendered Markdown. That worked but (a) leaves the app for an
 * external page, (b) gives no way to react to the user's role
 * (lender / borrower) on cards where the action framing differs,
 * and (c) leaks the docs path out of the app shell. This page hosts
 * the same Markdown but inside our chrome and adds a page-wide
 * role-tab toggle so cards with `:lender` / `:borrower` anchor
 * variants render only the relevant voice.
 *
 * How role tabs work
 * ------------------
 * The user guide files use a markup convention:
 *
 *   <a id="create-offer.collateral"></a>
 *   ### Collateral
 *   neutral intro paragraph applicable to either side …
 *
 *   <a id="create-offer.collateral:lender"></a>
 *   #### If you're the lender
 *   lender-side framing …
 *
 *   <a id="create-offer.collateral:borrower"></a>
 *   #### If you're the borrower
 *   borrower-side framing …
 *
 * `parseGuide` walks the raw text and splits it into a sequence of
 * markdown chunks and "role-tab pairs" (lender H4 + borrower H4 with
 * matching ids). The render pass emits regular chunks via
 * react-markdown and role-tab pairs via a tabbed widget that reads
 * the current role from `RoleContext`.
 *
 * Anchor handling
 * ---------------
 * The `<a id="…"></a>` lines in the docs aren't rendered as raw HTML;
 * the `remarkInlineAnchorToId` plugin walks the AST, finds those html
 * sibling nodes, copies the id onto the immediately-following heading
 * via `data.hProperties.id`, and removes the html node. The result is
 * a heading with a stable id attribute and no visible anchor markup.
 *
 * URL fragment behaviour
 * ----------------------
 * - Initial role: derived from the fragment. `…#create-offer.collateral:borrower`
 *   opens the page-wide tab on borrower; no role suffix or `:lender`
 *   opens on lender.
 * - Toggling the tab updates the fragment via `history.replaceState`
 *   so refresh restores the same tab and copying the URL is a
 *   share-able link, but no extra back-button history piles up.
 * - No localStorage. A user genuinely lends and borrows on different
 *   loans; each visit starts from the URL or the lender default.
 */

import { useActiveLocale } from '../i18n/useActiveLocale';
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
import { remarkInlineAnchorToId } from '../lib/remarkInlineAnchorToId';
import remarkGfm from 'remark-gfm';
import { markdownComponents } from '../lib/markdownToc';
import Navbar from '../components/Navbar';
import Footer from '../components/Footer';
import { EnglishOnlyNotice } from '../components/EnglishOnlyNotice';
import { HelpTabs } from '../components/HelpTabs';
import { isSupportedLocale, withLocalePrefix } from '../components/LocaleResolver';
import type { SupportedLocale } from '../i18n/glossary';
import { usePageMeta } from '../lib/usePageMeta';
import { useArticleJsonLd } from '../lib/useArticleJsonLd';
import './UserGuide.css';

/**
 * Per-locale user-guide markdown. Files live in
 * `frontend/src/content/userguide/` named `<Mode>.<locale>.md`
 * (e.g. `Basic.en.md`, `Advanced.en.md`). To add a translation, drop a
 * new file alongside — `Basic.es.md`, `Advanced.ja.md`, etc. — and the
 * UserGuide page will pick it up at build time.
 *
 * Vite's `import.meta.glob` with `eager: true, query: '?raw'` resolves
 * to `Record<absolutePath, rawString>` at build time. Only files
 * matching the glob exist in the bundle; missing locales fall through
 * to the English source with an in-page "translation pending" notice.
 */
const GUIDE_FILES = import.meta.glob('../content/userguide/*.md', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>;

/** Look up the markdown for a (mode, locale) pair. Returns the
 *  resolved text + a flag indicating whether the requested locale was
 *  actually found, so the page can show a "translation pending" notice
 *  on the English fallback. */
function resolveGuide(
  mode: 'Basic' | 'Advanced',
  locale: string,
): { text: string; usedLocale: string; fellBackToEnglish: boolean } {
  const wanted = `../content/userguide/${mode}.${locale}.md`;
  const fallback = `../content/userguide/${mode}.en.md`;
  if (GUIDE_FILES[wanted]) {
    return { text: GUIDE_FILES[wanted], usedLocale: locale, fellBackToEnglish: false };
  }
  return {
    text: GUIDE_FILES[fallback] ?? '',
    usedLocale: 'en',
    fellBackToEnglish: locale !== 'en',
  };
}

/**
 * Locale of the guide document actually rendered — which is NOT the route
 * locale when a translation is missing and `resolveGuide` falls back to
 * English (#1610 review round 5). Nested renderers (`RoleTabs`,
 * `MarkdownChunk`) need it to format embedded values consistently with
 * the prose around them, and they are too deep to thread a prop through.
 */
const DocLocaleContext = createContext('en');

type Role = 'lender' | 'borrower';

interface RoleContextValue {
  role: Role;
  setRole: (r: Role) => void;
}

const RoleContext = createContext<RoleContextValue | null>(null);

function useRole(): RoleContextValue {
  const ctx = useContext(RoleContext);
  if (!ctx) throw new Error('useRole used outside RoleContext');
  return ctx;
}

// ── Parser ────────────────────────────────────────────────────────────

interface MarkdownBlock {
  kind: 'markdown';
  text: string;
}

interface RoleTabBlock {
  kind: 'tabs';
  /** Shared id minus the role suffix — used as the section's stable handle. */
  baseId: string;
  /** Raw markdown for the lender tab body, anchor + heading + content. */
  lender: string;
  /** Raw markdown for the borrower tab body, anchor + heading + content. */
  borrower: string;
}

type GuideBlock = MarkdownBlock | RoleTabBlock;

/**
 * Split a guide's raw markdown text into a flat sequence of plain
 * markdown chunks and role-tab pairs. The pair detector looks for two
 * adjacent anchored H4 sections whose ids share a `:lender` / `:borrower`
 * suffix on the same base. Anything between or around them is emitted
 * as a regular markdown chunk so the page reads top-to-bottom.
 */
function parseGuide(raw: string): GuideBlock[] {
  const blocks: GuideBlock[] = [];

  // Regex: lender anchor + H4 + body, then borrower anchor with same
  // base + H4 + body. Body terminates at the next `### ` (next H3),
  // `## ` (next H2), or `<a id="…"></a>` followed by `## ` or `### `
  // (next anchored section), or end of file.
  const tabPattern =
    /<a id="(?<key>[^"]+):lender"><\/a>\s*\n+(####[^\n]*\n+)([\s\S]*?)<a id="\k<key>:borrower"><\/a>\s*\n+(####[^\n]*\n+)([\s\S]*?)(?=\n###\s|\n##\s|<a id="[^"]+"><\/a>\s*\n+##\s|<a id="[^"]+"><\/a>\s*\n+###\s|$)/g;

  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = tabPattern.exec(raw)) !== null) {
    const groups = match.groups ?? {};
    const baseId = groups.key ?? '';
    const lenderHeading = match[1] ?? '';
    const lenderBody = match[3] ?? '';
    const borrowerHeading = match[4] ?? '';
    const borrowerBody = match[5] ?? '';

    if (match.index > cursor) {
      blocks.push({ kind: 'markdown', text: raw.slice(cursor, match.index) });
    }
    blocks.push({
      kind: 'tabs',
      baseId,
      lender: `<a id="${baseId}:lender"></a>\n\n${lenderHeading}${lenderBody}`,
      borrower: `<a id="${baseId}:borrower"></a>\n\n${borrowerHeading}${borrowerBody}`,
    });
    cursor = match.index + match[0].length;
  }
  if (cursor < raw.length) {
    blocks.push({ kind: 'markdown', text: raw.slice(cursor) });
  }
  return blocks;
}

// ── TOC extraction ────────────────────────────────────────────────────

import type { TocItem, TocSection } from '../lib/guideToc';
import { extractToc } from '../lib/guideToc';

// ── Role tabs widget (per-card, embedded in the body) ─────────────────

interface RoleTabsProps {
  block: RoleTabBlock;
}

function RoleTabs({ block }: RoleTabsProps) {
  const { role, setRole } = useRole();
  const docLocale = useContext(DocLocaleContext);
  const body = role === 'lender' ? block.lender : block.borrower;

  return (
    <div className="role-tabs" data-base-id={block.baseId}>
      <div className="role-tabs-bar" role="tablist" aria-label="Viewer role">
        <button
          type="button"
          role="tab"
          aria-selected={role === 'lender'}
          className={`role-tab ${role === 'lender' ? 'is-active' : ''}`}
          onClick={() => setRole('lender')}
        >
          If you're the lender
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={role === 'borrower'}
          className={`role-tab ${role === 'borrower' ? 'is-active' : ''}`}
          onClick={() => setRole('borrower')}
        >
          If you're the borrower
        </button>
      </div>
      <div className="role-tabs-body">
        <ReactMarkdown
          remarkPlugins={[remarkGfm, remarkInlineAnchorToId]}
          components={markdownComponents(docLocale) as never}
        >
          {body}
        </ReactMarkdown>
      </div>
    </div>
  );
}

// ── Sidebar (role tabs + TOC) ─────────────────────────────────────────

interface SidebarProps {
  toc: TocSection[];
  /** Path the page is mounted at — used to build absolute hrefs that
   *  preserve the route while only swapping the fragment. */
  basePath: string;
}

/**
 * Compact role-tab bar. Used in two places:
 *   - At the top of the desktop sticky sidebar (always visible while
 *     the sidebar is in view — which is whenever the page is scrolled).
 *   - As a sticky bar pinned to the top of the content column on
 *     mobile, sitting just below the fixed Navbar — always reachable
 *     regardless of whether the reader has the TOC accordion expanded.
 */
function RoleSelector() {
  const { role, setRole } = useRole();
  return (
    <div className="user-guide-role">
      <div className="user-guide-role-label">Reading as</div>
      <div className="user-guide-role-tabs" role="tablist" aria-label="Viewer role">
        <button
          type="button"
          role="tab"
          aria-selected={role === 'lender'}
          className={`user-guide-role-tab ${role === 'lender' ? 'is-active' : ''}`}
          onClick={() => setRole('lender')}
        >
          Lender
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={role === 'borrower'}
          className={`user-guide-role-tab ${role === 'borrower' ? 'is-active' : ''}`}
          onClick={() => setRole('borrower')}
        >
          Borrower
        </button>
      </div>
    </div>
  );
}

function Toc({ toc, basePath }: SidebarProps) {
  // Close any enclosing <details> accordion when a TOC item is
  // tapped. On mobile the TOC lives inside `<details className=
  // "user-guide-toc-mobile">`; without this, the accordion stays
  // open after navigation and covers the content the user just
  // jumped to. The `closest('details')` lookup is a no-op on
  // desktop where the TOC lives directly inside the sidebar
  // `<aside>` with no <details> ancestor.
  const collapseEnclosingDetails = (e: React.MouseEvent<HTMLAnchorElement>) => {
    const details = e.currentTarget.closest('details');
    if (details) details.removeAttribute('open');
  };

  return (
    <nav className="user-guide-toc" aria-label="Table of contents">
      {toc.map((section, sIdx) => (
        <div key={sIdx} className="user-guide-toc-group">
          {section.title && (
            <div className="user-guide-toc-group-title">{section.title}</div>
          )}
          <ul className="user-guide-toc-list">
            {section.items.map((item) => (
              <li key={item.id} className="user-guide-toc-item">
                <a
                  href={`${basePath}#${item.id}`}
                  onClick={collapseEnclosingDetails}
                >
                  {item.title}
                </a>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}

// ── Page shell ────────────────────────────────────────────────────────

interface UserGuideProps {
  variant: 'basic' | 'advanced';
}

/**
 * Pull the role suffix out of `#create-offer.collateral:borrower` etc.
 * Returns the role and the un-suffixed base fragment so we can scroll
 * the page to the section after first paint.
 */
function parseFragment(hash: string): { baseId: string | null; role: Role | null } {
  if (!hash) return { baseId: null, role: null };
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!raw) return { baseId: null, role: null };
  const [base, suffix] = raw.split(':');
  const role: Role | null = suffix === 'lender' || suffix === 'borrower' ? suffix : null;
  return { baseId: base, role };
}

export default function UserGuide({ variant }: UserGuideProps) {
  const location = useLocation();
  const { i18n } = useTranslation();
  // Per-variant SEO meta — `/help/basic` and `/help/advanced` share
  // the component but need distinct titles + descriptions for the
  // crawler to index them as separate pages.
  usePageMeta({
    titleKey: variant === 'basic'
      ? 'pageMeta.userGuideBasic.title'
      : 'pageMeta.userGuideAdvanced.title',
    descriptionKey: variant === 'basic'
      ? 'pageMeta.userGuideBasic.description'
      : 'pageMeta.userGuideAdvanced.description',
  });
  const mode: 'Basic' | 'Advanced' = variant === 'advanced' ? 'Advanced' : 'Basic';
  const lang = useActiveLocale();
  const { text: raw, usedLocale, fellBackToEnglish } = useMemo(
    () => resolveGuide(mode, lang),
    [mode, lang],
  );
  useArticleJsonLd({
    titleKey: variant === 'basic'
      ? 'pageMeta.userGuideBasic.title'
      : 'pageMeta.userGuideAdvanced.title',
    descriptionKey: variant === 'basic'
      ? 'pageMeta.userGuideBasic.description'
      : 'pageMeta.userGuideAdvanced.description',
    // Advertise the language of the guide markdown actually rendered
    // (resolveGuide falls back to English for missing locales).
    contentLanguage: usedLocale,
  });
  const blocks = useMemo(() => parseGuide(raw), [raw]);
  const toc = useMemo(() => extractToc(raw), [raw]);
  // TOC links must keep the user on the same locale-prefixed route.
  // Without `withLocalePrefix` the hrefs come out as `/help/<variant>#…`
  // and React Router's locale guard at the root mount falls back to
  // English, silently flipping the language on every TOC tap.
  const locale: SupportedLocale = useActiveLocale();
  const basePath = withLocalePrefix(`/help/${variant}`, locale);

  const [role, setRole] = useState<Role>(() => {
    if (typeof window === 'undefined') return 'lender';
    return parseFragment(window.location.hash).role ?? 'lender';
  });

  // Scroll to the deep-link anchor after the page renders. Browsers
  // honour `#` fragments on initial navigation, but the anchored
  // heading id only exists in the DOM after the first React render —
  // so we re-trigger the scroll once mounted.
  useEffect(() => {
    const { baseId } = parseFragment(window.location.hash);
    if (!baseId) return;
    const t = window.setTimeout(() => {
      const el = document.getElementById(baseId);
      if (el) el.scrollIntoView({ block: 'start' });
    }, 0);
    return () => window.clearTimeout(t);
  }, [variant, location.pathname]);

  // Sync role when the user clicks an in-page anchor link with a role
  // suffix (`<a href="#create-offer.collateral:borrower">`). React
  // Router doesn't fire on hash-only changes; the browser's
  // `hashchange` event does.
  useEffect(() => {
    const onHashChange = () => {
      const next = parseFragment(window.location.hash).role;
      if (next && next !== role) setRole(next);
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, [role]);

  // When the role flips via a tab click, re-write the fragment in
  // place. `replaceState` keeps the user on the same scroll position
  // and doesn't push a new history entry, so the back button still
  // returns to wherever they came from.
  const setRoleAndUpdateUrl = (next: Role) => {
    setRole(next);
    if (typeof window === 'undefined') return;
    const { baseId, role: prev } = parseFragment(window.location.hash);
    if (!baseId) return;
    if (prev === next) return;
    const newHash = `#${baseId}:${next}`;
    window.history.replaceState(
      null,
      '',
      `${window.location.pathname}${window.location.search}${newHash}`,
    );
  };

  const ctx = useMemo<RoleContextValue>(
    () => ({ role, setRole: setRoleAndUpdateUrl }),
    // setRoleAndUpdateUrl closes over `role` only via the parser; safe to
    // omit since the React state setter is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [role],
  );

  return (
    // `DocLocaleContext` carries the locale of the document actually
    // resolved — English when a translation is missing — so embedded
    // values format like the prose around them rather than like the
    // route (#1610 review round 5).
    <DocLocaleContext.Provider value={usedLocale}>
    {/* Standard sticky-footer flex column. `min-height: 100vh` on the
        wrapper plus `flex: 1` on the main content guarantees that the
        Footer is always anchored to the bottom — pushed below the
        content when the page is long, parked at the viewport floor
        when the page is short. Without this shell, on certain
        viewport states the Footer can get pushed off-screen by sticky
        children inside main and not show at all. */}
    <div className="user-guide-page">
      <Navbar />
      <RoleContext.Provider value={ctx}>
        <main className="user-guide-main">
          <div className="user-guide-layout">
            {/* Mobile-only sticky bar combining role tabs + TOC
                accordion. Both stay pinned just below the Navbar so
                the reader can always reach the role toggle and jump
                to a section without scrolling back to the top. The
                role tabs are outside the <details> so they stay
                visible whether the TOC is open or collapsed. */}
            <div className="user-guide-sticky-mobile">
              <RoleSelector />
              <details className="user-guide-toc-mobile">
                <summary>Sections</summary>
                <div className="user-guide-toc-mobile-body">
                  <Toc toc={toc} basePath={basePath} />
                </div>
              </details>
            </div>

            <aside className="user-guide-sidebar-desktop">
              {/* Role selector pinned to the top of the sidebar via
                  flex:0 0 auto; the TOC below carries flex:1 1 auto +
                  overflow-y:auto so when the section list is long it
                  scrolls inside the sidebar without pushing the role
                  tabs out of view. */}
              <RoleSelector />
              <Toc toc={toc} basePath={basePath} />
            </aside>

            <article className="user-guide-content">
              <HelpTabs />
              {fellBackToEnglish && <EnglishOnlyNotice variant="guide" />}
              {blocks.map((block, i) =>
                block.kind === 'markdown' ? (
                  <MarkdownChunk key={i} text={block.text} />
                ) : (
                  <RoleTabs key={i} block={block} />
                ),
              )}
            </article>
          </div>
        </main>
      </RoleContext.Provider>
      <Footer />
    </div>
    </DocLocaleContext.Provider>
  );
}

// Wrapper so the cast-narrow + plugin chain is in one place.
function MarkdownChunk({ text }: { text: string }) {
  const docLocale = useContext(DocLocaleContext);
  // `as never` to satisfy react-markdown's strict plugin-tuple typing
  // while still passing our custom plugin through. The shape it
  // expects is a callable PluggableList; our plugin returns the right
  // tree-mutator function so behaviour is correct at runtime.
  const plugins = [remarkGfm, remarkInlineAnchorToId] as never;
  return (
    <ReactMarkdown
      remarkPlugins={plugins}
      components={markdownComponents(docLocale) as never}
    >
      {text as ReactNode as string}
    </ReactMarkdown>
  );
}
