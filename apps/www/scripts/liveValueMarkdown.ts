/**
 * Substitute `{liveValue:...}` tokens in RAW MARKDOWN, for the published
 * machine-readable docs (`/docs/*.md`, `llms-full.txt`).
 *
 * Build-only, which is why it lives under `scripts/` rather than `src/`:
 * it pulls in a markdown parser, and the browser bundle has no reason to.
 * The shared knob registry it formats through (`src/lib/liveValueKnobs.ts`)
 * stays dependency-free so both this and `LiveValue.tsx` can import it.
 *
 * Why a real parser instead of scanning lines (#1610 review round 4)
 * -----------------------------------------------------------------
 * The first version tracked fence state by hand — toggling on ``` / ~~~
 * and skipping 4-space-indented lines. Probing it found two real bugs:
 *
 *  1. A ``` line INSIDE a `~~~` block toggled the state off, so a token
 *     in that block got substituted. The escape hatch — a code sample
 *     documenting this very mechanism — silently broke.
 *  2. A 4-space-indented LIST CONTINUATION paragraph was mistaken for an
 *     indented code block, so its token was left raw. I had reasoned that
 *     erring this way was safe. It is not: a raw token in a published
 *     artifact IS the bug this whole change exists to fix.
 *
 * Both come from re-implementing block structure. The renderer never had
 * to: it receives already-parsed nodes and only ever sees inline code as
 * inline code. So this does the same thing — parse with the same
 * `remark-parse` react-markdown uses, and touch only `inlineCode` nodes.
 * Every block form (fenced, tilde-fenced, indented, nested in a list) is
 * excluded by construction rather than by a rule someone has to maintain.
 *
 * Replacements are applied by source OFFSET, from the end backwards, so
 * the document is edited in place. The alternative — stringifying the AST
 * — would reformat every published file wholesale, turning a fee update
 * into an unreviewable diff.
 */
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import { visit } from 'unist-util-visit';
import type { InlineCode } from 'mdast';
import {
  formatKnob,
  resolveLiveValue,
  LIVE_VALUE_TOKEN_RE,
  type KnobConfigSource,
} from '../src/lib/liveValueKnobs';

export function substituteLiveValuesInMarkdown(
  markdown: string,
  locale: string,
  config: KnobConfigSource | null = null,
): string {
  const tree = unified().use(remarkParse).parse(markdown);

  const edits: { start: number; end: number; text: string }[] = [];

  visit(tree, 'inlineCode', (node: InlineCode) => {
    const match = LIVE_VALUE_TOKEN_RE.exec(node.value);
    if (!match) return;

    // The snapshot the BUILD fetched, threaded in by the generator
    // (#1664 item 3). Passing `null` here — which this did until then —
    // wrote compile-time defaults into `/docs/*.md` and `llms-full.txt`
    // permanently: those artifacts are static files, so after a
    // governance retune they served the old rates indefinitely, even
    // across rebuilds, while the rendered page beside them showed the
    // new one under a `published` badge.
    //
    // `null` remains the honest answer when there is genuinely no
    // snapshot, and stays the default so unit tests and any other
    // caller keep the old behaviour rather than acquiring a network
    // dependency by accident.
    const r = resolveLiveValue(match[1], config);
    // An unregistered token is left exactly as written — same rule the
    // rendered pages follow, so an authoring typo stays visible on the
    // page instead of becoming a confidently wrong number.
    if (!r) return;

    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined) return;

    edits.push({ start, end, text: formatKnob(r.value, r.format, locale) });
  });

  // Descending, so each splice leaves earlier offsets valid.
  edits.sort((a, b) => b.start - a.start);

  let out = markdown;
  for (const { start, end, text } of edits) {
    out = out.slice(0, start) + text + out.slice(end);
  }
  return out;
}
