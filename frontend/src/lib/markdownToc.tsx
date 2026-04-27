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
 * sidebar), H3 = jump target. H1 is reserved for the document title
 * and skipped. H4+ are body-level and don't appear in the TOC.
 */

import type { ReactNode } from 'react';

/**
 * GitHub-style heading slug. Lowercase, non-alphanumeric becomes
 * hyphens, multiple hyphens collapse, leading/trailing hyphens
 * stripped. Matches the algorithm used by GitHub's renderer so
 * external links to `…#section-name` keep working when the markdown
 * is viewed on GitHub vs. in-app.
 */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

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
 * `title`. Sections with no H3 children are dropped — they'd render
 * as orphan group labels in the sidebar.
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

  return sections.filter((s) => s.items.length > 0);
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
    h2: ({ children }: { children?: ReactNode }) => {
      const id = slugify(nodeToText(children));
      return <h2 id={id}>{children}</h2>;
    },
    h3: ({ children }: { children?: ReactNode }) => {
      const id = slugify(nodeToText(children));
      return <h3 id={id}>{children}</h3>;
    },
  };
}
