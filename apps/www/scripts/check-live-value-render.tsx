/**
 * Guard: `{liveValue:...}` doc tokens must render as live values, and
 * fenced code blocks must keep rendering them literally.
 *
 * Why this exists (#1606)
 * -----------------------
 * The token substitution silently died and nobody noticed. The `code`
 * interceptor in `src/lib/markdownToc.tsx` branched on react-markdown's
 * `inline` prop, which v9 removed and this app is on v10 — so the branch
 * never ran and every token in the docs rendered as literal text. A
 * reader saw `Yield Fee — {liveValue:treasuryFeeBps}%` on the marketing
 * site's overview page.
 *
 * Three things all failed to catch it, which is why the guard is a
 * server-render rather than a type or a lint rule:
 *
 *  - `tsc` cannot: the interceptor's props were typed locally as
 *    `inline?: boolean` alongside an index signature, so a prop that is
 *    never passed type-checks cleanly forever.
 *  - Lint cannot: nothing about the code is ill-formed.
 *  - The prerenderer would have, but it only runs during `deploy`, so a
 *    broken build reaches production before anything complains.
 *
 * So this renders the real pipeline — the actual `markdownComponents()`
 * against real `ReactMarkdown` — through `react-dom/server` and asserts
 * on the output. It is wired into `typecheck`, which CI runs, so the
 * failure is caught on the PR that causes it.
 *
 * Deliberately NOT a snapshot of rendered numbers: the whole point of
 * the component is that governance retunes those values, so asserting
 * on `2%` would make this file fail every time a knob changes. It
 * asserts on the SHAPE — token consumed, live-value markup emitted —
 * which is the property that broke.
 */
// Two JSX accommodations are needed, for two different files:
//
//  - The imported APP source (`markdownToc.tsx`, `LiveValue.tsx`) is
//    written for the automatic runtime, so this must run as
//    `tsx --tsconfig tsconfig.app.json` — that config carries
//    `jsx: react-jsx`. Without it the app's own JSX throws
//    "React is not defined" from inside `markdownToc.tsx`.
//  - THIS file lives in `scripts/`, outside that config's `include`, so
//    it still gets the classic transform and needs `React` in scope.
//
// Both are required; dropping either one breaks a different half.
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import { markdownComponents } from '../src/lib/markdownToc';
import { substituteLiveValuesInMarkdown } from './liveValueMarkdown';
import { KNOB_DEFAULTS, formatKnob } from '../src/lib/liveValueKnobs';

/** Render a markdown string through the real doc pipeline. */
function render(markdown: string): string {
  return renderToStaticMarkup(
    <ReactMarkdown components={markdownComponents('en') as never}>{markdown}</ReactMarkdown>,
  );
}

/** Render with an explicit components map (a given document locale). */
function renderWith(components: ReturnType<typeof markdownComponents>, markdown: string): string {
  return renderToStaticMarkup(
    <ReactMarkdown components={components as never}>{markdown}</ReactMarkdown>,
  );
}

/*
 * Locale-convention oracles, deliberately INDEPENDENT of `formatKnob`
 * (#1610 review round 7).
 *
 * The locale checks used to compare output against `formatKnob`'s own
 * result. That removed a false-failure risk — a knob retune no longer
 * breaks them — but introduced a tautology in the dimension that
 * matters: if the formatter SWAPPED German and English conventions,
 * actual and expected would move together and the "the two differ"
 * clause would still hold. The bug the checks exist to prevent is
 * precisely a locale being given the wrong convention.
 *
 * These ask `Intl` what a locale's separators ARE, from the locale tag
 * alone, and never call the formatter. A formatter that hands German
 * output English grouping now fails, because the oracle knows German
 * groups with "." regardless of what the formatter did.
 */
/**
 * The rendered FIGURE, extracted from the markup by matching a numeric
 * run — not by stripping tags.
 *
 * Two reasons it is a targeted match rather than a tag strip:
 *
 *  - Separator assertions must not see surrounding markup. The inline
 *    style contains `var(--text-muted, #888)`, and that comma alone made
 *    an "output must not contain the English separator" check fail
 *    against correct German output.
 *  - A `replace(/<[^\>]*>/g, '')` tag strip is an incomplete sanitizer
 *    (CodeQL flags it, correctly): one pass over `<<script>script>`
 *    leaves `<script>`. Nothing here is user input and the result is only
 *    compared against separator characters, so there was no exploit — but
 *    a helper that LOOKS like a sanitizer invites reuse where the input
 *    is hostile. Matching what we want is both safer and more precise.
 *
 * The character class covers the separators these locales actually use,
 * including the narrow no-break space French groups with and Arabic-Indic
 * digits, so a figure is not silently truncated to "".
 */
