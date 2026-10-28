/**
 * Where a Markdown document can cite a path, read the way a CommonMark
 * renderer reads it (#1486).
 *
 * Built for the docs path gate (`.github/scripts/check-docs-paths.mjs`,
 * through `.github/scripts/docs-citations.mjs`). That gate used to find links
 * and code spans with regular expressions, which offered fragments that were
 * not citations at all: #1467's review found six such extraction defects in
 * eleven rounds (angle-bracket destinations with spaces, titled destinations,
 * reference definitions, destinations on the following line, two title
 * separators). Any rule that reports what it cannot resolve turns each of
 * those into a false alarm, so the rule "the cited path exists" waited for a
 * real parser. This is that parser's reading, and nothing more.
 *
 * It parses with micromark through `mdast-util-from-markdown`, with GFM
 * (tables, autolink literals, footnotes), which is what GitHub renders these
 * documents with, and returns three kinds of citation site:
 *
 *   - `destination` — the destination of a link, an image or a link
 *     reference definition, exactly as the parser resolved it (escapes and
 *     character references decoded, angle brackets and title removed). An
 *     autolink is a link too, so a URL appears here with its scheme.
 *   - `code-span`   — the content of one inline code span.
 *   - `code-line`   — one line of a fenced or indented code block.
 *
 * Raw HTML is not read: a comment, an `<a href>` and a `<!-- … -->` block are
 * all skipped, as they were before.
 *
 * WHAT IT DOES NOT DO. It does not decide whether a site cites a repository
 * path, or whether that path exists. The gate does.
 */
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';

/**
 * Every citation site in `source`, in document order.
 *
 * @param {string} source
 * @returns {Array<{ kind: 'destination' | 'code-span' | 'code-line', value: string, line: number }>}
 *          `line` is 1-based: the line the node starts on, and for a code
 *          block the line that holds that line of code.
 */
export function markdownCitations(source) {
  const tree = fromMarkdown(source, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });
  const out = [];
  const walk = (node) => {
    const line = node.position?.start.line ?? 1;
    if (node.type === 'link' || node.type === 'image' || node.type === 'definition') {
      out.push({ kind: 'destination', value: node.url, line });
    } else if (node.type === 'inlineCode') {
      out.push({ kind: 'code-span', value: node.value, line });
    } else if (node.type === 'code') {
      // A fenced block's first line is its opening fence; an indented block
      // starts on its first line of code.
      const first = line + (isFenced(source, node) ? 1 : 0);
      node.value.split('\n').forEach((value, i) => out.push({ kind: 'code-line', value, line: first + i }));
    }
    for (const child of node.children ?? []) walk(child);
  };
  walk(tree);
  return out;
}

/** Whether a `code` node opened with a fence rather than an indent. */
function isFenced(source, node) {
  const start = node.position?.start.offset;
  if (start === undefined) return false;
  return /^ {0,3}(`{3,}|~{3,})/.test(source.slice(start, source.indexOf('\n', start) + 1 || undefined));
}
