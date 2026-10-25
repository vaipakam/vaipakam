/**
 * Content-Security-Policy `connect-src`, completed at build time from the
 * origins the build actually talks to (#43 / ET-017).
 *
 * A policy that allows `connect-src https:` lets a script that got onto the
 * page send whatever it can read to any host on the internet. The lock is to
 * name the hosts the page itself fetches from. Those are build configuration
 * (the marketing site's indexer origin is `VITE_INDEXER_ORIGIN`), so typing
 * them into `_headers` by hand would drift from the bundle the first time a
 * preview or a deployment points elsewhere: the page would then be blocked
 * from its own data source with nothing failing at build time.
 *
 * So a surface's `_headers` source carries {@link CONNECT_SOURCES_PLACEHOLDER}
 * inside `connect-src`, and the build replaces it with the origins the build
 * configuration resolves, through {@link connectSource}, the same values the
 * bundle is compiled with. A build that cannot do so (placeholder missing,
 * duplicated or outside `connect-src`, an origin that is not a plain
 * `https:`/`wss:` origin) FAILS rather than shipping either a policy that
 * blocks the page's own reads or one with the placeholder left in.
 *
 * The same shape as `cspScriptHashes.mjs`, beside it. Covered by
 * `cspConnectSources.test.ts`.
 */
import fs from 'node:fs';
import path from 'node:path';

/** The token a `_headers` source carries where the origins go. Not a valid
 *  CSP source expression, so a policy that somehow shipped with it
 *  unreplaced would allow only `'self'`, which is the safe direction. */
export const CONNECT_SOURCES_PLACEHOLDER = '__CONNECT_SOURCES__';

const SCHEMES = new Set(['https:', 'wss:']);

/**
 * The CSP source for one configured endpoint: its origin (`scheme://host`,
 * with a port only when it is not the default), from any URL on it.
 *
 * Throws for anything a browser would not reach as that plain origin: a
 * scheme other than `https:` or `wss:`, credentials, a wildcard, or text
 * that is not a URL. A path is dropped on purpose: the policy names the
 * host the page may reach, and a host-source with a path would make a
 * fetch to a sibling route on the same host fail.
 *
 * @param {string} url
 * @returns {string}
 */
export function connectSource(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`[csp] connect-src: ${JSON.stringify(url)} is not a URL`);
  }
  if (!SCHEMES.has(u.protocol)) {
    throw new Error(`[csp] connect-src: ${JSON.stringify(url)} is not https: or wss:`);
  }
  if (u.username || u.password) {
    throw new Error(`[csp] connect-src: ${JSON.stringify(url)} carries credentials`);
  }
  if (u.hostname.includes('*')) {
    throw new Error(`[csp] connect-src: ${JSON.stringify(url)} is a wildcard, not an origin`);
  }
  return u.origin;
}

/** The directives of the one `Content-Security-Policy` line in `headers`,
 *  by name, in order. Throws unless there is exactly one such line. */
function policyDirectives(headers) {
  const lines = headers
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('Content-Security-Policy:'));
  if (lines.length !== 1) {
    throw new Error(`[csp] expected one Content-Security-Policy line in _headers, found ${lines.length}`);
  }
  const directives = new Map();
  for (const part of lines[0].slice('Content-Security-Policy:'.length).split(';')) {
    const [name, ...values] = part.trim().split(/\s+/);
    if (name) directives.set(name, values);
  }
  return directives;
}

/**
 * The `connect-src` sources of the one `Content-Security-Policy` line in a
 * `_headers` file. Throws unless there is exactly one such line and it has
 * a `connect-src`: a check against a policy it could not find would pass
 * for any page.
 *
 * @param {string} headers
 * @returns {string[]}
 */
export function policyConnectSources(headers) {
  const values = policyDirectives(headers).get('connect-src');
  if (!values) throw new Error('[csp] the Content-Security-Policy line has no connect-src');
  return values;
}

/**
 * `headers` with the placeholder replaced by `sources` (each passed through
 * {@link connectSource}, duplicates dropped, order kept).
 *
 * Throws unless the placeholder occurs exactly once and inside `connect-src`,
 * or when `sources` is empty: a surface with nothing to connect to beyond
 * its own origin has no business carrying the placeholder.
 *
 * @param {string} headers
 * @param {string[]} sources
 * @returns {string}
 */
export function applyConnectSources(headers, sources) {
  const count = headers.split(CONNECT_SOURCES_PLACEHOLDER).length - 1;
  if (count !== 1) {
    throw new Error(`[csp] expected ${CONNECT_SOURCES_PLACEHOLDER} exactly once in _headers, found ${count}`);
  }
  if (!policyConnectSources(headers).includes(CONNECT_SOURCES_PLACEHOLDER)) {
    throw new Error(`[csp] ${CONNECT_SOURCES_PLACEHOLDER} is outside connect-src`);
  }
  const origins = [...new Set(sources.map(connectSource))];
  if (origins.length === 0) throw new Error('[csp] connect-src: no origins to allow');
  return headers.replace(CONNECT_SOURCES_PLACEHOLDER, origins.join(' '));
}

/**
 * The Vite plugin a surface uses: after Vite writes the client output, it
 * writes `sources()` into the built `_headers` in place of the placeholder,
 * and fails the build rather than ship a policy it could not complete.
 *
 * `sources` is a function so the build resolves it from the same
 * environment the bundle is compiled with, at the moment it writes.
 *
 * An output directory with no `index.html` is left alone: the Cloudflare
 * plugin's worker environment writes none.
 *
 * @param {{ sources: () => string[], missingHeadersHint?: string }} options
 */
export function cspConnectSourcesPlugin(options) {
  return {
    name: 'vaipakam-csp-connect-sources',
    apply: 'build',
    writeBundle(output) {
      const outDir = output.dir;
      if (!outDir || !fs.existsSync(path.join(outDir, 'index.html'))) return;
      const headersFile = path.join(outDir, '_headers');
      if (!fs.existsSync(headersFile)) {
        this.error(
          `[csp] ${headersFile} is missing` + (options.missingHeadersHint ? `; ${options.missingHeadersHint}` : '.'),
        );
      }
      const headers = fs.readFileSync(headersFile, 'utf8');
      const completed = applyConnectSources(headers, options.sources());
      fs.writeFileSync(headersFile, completed);
      console.log(`[csp] connect-src allows ${policyConnectSources(completed).join(' ')}`);
    },
  };
}
