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

/** Render a markdown string through the real doc pipeline. */
function render(markdown: string): string {
  return renderToStaticMarkup(
    <ReactMarkdown components={markdownComponents() as never}>{markdown}</ReactMarkdown>,
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
  // LiveValue renders a <span title="…"> naming the value's provenance.
  check(
    'inline token emits live-value markup',
    /<span[^>]*title="[^"]*(Live value from on-chain|Compile-time default)/.test(html),
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
//    The fix distinguishes inline from fenced by structure: react-markdown
//    wraps block code in `<pre>` and leaves inline code bare. If that ever
//    fails to hold for some construct, tokens in it silently stop
//    resolving (or a code sample silently starts resolving) — the exact
//    class of failure #1606 was. A comment asserting "v10 always wraps
//    fenced blocks" is worth much less than a test, so every construct is
//    enumerated here, including INDENTED code blocks, which are block code
//    without any fence markers at all.
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

if (failures.length > 0) {
  console.error(
    `[check-live-value-render] FAILED — ${failures.length} of 15 checks\n${failures.join('\n')}\n`,
  );
  process.exit(1);
}

console.log(
  '[check-live-value-render] OK — 15 checks: inline tokens substitute across 7 constructs, block code stays literal across 3, unknown knobs stay visible, no internal props leak',
);
