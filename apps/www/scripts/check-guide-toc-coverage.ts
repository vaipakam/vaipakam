/**
 * Guardrail (#1599): every chapter a guide file declares must be
 * reachable from that guide's contents list.
 *
 *     pnpm --filter @vaipakam/www exec tsx scripts/check-guide-toc-coverage.ts
 *
 * The sibling `check-guide-anchor-parity.mjs` asks whether the ten
 * editions of a guide agree with each other. This asks something the
 * comparison cannot see, because it is true of the English original as
 * much as of any translation: is the chapter the reader is looking at
 * offered anywhere they would think to look for it?
 *
 * It was not. `## How VPFI Discounts Work` was printed on the live
 * English `/help/advanced` and appeared in NONE of that page's contents
 * links — the whole chapter was reachable only by scrolling past
 * everything above it. The cause was quiet: the contents builder ended
 * with `sections.filter((s) => s.items.length > 0)`, and that chapter's
 * two cards carry no `<a id>` anchors, so it had no items and was
 * dropped. Nothing failed. Nothing logged. The page just didn't mention
 * it.
 *
 * The builder now offers such a chapter as its own jump target, and
 * this check exists so the next one cannot go quiet the same way.
 *
 * It imports `extractToc` — the SAME function the page renders from —
 * rather than reimplementing it. A guard with its own copy of the rule
 * checks the copy, not the product, and would have happily agreed with
 * the bug.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { toString } from 'mdast-util-to-string';
import { extractToc } from '../src/lib/guideToc';

const GUIDE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'content',
  'userguide',
);

/** Chapter titles the FILE declares: root-level depth-2 headings. */
function declaredChapters(raw: string): string[] {
  return fromMarkdown(raw)
    .children.filter((node) => node.type === 'heading' && node.depth === 2)
    .map((node) => toString(node).trim());
}

/**
 * Every title the contents list puts in front of the reader — group
 * titles AND item titles. A chapter counts as reachable either way: as
 * a group heading with cards under it, or promoted to its own link.
 */
function offeredTitles(raw: string): Set<string> {
  const offered = new Set<string>();
  for (const section of extractToc(raw)) {
    if (section.title) offered.add(section.title);
    for (const item of section.items) offered.add(item.title);
  }
  return offered;
}

const problems: string[] = [];
const files = fs
  .readdirSync(GUIDE_DIR)
  .filter((f) => f.endsWith('.md'))
  .sort();

for (const file of files) {
  const raw = fs.readFileSync(path.join(GUIDE_DIR, file), 'utf8');
  const offered = offeredTitles(raw);
  for (const chapter of declaredChapters(raw)) {
    if (!offered.has(chapter)) {
      problems.push(
        `${file}: chapter "${chapter}" is rendered on the page but appears ` +
          'nowhere in its contents list — a reader can only reach it by scrolling',
      );
    }
  }
}

if (problems.length > 0) {
  console.error('[check-guide-toc-coverage] FAILED\n');
  for (const problem of problems) console.error(`  ${problem}`);
  console.error(
    '\nA chapter that is not in the contents list is, for most readers, not\n' +
      'there at all. Give the chapter cards a stable `<a id="…"></a>` anchor,\n' +
      'or check why `extractToc` is dropping it — do not silence this by\n' +
      'removing the chapter from the guide.',
  );
  process.exit(1);
}

console.log(
  `[check-guide-toc-coverage] OK — every chapter in ${files.length} guide ` +
    'file(s) is reachable from its contents list',
);
