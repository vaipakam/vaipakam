/**
 * Content-Security-Policy script hashes, computed from the BUILT pages
 * (#43 / ET-017). One implementation for both web surfaces: the connected
 * app (`apps/app`) and the marketing site (`apps/www`).
 *
 * Each surface's policy allows scripts from its own origin only. Its
 * `index.html` also carries small inline boot scripts (theme, language and
 * direction before first paint, and on the app the splash's failure timer).
 * Those have to run before any bundle arrives, so they stay inline and are
 * allowed by their SHA-256 hash rather than by `'unsafe-inline'`, which
 * would allow any inline script at all, including an injected one.
 *
 * The hashes are computed from the page Vite writes, never typed by hand and
 * never computed from the source file. A browser hashes the exact text it
 * receives, so the only reliable input is the page that ships. A hash list
 * kept by hand would go stale on the first edit to a boot script and block
 * it in production with nothing failing at build time.
 *
 * Each surface's `_headers` source carries {@link SCRIPT_HASHES_PLACEHOLDER}
 * inside `script-src`, and the build replaces it. A build that cannot do so
 * (placeholder missing or duplicated, page unreadable) FAILS rather than
 * shipping either a policy that blocks the boot scripts or one with the
 * placeholder left in.
 *
 * A page written after the build (the marketing site's prerendered
 * snapshots) is checked against the completed policy with
 * {@link uncoveredScripts}, so a snapshot carrying an inline script the
 * policy does not allow fails its step instead of shipping blocked.
 *
 * Covered by `cspScriptHashes.test.ts` beside this file.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'parse5';

/** The token a `_headers` source carries where the hashes go. Not a valid
 *  CSP source expression, so a policy that somehow shipped with it
 *  unreplaced would allow no inline script, which is the safe direction. */
export const SCRIPT_HASHES_PLACEHOLDER = '__INLINE_SCRIPT_HASHES__';

/** The JavaScript MIME type essences of the HTML standard. A `type` equal to
 *  one of these (ignoring ASCII case and surrounding whitespace) runs as a
 *  classic script. */
const JAVASCRIPT_MIME_TYPES = new Set([
  'application/ecmascript',
  'application/javascript',
  'application/x-ecmascript',
  'application/x-javascript',
  'text/ecmascript',
  'text/javascript',
  'text/javascript1.0',
  'text/javascript1.1',
  'text/javascript1.2',
  'text/javascript1.3',
  'text/javascript1.4',
  'text/javascript1.5',
  'text/jscript',
  'text/livescript',
  'text/x-ecmascript',
  'text/x-javascript',
]);

/** The other `type` values a browser runs, and checks against `script-src`:
 *  module scripts, import maps and speculation rules. */
const OTHER_RUN_TYPES = new Set(['module', 'importmap', 'speculationrules']);

/**
 * Whether a browser runs a `<script>` with these attributes, and so checks
 * it against `script-src`. This follows the HTML standard's "prepare the
 * script element" steps: no `type` (or an empty one, or `language` alone)
 * is a classic script, and so is a JavaScript MIME type; `module`,
 * `importmap` and `speculationrules` run too. Anything else is a data
 * block, such as the marketing site's `application/ld+json`, which a
 * browser never runs and the policy does not govern.
 *
 * @param {{ name: string, value: string }[]} attrs
 * @returns {boolean}
 */
function isRunnable(attrs) {
  const get = (n) => attrs.find((a) => a.name === n)?.value;
  const type = get('type');
  const language = get('language');
  let kind;
  if (type === undefined) {
    // `language` stands in for `type` only when it is non-empty.
    if (language === undefined || language === '') return true;
    kind = `text/${language}`;
  } else if (type === '') {
    return true;
  } else {
    kind = type;
  }
  kind = kind.trim().toLowerCase();
  return JAVASCRIPT_MIME_TYPES.has(kind) || OTHER_RUN_TYPES.has(kind);
}

/**
 * The text of every inline `<script>` element in `html` that a browser
 * would run, in document order. An element with a `src` attribute is not
 * inline: `'self'` covers it, and its body (if any) never runs. A data
 * block (see {@link isRunnable}) never runs either, so it needs no hash.
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
    if (
      node.nodeName === 'script' &&
      !node.attrs.some((a) => a.name === 'src') &&
      isRunnable(node.attrs)
    ) {
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
 * Throws unless the placeholder occurs EXACTLY once: zero means the source
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

/**
 * The `script-src` sources of the one `Content-Security-Policy` line in a
 * `_headers` file.
 *
 * Throws unless there is exactly one such line and it has a `script-src`:
 * a check against a policy it could not find would pass for any page.
 *
 * @param {string} headers
 * @returns {string[]}
 */
export function policyScriptSources(headers) {
  const lines = headers
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('Content-Security-Policy:'));
  if (lines.length !== 1) {
    throw new Error(`[csp] expected one Content-Security-Policy line in _headers, found ${lines.length}`);
  }
  for (const part of lines[0].slice('Content-Security-Policy:'.length).split(';')) {
    const [name, ...values] = part.trim().split(/\s+/);
    if (name === 'script-src') return values;
  }
  throw new Error('[csp] the Content-Security-Policy line has no script-src');
}

/**
 * The inline scripts in `html` that `allowed` (a `script-src` source list)
 * does not allow by hash: each one a browser would refuse to run under that
 * policy.
 *
 * @param {string} html
 * @param {string[]} allowed
 * @returns {string[]}
 */
export function uncoveredScripts(html, allowed) {
  const set = new Set(allowed);
  return inlineScriptBodies(html).filter((b) => !set.has(sha256Source(b)));
}

/** `file`'s text, or `null` when it does not exist (any other error throws). */
function readIfPresent(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return null;
    throw e;
  }
}

/**
 * The Vite plugin both surfaces use: after Vite writes the client output
 * (the public directory, and so `_headers`, is in place by then), it hashes
 * the inline scripts of the BUILT `index.html` and writes them into the
 * built `_headers` in place of the placeholder, and it fails the build
 * rather than ship a policy it could not complete.
 *
 * An output directory with no `index.html` is left alone: the Cloudflare
 * plugin's worker environment writes none.
 *
 * @param {{ missingHeadersHint?: string }} [options] what to tell the
 *   builder when `_headers` is absent from the output.
 */
export function cspScriptHashesPlugin(options = {}) {
  return {
    name: 'vaipakam-csp-script-hashes',
    apply: 'build',
    writeBundle(output) {
      const outDir = output.dir;
      if (!outDir) return;
      // Each file is read once and its absence handled from that read, so
      // what is hashed and rewritten is exactly what was read.
      const page = readIfPresent(path.join(outDir, 'index.html'));
      if (page === null) return;
      const headersFile = path.join(outDir, '_headers');
      const headers = readIfPresent(headersFile);
      if (headers === null) {
        this.error(
          `[csp] ${headersFile} is missing` +
            (options.missingHeadersHint ? `; ${options.missingHeadersHint}` : '.'),
        );
      }
      const sources = scriptHashSources(page);
      fs.writeFileSync(headersFile, applyScriptHashes(headers, sources));
      console.log(`[csp] script-src allows ${sources.length} inline script hash(es)`);
    },
  };
}
