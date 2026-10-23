/**
 * Content-Security-Policy script hashes, computed from the BUILT page
 * (#43 / ET-017).
 *
 * The app's policy allows scripts from its own origin only. `index.html`
 * also carries three small inline boot scripts (theme, language and
 * direction before first paint, and the splash's failure timer). Those
 * have to run before any bundle arrives, so they stay inline and are
 * allowed by their SHA-256 hash rather than by `'unsafe-inline'`, which
 * would allow any inline script at all, including an injected one.
 *
 * The hashes are computed from `dist/index.html` after Vite writes it,
 * never typed by hand and never computed from the source file. A browser
 * hashes the exact text it receives, so the only reliable input is the
 * page that ships. A hash list kept by hand would go stale on the first
 * edit to a boot script and block it in production with nothing failing
 * at build time.
 *
 * `_headers.base` carries {@link SCRIPT_HASHES_PLACEHOLDER} inside
 * `script-src`, and the build replaces it. A build that cannot do so
 * (placeholder missing or duplicated, page unreadable) FAILS rather than
 * shipping either a policy that blocks the boot scripts or one with the
 * placeholder left in.
 *
 * Pure functions here; the Vite plugin in `vite.config.ts` does the file
 * I/O. Covered by `src/lib/cspScriptHashes.test.ts`.
 */
import { createHash } from 'node:crypto';
import { parse } from 'parse5';

/** The token `_headers.base` carries where the hashes go. Not a valid CSP
 *  source expression, so a policy that somehow shipped with it unreplaced
 *  would allow no inline script, which is the safe direction. */
export const SCRIPT_HASHES_PLACEHOLDER = '__INLINE_SCRIPT_HASHES__';

/**
 * The text of every inline `<script>` element in `html`, in document
 * order. An element with a `src` attribute is not inline: `'self'`
 * covers it, and its body (if any) never runs.
 *
 * The page is read with parse5, which implements the WHATWG HTML parsing
 * algorithm browsers use. That matters twice over: the hash must be of
 * the exact text a browser takes as the script (after the parser's own
 * input normalisation, such as CRLF to LF), and the elements found must
 * be the ones a browser would find, whatever the spelling of a tag or an
 * end tag. A hand-written pattern answers both only for the markup its
 * author thought of. A `<template>`'s content is a separate fragment a
 * browser does not run, so it is not walked.
 *
 * @param {string} html
 * @returns {string[]}
 */
export function inlineScriptBodies(html) {
  const out = [];
  const walk = (node) => {
    if (node.nodeName === 'script' && !node.attrs.some((a) => a.name === 'src')) {
      out.push(node.childNodes.map((c) => (c.nodeName === '#text' ? c.value : '')).join(''));
    }
    for (const child of node.childNodes ?? []) walk(child);
  };
  walk(parse(html));
  return out;
}

/**
 * The CSP source expression that allows exactly `body`.
 *
 * @param {string} body
 * @returns {string}
 */
export function sha256Source(body) {
  return `'sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}'`;
}

/**
 * One source expression per distinct inline script in `html`.
 *
 * @param {string} html
 * @returns {string[]}
 */
export function scriptHashSources(html) {
  return [...new Set(inlineScriptBodies(html).map(sha256Source))];
}

/**
 * `headers` with the placeholder replaced by `sources` (space-joined, or
 * removed when there are none).
 *
 * Throws unless the placeholder occurs EXACTLY once: zero means the base
 * file and this step have drifted apart, and more than one means a rule
 * was duplicated. Either way the policy that would ship is not the one
 * that was reviewed.
 *
 * @param {string} headers
 * @param {string[]} sources
 * @returns {string}
 */
export function applyScriptHashes(headers, sources) {
  const count = headers.split(SCRIPT_HASHES_PLACEHOLDER).length - 1;
  if (count !== 1) {
    throw new Error(
      `[csp] expected ${SCRIPT_HASHES_PLACEHOLDER} exactly once in _headers, found ${count}`,
    );
  }
  // With nothing to allow, the placeholder goes together with the space
  // before it, so `'self' __X__;` becomes `'self';` and nothing else in
  // the file is touched.
  return sources.length > 0
    ? headers.replace(SCRIPT_HASHES_PLACEHOLDER, sources.join(' '))
    : headers.replace(new RegExp(`[ \\t]*${SCRIPT_HASHES_PLACEHOLDER}`), '');
}
