/**
 * The robots policy the app's `_headers` declares, as a list of
 * probes a live drive can check against the deployed site (#2089).
 *
 * The policy lives in one committed file, so the probes are DERIVED from it
 * rather than listed here: a route that gains or loses a noindex rule moves
 * the expectation with it. Each rule path is probed as written; a `/x/*`
 * rule is probed at `/x/1` (a concrete child) AND at `/x` (its parent),
 * because the two answer different questions — the child must carry the
 * header, while the parent carries only what its own rules give it. That
 * pairing is what the `/nft/1` versus `/nft` coverage row asks.
 *
 * Expected values follow Cloudflare's `_headers` semantics: every rule
 * whose path matches contributes, a splat matches any remainder (including
 * an empty one), and repeated headers are joined. Values are compared as
 * sets of directives, so `noindex, nofollow` and `nofollow,noindex` agree.
 *
 * Pure: no network, no browser. `robotsHeaders.test.mjs` covers it.
 */

/**
 * Parse `_headers` into rules. A rule is a path line at column 0 followed
 * by indented `Name: value` lines; `#` lines are comments.
 *
 * @param {string} text
 * @returns {{ path: string, headers: Array<[string, string]> }[]}
 */
export function parseHeadersFile(text) {
  const rules = [];
  let current = null;
  for (const raw of text.split(/\r?\n/)) {
    if (raw.trim() === '' || raw.trimStart().startsWith('#')) continue;
    if (!/^\s/.test(raw)) {
      current = { path: raw.trim(), headers: [] };
      rules.push(current);
      continue;
    }
    if (current === null) throw new Error(`header line before any path: ${raw.trim()}`);
    const at = raw.indexOf(':');
    if (at < 0) throw new Error(`malformed header line under ${current.path}: ${raw.trim()}`);
    current.headers.push([raw.slice(0, at).trim().toLowerCase(), raw.slice(at + 1).trim()]);
  }
  return rules;
}

/** Does a `_headers` path pattern match a request path? A `*` matches any
 *  run of characters, including none and including `/` (measured on the
 *  deployed app, recorded in `_headers`); a `:name` placeholder matches
 *  one non-empty path segment. */
export function pathMatches(pattern, path) {
  const source = pattern
    .split(/(\*|:[A-Za-z_][A-Za-z0-9_]*)/)
    .map((part) =>
      part === '*'
        ? '.*'
        : part.startsWith(':') && part.length > 1
          ? '[^/]+'
          : part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'),
    )
    .join('');
  return new RegExp(`^${source}$`).test(path);
}

/** A concrete value for each `:name` placeholder, so a rule can be probed
 *  at a real path. `locale` gets a locale the app serves aliases for; any
 *  other name gets a plain segment. */
const PLACEHOLDER_SAMPLE = Object.freeze({ locale: 'es' });
function concrete(pattern) {
  return pattern.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (_, name) => PLACEHOLDER_SAMPLE[name] ?? 'sample');
}

/** The directives of a robots value, lower-cased, as a sorted list. */
export function robotsDirectives(value) {
  if (value === null || value === undefined) return [];
  return [
    ...new Set(
      String(value)
        .split(',')
        .map((d) => d.trim().toLowerCase())
        .filter(Boolean),
    ),
  ].sort();
}

/** The robots directives the policy gives `path`: the union over every
 *  rule that matches it. */
export function expectedRobots(rules, path) {
  const values = rules
    .filter((r) => pathMatches(r.path, path))
    .flatMap((r) => r.headers.filter(([name]) => name === 'x-robots-tag').map(([, v]) => v));
  return robotsDirectives(values.join(','));
}

/**
 * The paths to probe, each with the directives it must carry (an empty list
 * means the response must carry no robots header at all).
 *
 * @returns {{ path: string, expected: string[], why: string }[]}
 */
export function robotsProbes(rules) {
  const seen = new Map();
  const add = (path, why) => {
    if (!seen.has(path)) seen.set(path, { path, expected: expectedRobots(rules, path), why });
  };
  add('/', 'the site root');
  for (const r of rules) {
    if (!r.headers.some(([name]) => name === 'x-robots-tag')) continue;
    const at = concrete(r.path);
    if (at.endsWith('/*')) {
      add(`${at.slice(0, -1)}1`, `a child of ${r.path}`);
      add(at.slice(0, -2), `the parent of ${r.path}, which that rule does not cover`);
    } else if (!at.includes('*')) {
      add(at, `the rule for ${r.path}`);
    }
  }
  return [...seen.values()];
}