function renderedFigure(html: string): string {
  const m = html.match(/>([\d\u0660-\u0669\u00A0\u202F.,\u066B\u066C]+)</);
  return m ? m[1] : '';
}

function groupSeparator(locale: string): string {
  return (
    new Intl.NumberFormat(locale).formatToParts(1000).find((p) => p.type === 'group')?.value ?? ''
  );
}

function decimalSeparator(locale: string): string {
  return (
    new Intl.NumberFormat(locale).formatToParts(1.5).find((p) => p.type === 'decimal')?.value ?? ''
  );
}

const failures: string[] = [];
function check(name: string, ok: boolean, detail: string) {
  if (ok) return;
  failures.push(`  ✗ ${name}\n      ${detail}`);
}

// 1. The core regression: an inline token must be consumed, not printed.
{
  const html = render('Yield Fee — `{liveValue:treasuryFeeBps}`% of the interest.');
  check(
    'inline token is substituted',
    !html.includes('liveValue:'),
    `the raw token survived into the output — this is the #1606 failure:\n      ${html}`,
  );
  // LiveValue marks its span with `data-live-value="<knob>"`. Assert on
  // that rather than on the tooltip copy: the tooltip is prose for a
  // human and gets reworded (it did in #1612), and a structural check
  // that breaks when copy changes is checking the wrong thing.
  check(
    'inline token emits live-value markup',
    /<span[^>]*data-live-value="treasuryFeeBps"/.test(html),
    `no LiveValue span found; the token was consumed but nothing replaced it:\n      ${html}`,
  );
}

// 2. No internal react-markdown prop may reach the DOM. v10 hands every
//    custom renderer its HAST `node`; spreading it onto an element makes
//    React serialise `node="[object Object]"`. That shipped on 5,728
//    inline-code elements before #1606 caught it, so it is asserted here
//    rather than trusted to review.
{
  const html = render('Inline `code`, a token `{liveValue:treasuryFeeBps}`, and:\n\n```\nfenced\n```');
  check(
    'no internal node prop reaches the DOM',
    !html.includes('node="'),
    `an internal prop leaked into the markup:\n      ${html}`,
  );
}

// 3. The escape hatch must survive: a FENCED block documenting the
//    mechanism has to render literally, or the docs cannot describe
//    their own tooling.
{
  const html = render('```\n{liveValue:treasuryFeeBps}\n```');
  check(
    'fenced block keeps the token literal',
    html.includes('liveValue:treasuryFeeBps'),
    `the fenced token was substituted; the escape hatch is broken:\n      ${html}`,
  );
}

// 4. The LOAD-BEARING assumption, asserted across every construct that
//    produces a `<code>` element.
//
//    The renderer asks ONE question — is this span exactly one live-value
//    token — and the token pattern is ANCHORED. That is what keeps code
//    samples literal: block code always arrives with a trailing newline,
//    which an anchored pattern cannot match, while inline code never
//    does. Nothing re-derives "is this span inline"; stating that fact
//    twice is how the original bug happened.
//
//    So the anchors are load-bearing rather than cosmetic. Unanchor the
//    pattern and fenced samples silently start resolving; that is the
//    same class of silent failure #1606 was. A comment claiming the
//    property is worth much less than a test of it, so every construct
//    is enumerated here — including INDENTED blocks, which are block code
//    with no fence markers at all.
{
  const constructs: [string, string, 'literal' | 'substituted'][] = [
    ['fenced, no language', '```\n{liveValue:treasuryFeeBps}\n```', 'literal'],
    ['fenced, with language', '```js\n{liveValue:treasuryFeeBps}\n```', 'literal'],
    ['indented code block', '    {liveValue:treasuryFeeBps}', 'literal'],
    ['inline in paragraph', 'fee `{liveValue:treasuryFeeBps}` here', 'substituted'],
    ['inline in list item', '- fee `{liveValue:treasuryFeeBps}` here', 'substituted'],
    ['inline in blockquote', '> fee `{liveValue:treasuryFeeBps}` here', 'substituted'],
    ['inline in heading', '## fee `{liveValue:treasuryFeeBps}`', 'substituted'],
    ['inline in table cell', '| a |\n|---|\n| `{liveValue:treasuryFeeBps}` |', 'substituted'],
    ['inline in bold', '**`{liveValue:treasuryFeeBps}`**', 'substituted'],
    ['inline in link text', '[`{liveValue:treasuryFeeBps}`](https://example.com)', 'substituted'],
  ];
  for (const [name, markdown, expected] of constructs) {
    const html = render(markdown);
    const actual = html.includes('liveValue:') ? 'literal' : 'substituted';
    check(
      `${name} renders ${expected}`,
      actual === expected,
      `got ${actual}; the inline-vs-block signal does not hold for this construct:\n      ${html}`,
    );
  }
}

