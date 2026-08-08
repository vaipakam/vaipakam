/**
 * Shared markdown TOC + slug helpers used by Overview and Whitepaper.
 *
 * Both pages render long-form markdown without inline `<a id="...">`
 * anchors (unlike the User Guide, where each card has a hand-rolled
 * registry id). For these we generate stable section ids from the
 * heading text via a GitHub-style slug, so:
 *
 *   ## What can you do        →  id="what-can-you-do"
 *   ### Step 1 — Create…      →  id="step-1-create"
 *
 * The TOC sidebar links to `${basePath}#${slug}` and the
 * `markdownComponents` returned by `headingComponents()` install the
 * matching id on each `<h2>` / `<h3>` that ReactMarkdown renders, so
 * a tap on a TOC link scrolls to the right section.
 *
 * Two-level structure: H2 = section group (rendered as a label in the
 * sidebar), H3 = jump target. If a document has an H2 with no H3
 * children, that H2 becomes its own jump target so H2-only documents
 * still get a usable TOC. H1 is reserved for the document title and
 * skipped. H4+ are body-level and don't appear in the TOC.
 */

import type { ReactNode } from 'react';
import { LiveValue, type KnobName } from '../components/docs/LiveValue';

import { slugify } from './slugify';
// Re-exported so the several pages that already import it from here keep
// working; the implementation moved out to stay React-free.
export { slugify };

export interface TocItem {
  id: string;
  title: string;
}

export interface TocSection {
  /** Section heading (from H2). May be empty for top-level H3s with no
   *  preceding H2. */
  title: string;
  items: TocItem[];
}

/**
 * Walk the raw markdown line-by-line and build a two-level TOC. H2s
 * become section group titles, H3s become jump items underneath. H3s
 * appearing before any H2 land in an unsectioned group with empty
 * `title`. Sections with no H3 children become single H2 jump items
 * instead of disappearing from the sidebar.
 *
 * Code-fence aware: inside ``` blocks we skip line scanning so a
 * `## Foo` line in a code example doesn't become a TOC entry.
 */
