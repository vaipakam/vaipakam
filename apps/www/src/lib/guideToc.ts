/**
 * The User Guide's table of contents — H2 chapters grouping the H3
 * cards underneath them.
 *
 * Lives here rather than in `UserGuide.tsx` so the guard script
 * `scripts/check-guide-toc-coverage.ts` can assert against the SAME
 * function the page renders from. A guard that reimplemented this would
 * be checking its own copy of the rule, which is how the chapter that
 * prompted #1599 stayed invisible for so long.
 */
import { fromMarkdown } from 'mdast-util-from-markdown';
import { toString } from 'mdast-util-to-string';
import type { Heading } from 'mdast';
import { anchorIdOf } from './remarkInlineAnchorToId';
import { slugify } from './slugify';

export interface TocItem {
  id: string;
  title: string;
}

export interface TocSection {
  title: string;
  items: TocItem[];
}

/**
 * Build the two-level table of contents — H2 chapters grouping the H3
 * cards underneath them. Only H3s carrying a stable inline anchor get a
 * link target; role-tab variants (`…:lender`, `…:borrower`) are skipped
 * so they don't appear as duplicate entries.
 *
 * Read from the Markdown PARSE TREE, not by scanning lines. A line scan
 * counts things the reader never sees as headings — inside a fenced
 * code sample, inside an HTML comment, inside indented code — and each
 * of those is a silent wrong answer. The sibling guard
 * `scripts/check-guide-anchor-parity.mjs` learned this the long way,
 * one CommonMark rule per review round (#1594); this uses the same
 * parser rather than repeating the exercise. `mdast-util-from-markdown`
 * is what `react-markdown` is already built on, so it costs nothing in
 * the bundle and it is by construction the same reading of the file
 * that the page renders.
 *
 * Only ROOT-level headings count. A `##` indented into a list item
 * parses as `root > list > listItem > heading` and is not a chapter.
 * `Advanced.hi.md` and `Advanced.ja.md` used to carry two of those
 * each — already translated, indented into the preceding bullet, and
 * therefore offered nowhere. They have since been de-indented (#1593);
 * the rule stays so the next one is caught rather than counted.
 *
 * A chapter whose cards have no anchors becomes its OWN jump target
 * rather than being dropped. It used to be dropped, and that was a live
 * defect: `## How VPFI Discounts Work` printed on `/help/advanced` and
 * appeared nowhere in the contents list, so the only way to reach it
 * was to scroll past everything above it (#1599). Its two cards have no
 * anchors, and they cannot simply be given some — every anchor the
 * English guide carries that the nine translations lack is an
 * anchor-parity failure, and that chapter is untranslated (#1593). The
 * durable fix is here anyway: the NEXT unanchored chapter stays
 * reachable instead of vanishing silently.
 *
 * The id used is the heading's slug, which is what `headingComponents`
 * installs on every rendered `<h2>`, so the link resolves.
 *
 * Built once per file via useMemo on the page.
 */
function headingText(node: Heading): string {
  return toString(node).trim();
}

export function extractToc(raw: string): TocSection[] {
  const sections: TocSection[] = [];
  let currentSection: TocSection | null = null;
  let pendingId: string | null = null;

  for (const node of fromMarkdown(raw).children) {
    // `<a>` is inline-only, so an anchor marker on its own line is a
    // PARAGRAPH of inline html, not an html block — and it arrives
    // split into two children. `anchorIdOf` is the renderer's own rule
    // for this, shared rather than restated.
    const anchorId = anchorIdOf(node);
    if (anchorId) {
      pendingId = anchorId;
      continue;
    }
    // Any other non-heading node leaves `pendingId` alone.
    if (node.type !== 'heading') continue;

    if (node.depth === 2) {
      currentSection = { title: headingText(node), items: [] };
      sections.push(currentSection);
      pendingId = null;
      continue;
    }
    if (node.depth === 3) {
      // H3 without a section header above it is unusual but we
      // tolerate it by spawning an "Unsectioned" group.
      if (!currentSection) {
        currentSection = { title: '', items: [] };
        sections.push(currentSection);
      }
      if (pendingId && !pendingId.includes(':')) {
        currentSection.items.push({ id: pendingId, title: headingText(node) });
      }
      pendingId = null;
    }
  }

  return sections.map((section) => {
    if (section.items.length > 0) return section;
    // No anchored cards — offer the chapter itself, keyed on the slug
    // `headingComponents` puts on the rendered <h2>.
    const id = slugify(section.title) || 'section';
    return { title: '', items: [{ id, title: section.title }] };
  });
}