// 5. An unregistered knob must fall through to visible inline code
//    rather than rendering a silently wrong value.
{
  const html = render('Typo: `{liveValue:treasuryFeebps}`.');
  check(
    'unknown knob stays visible',
    html.includes('liveValue:treasuryFeebps'),
    `an unregistered knob vanished instead of rendering visibly:\n      ${html}`,
  );
}

// 6. The MARKDOWN path, published to /docs/*.md and llms-full.txt and
//    advertised to AI crawlers by llms.txt. Fixing only the React
//    pipeline left 420 raw tokens in these artifacts (#1606 review), so
//    the second substituter gets the same scrutiny as the first —
//    including that the two agree, since they read one shared registry.
{
  const md = (text: string, locale = 'en') => substituteLiveValuesInMarkdown(text, locale);

  check(
    'markdown: inline token is substituted',
    !md('Yield Fee — `{liveValue:treasuryFeeBps}`% of interest.').includes('liveValue:'),
    `raw token survived: ${md('Yield Fee — `{liveValue:treasuryFeeBps}`%')}`,
  );
  // Block-vs-inline in raw markdown, across every construct probed.
  //
  // The first implementation tracked fence state by hand and got two of
  // these wrong: a ``` line inside a ~~~ block closed the block (so a
  // documented code sample got substituted), and a 4-space list
  // continuation was mistaken for an indented code block (so its token
  // stayed raw in the published artifact — the original bug). Parsing
  // with remark and touching only `inlineCode` nodes excludes every
  // block form by construction; these cases pin that.
  const T = '`{liveValue:treasuryFeeBps}`';
  const blockCases: [string, string, 'literal' | 'substituted'][] = [
    ['fenced', `\`\`\`\n${T}\n\`\`\``, 'literal'],
    ['fenced with info string', `\`\`\`js title="x"\n${T}\n\`\`\``, 'literal'],
    ['fence indented 3 spaces', `   \`\`\`\n   ${T}\n   \`\`\``, 'literal'],
    ['fence inside a list item', `- item\n\n  \`\`\`\n  ${T}\n  \`\`\``, 'literal'],
    ['tilde fence containing backticks', `~~~\n\`\`\`\n${T}\n~~~`, 'literal'],
    ['plain indented code block', `paragraph\n\n    ${T}`, 'literal'],
    ['4-space list continuation', `- item\n\n    ${T}`, 'substituted'],
    ['after a closed fence', `\`\`\`\ncode\n\`\`\`\n\nfee ${T}`, 'substituted'],
    ['between two fences', `\`\`\`\na\n\`\`\`\n\nfee ${T}\n\n\`\`\`\nb\n\`\`\``, 'substituted'],
    ['blockquote', `> fee ${T}`, 'substituted'],
    ['nested list', `- a\n  - fee ${T}`, 'substituted'],
    ['heading', `## fee ${T}`, 'substituted'],
    ['table row', `| a |\n|---|\n| ${T} |`, 'substituted'],
  ];
  for (const [name, markdown, expected] of blockCases) {
    const actual = md(markdown).includes('liveValue:') ? 'literal' : 'substituted';
    check(
      `markdown: ${name} renders ${expected}`,
      actual === expected,
      `got ${actual} — block/inline detection is wrong for this construct`,
    );
  }

  check(
    'markdown: unknown knob is left alone',
    md('`{liveValue:treasuryFeebps}`').includes('liveValue:treasuryFeebps'),
    'an unregistered knob was altered instead of left visible',
  );
  // The formatting bug that made this locale-aware: en-US grouping on a
  // German page turns a 20,000-token threshold into something a German
  // reader parses as twenty.
  // The VALUE comes from the registry so a knob retune doesn't fail these,
  // but the CONVENTION is checked against `Intl` directly rather than
  // against the formatter — see the oracle comment above for why calling
  // `formatKnob` here made a locale-swap bug invisible.
  const deCount = md('`{liveValue:tier4Min}`', 'de');
  const enCount = md('`{liveValue:tier4Min}`', 'en');
  check(
    'markdown: grouping follows the document locale',
    deCount.includes(groupSeparator('de')) &&
      !deCount.includes(groupSeparator('en')) &&
      enCount.includes(groupSeparator('en')) &&
      !enCount.includes(groupSeparator('de')),
    `de gave "${deCount}" (expected "${groupSeparator('de')}" grouping), ` +
      `en gave "${enCount}" (expected "${groupSeparator('en')}")`,
  );

  const frPct = md('`{liveValue:loanInitiationFeeBps}`', 'fr');
  const enPct = md('`{liveValue:loanInitiationFeeBps}`', 'en');
  check(
    'markdown: decimal separator follows the document locale',
    frPct.includes(decimalSeparator('fr')) &&
      !frPct.includes(decimalSeparator('en')) &&
      enPct.includes(decimalSeparator('en')) &&
      !enPct.includes(decimalSeparator('fr')),
    `fr gave "${frPct}" (expected "${decimalSeparator('fr')}" decimal), ` +
      `en gave "${enPct}" (expected "${decimalSeparator('en')}")`,
  );
  // NOTE: there is deliberately no "formatting follows the active UI
  // language" check here any more. That assertion existed in an earlier
  // round and it encoded a BUG: `Whitepaper` and `AdminKnobsDocs` always
  // render the English source, so on /de/help/technical the UI language
  // is German while the document is English. Formatting must follow the
  // DOCUMENT — asserted in section 7.

  // Both substituters read KNOB_DEFAULTS, so a divergence means someone
  // reintroduced a second source of truth.
  const rendered = render('`{liveValue:treasuryFeeBps}`');
  check(
    'markdown and rendered paths agree',
    rendered.includes(md('`{liveValue:treasuryFeeBps}`')),
    `rendered HTML did not contain the markdown substitution "${md('`{liveValue:treasuryFeeBps}`')}"`,
  );
}