export function extractMarkdownToc(raw: string): TocSection[] {
  const lines = raw.split('\n');
  const sections: TocSection[] = [];
  let currentSection: TocSection | null = null;
  let inCodeFence = false;

  for (const line of lines) {
    if (/^```/.test(line)) {
      inCodeFence = !inCodeFence;
      continue;
    }
    if (inCodeFence) continue;

    const h2 = /^##\s+(.+)$/.exec(line);
    if (h2) {
      currentSection = { title: h2[1].trim(), items: [] };
      sections.push(currentSection);
      continue;
    }
    const h3 = /^###\s+(.+)$/.exec(line);
    if (h3) {
      if (!currentSection) {
        currentSection = { title: '', items: [] };
        sections.push(currentSection);
      }
      const title = h3[1].trim();
      currentSection.items.push({ id: slugify(title), title });
    }
  }

  return sections.map((section) => {
    if (section.items.length > 0) return section;
    const id = slugify(section.title) || 'section';
    return {
      title: '',
      items: [{ id, title: section.title }],
    };
  });
}

/**
 * Recursively flatten ReactMarkdown's heading children to a plain
 * text string for slug derivation. ReactMarkdown wraps inline-code
 * spans, emphasis, etc. as React elements, so we can't just stringify
 * `children` — need to walk and pull text out of every leaf.
 */
function nodeToText(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(nodeToText).join('');
  if (typeof node === 'object' && 'props' in node) {
    const props = (node as { props?: { children?: ReactNode } }).props;
    return nodeToText(props?.children);
  }
  return '';
}

/**
 * Custom components for ReactMarkdown that install slug-derived ids
 * on H2 and H3 elements. Pass to `<ReactMarkdown components={...}>`.
 *
 * The slug is computed from the heading's text content so it matches
 * what `extractMarkdownToc` produces for the TOC links — they line up
 * one-to-one without a separate id registry.
 */
export function headingComponents() {
  return {
    h2: ({ children, id }: HeadingProps) => {
      const slug = slugify(nodeToText(children));
      return (
        <>
          {explicitAnchor(id, slug)}
          <h2 id={slug}>{children}</h2>
        </>
      );
    },
    h3: ({ children, id }: HeadingProps) => {
      const slug = slugify(nodeToText(children));
      return (
        <>
          {explicitAnchor(id, slug)}
          <h3 id={slug}>{children}</h3>
        </>
      );
    },
  };
}

interface HeadingProps {
  children?: ReactNode;
  /** Set by `remarkInlineAnchorToId` (UserGuide) from an
   *  `<a id="…"></a>` marker preceding the heading in the markdown. */
  id?: string;
}

/**
 * Renders the STABLE, hand-authored anchor a guide file attaches to a
 * heading — as its own zero-size element immediately before that
 * heading, not on the heading itself.
 *
 * Both id schemes have to coexist, which is why this is a separate
 * element rather than a prop on the `<h2>`/`<h3>`:
 *
 *  - The SLUG id (derived from the heading text) is what
 *    `extractMarkdownToc` emits for the in-page TOC links, so the
 *    heading must keep it or the guide's own contents list breaks.
 *  - The EXPLICIT id (`stuck-recovery.what`) is what off-site deep
 *    links target — the recovery declaration in the connected app
 *    attests the user has read that section. It has to be stable
 *    across locales, and it is: every localized guide carries the same
 *    `stuck-recovery.*` markers, while the slug is derived from the
 *    TRANSLATED heading and therefore differs per language.
 *
 * Before this, `headingComponents` unconditionally rewrote the heading
 * with the slug, discarding the `id` react-markdown passed down from
 * the remark plugin's `data.hProperties.id`. The plugin computed the
 * anchor correctly and the rendered page then threw it away, so every
 * explicit deep link silently landed at the top of a very long guide
 * instead of its section — including the one the signed recovery
 * declaration points at. Caught in production by
 * `apps/alpha02/e2e/live/live-recover.mjs`.
 */
function explicitAnchor(id: string | undefined, slug: string): ReactNode {
  if (!id || id === slug) return null;
  // The marker is what the browser (and UserGuide's own hash handler)
  // SCROLLS TO, so it needs the same sticky-header clearance the
  // headings have — the pages' `scroll-margin-top` rules are written
  // against `h1…h4` only, so an inline span would have landed at the
  // very top of the viewport, underneath the fixed navbar and the
  // mobile role bar, hiding the section title the link named
  // (Codex #1561 r2). `.doc-anchor` in global.css carries the same
  // 132px / 96px offsets, and `display:block` gives it a box to apply
  // them to.
  return <span className="doc-anchor" id={id} aria-hidden="true" />;
}

/**
 * Match an inline-code token of the form `{liveValue:knobName}`. Used
 * by the markdown `code` interceptor so doc authors can write a
 * single-token snippet in plain markdown that renders as a live
 * on-chain value instead of literal text.
 */
const LIVE_VALUE_TOKEN_RE = /^\{liveValue:([a-zA-Z0-9]+)\}$/;


/**
 * Like {@link headingComponents} plus a `code` interceptor that
 * recognises `{liveValue:knobName}` inline-code spans and renders the
 * `<LiveValue>` component in their place.
 *
 * Doc pages (Overview / UserGuide / Whitepaper / AdminKnobsDocs) use
 * this in place of `headingComponents()` so values like the yield fee
 * BPS or VPFI tier thresholds stay synced with on-chain config without
 * a doc PR every time governance retunes a knob. Tokens that don't
 * match a registered knob fall through to the standard `<code>`
 * renderer so a typo is visibly debuggable rather than silently wrong.
 *
 * Escape hatch: if a doc author genuinely wants the literal text
 * `{liveValue:foo}` to render as inline code (e.g. when documenting
 * this very system), they can use a fenced code block — fenced blocks
 * pass `inline === false` and skip this match.
 *
 * The returned object is module-scoped + memoized so consumers calling
 * this on every render (UserGuide renders many small `<MarkdownChunk>`
 * fragments) all share one components-map reference. ReactMarkdown
 * shallow-compares the `components` prop, so a fresh allocation per
 * chunk would force every chunk to re-render its tree on every parent
 * update.
 */
interface CodeRendererProps {
  children?: ReactNode;
  /**
   * react-markdown v10 hands every custom renderer the HAST node it is
   * rendering. It is INTERNAL — the default renderers never forward it —
   * so it is destructured away rather than spread onto a DOM element,
   * where React serialises it as `node="[object Object]"`.
   *
   * That was already shipping before #1606: this renderer spread
   * `...rest` unchanged, putting the attribute on 5,728 inline-code
   * elements across the prerendered pages.
   */
  node?: unknown;
  [key: string]: unknown;
}

/**
 * `<code>` renderer that swaps `{liveValue:knobName}` for the live value.
 *
 * Why there is NO inline-vs-block test here (#1606)
 * ------------------------------------------------
 * This used to read react-markdown's `inline` prop, which v9 REMOVED —
 * so on v10 it was always `undefined`, the substitution never ran, and
 * every token in the docs rendered as literal text.
 *
 * The prop is not needed, and re-deriving it was a wrong turn. Block
 * code always arrives with a TRAILING NEWLINE and inline code never
 * does — verified for fenced, fenced-with-language and indented blocks:
 *
 *     fenced    →  "{liveValue:x}\n"
 *     indented  →  "{liveValue:x}\n"
 *     inline    →  "{liveValue:x}"
 *
 * {@link LIVE_VALUE_TOKEN_RE} is ANCHORED, so it rejects the newline
 * form on its own. The anchoring IS the block/inline discriminator, and
 * it is what preserves the deliberate escape hatch: a fenced block
 * containing the token renders literally, so the docs can document this
 * mechanism.
 *
 * That makes the anchors load-bearing rather than cosmetic. Unanchor the
 * regex and fenced code samples silently start resolving.
 * `scripts/check-live-value-render.tsx` asserts the behaviour across all
 * ten constructs that produce a `<code>` element, so the property is
 * tested rather than merely asserted in this comment.
 */
function makeMarkdownCode(docLocale: string) {
  return function MarkdownCode({ children, node: _node, ...rest }: CodeRendererProps) {
    const match = LIVE_VALUE_TOKEN_RE.exec(nodeToText(children));
    if (match) {
      return <LiveValue knob={match[1] as KnobName} locale={docLocale} />;
    }
    // Default — preserve native ReactMarkdown behaviour for every other
    // inline-code span and every code block.
    return <code {...rest}>{children}</code>;
  };
}

// Keyed by document locale. ReactMarkdown shallow-compares `components`,
// so a fresh object per render would re-render every chunk on every parent
// update — the reason this was memoized in the first place. A Map keeps
// that stability now that the map depends on the document's language.
const _cachedMarkdownComponents = new Map<string, ReturnType<typeof buildMarkdownComponents>>();
function buildMarkdownComponents(docLocale: string) {
  return {
    ...headingComponents(),
    code: makeMarkdownCode(docLocale),
  };
}
/**
 * @param docLocale locale of the DOCUMENT being rendered — which is not
 * always the UI locale. Pages that always resolve `.en.md` must pass
 * `'en'` even on a locale-prefixed route.
 */
export function markdownComponents(docLocale: string) {
  let cached = _cachedMarkdownComponents.get(docLocale);
  if (!cached) {
    cached = buildMarkdownComponents(docLocale);
    _cachedMarkdownComponents.set(docLocale, cached);
  }
  return cached;
}
