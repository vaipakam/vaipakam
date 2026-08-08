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

// 2. The escape hatch must survive: a FENCED block documenting the
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

// 3. An unregistered knob must fall through to visible inline code
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
    `[check-live-value-render] FAILED — ${failures.length} of 4 checks\n${failures.join('\n')}\n`,
  );
  process.exit(1);
}

console.log(
  '[check-live-value-render] OK — inline tokens substitute, fenced blocks stay literal, unknown knobs stay visible',
);