// 7. The DOCUMENT locale, not the UI locale (#1610 review round 5).
//
//    `Whitepaper` and `AdminKnobsDocs` always resolve the .en.md source,
//    so on /de/help/technical the prose is English. Formatting embedded
//    values with the route's language put German grouping inside English
//    sentences, and Arabic-Indic digits on an Arabic route. The renderer
//    now takes the document locale explicitly; these pin that it is
//    honoured and that the UI language cannot override it.
{
  const en = markdownComponents('en');
  const de = markdownComponents('de');
  // Same independent-oracle treatment as the markdown path: the
  // convention is checked against Intl, never against the formatter.
  const enHtml = renderedFigure(renderWith(en, '`{liveValue:tier4Min}`'));
  const deHtml = renderedFigure(renderWith(de, '`{liveValue:tier4Min}`'));
  check(
    'document locale is honoured over the active language',
    enHtml.includes(groupSeparator('en')) && !enHtml.includes(groupSeparator('de')),
    `an English document used "${groupSeparator('de')}" grouping: ${enHtml}`,
  );
  check(
    'a German document still formats as German',
    deHtml.includes(groupSeparator('de')) && !deHtml.includes(groupSeparator('en')),
    `a German document used "${groupSeparator('en')}" grouping: ${deHtml}`,
  );
  check(
    'components are memoized per locale',
    markdownComponents('en') === en && markdownComponents('de') === de && en !== de,
    'markdownComponents did not return a stable per-locale object',
  );
}

// 8. The search index must hold what the reader can see, in the locale
//    the reader sees it — otherwise searching visible text cannot find
//    its own page. It reads the same registry, so this also asserts the
//    third copy of the defaults is gone.
{
  // The index formats through the same registry the pages do, so assert
  // the same property with the same independent oracle rather than
  // comparing the formatter to itself.
  const deTier4 = formatKnob(KNOB_DEFAULTS.tier4Min.defaultValue, 'count', 'de');
  const enTier4 = formatKnob(KNOB_DEFAULTS.tier4Min.defaultValue, 'count', 'en');
  check(
    'search formatting follows each indexed document\'s locale',
    deTier4.includes(groupSeparator('de')) &&
      !deTier4.includes(groupSeparator('en')) &&
      enTier4.includes(groupSeparator('en')),
    `de gave "${deTier4}", en gave "${enTier4}"`,
  );
}

if (failures.length > 0) {
  console.error(
    `[check-live-value-render] FAILED — ${failures.length} of 37 checks\n${failures.join('\n')}\n`,
  );
  process.exit(1);
}

console.log(
  '[check-live-value-render] OK — 37 checks: inline tokens substitute across 7 constructs, block code stays literal across 3, unknown knobs stay visible, no internal props leak, and the published-markdown path matches the rendered one',
);
