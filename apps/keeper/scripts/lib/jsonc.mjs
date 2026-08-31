/**
 * Reading a Wrangler config, in ONE place.
 *
 * Two readers of the same JSONC existed briefly — the tree-wide deploy guard's
 * and the keep_vars invariant's — and they disagreed about whether a comment
 * needs whitespace in front of it. That disagreement was a review finding
 * within a day (Codex #1995 r22): the guard rejected the valid config
 * `{"keep_vars": true}// preserve this setting`, whose comment Wrangler
 * accepts, and so reported a legitimate upload as destructive.
 *
 * The rules, which are JSONC's and not this repo's:
 *
 *   - Outside a string, a double slash starts a line comment and a slash-star
 *     pair starts a block one, with NO whitespace required before either.
 *     A closing brace followed immediately by a double slash is a comment.
 *   - Inside a string, both are DATA. A double slash in a URL is not a
 *     comment; truncating there leaves the config unparseable, which a caller
 *     then reports as a missing key — the wrong failure, pointing at the
 *     wrong fix.
 *   - A hash is NOT a JSONC comment and is left alone. TOML is a separate
 *     format and its callers scan it separately.
 */

/** JSONC text with its comments removed, strings preserved verbatim. */
export function stripJsonComments(raw) {
  let out = '';
  let quote = null;
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i];
    if (quote) {
      if (ch === '\\') {
        out += ch + (raw[i + 1] ?? '');
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === '/' && raw[i + 1] === '*') {
      const end = raw.indexOf('*/', i + 2);
      i = end === -1 ? raw.length : end + 2;
      continue;
    }
    if (ch === '/' && raw[i + 1] === '/') {
      while (i < raw.length && raw[i] !== '\n') i += 1;
      out += '\n';
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/**
 * Parse JSONC text. Trailing commas are tolerated, as Wrangler tolerates them.
 * Throws on genuinely malformed input, which callers should treat as "this
 * config says nothing" rather than as any particular setting.
 */
export function parseJsonc(raw) {
  // Wrangler accepts a leading UTF-8 BOM — verified against the pinned 4.90.0
  // with `deploy --dry-run` — but `JSON.parse` rejects it, so a config that
  // really does declare `keep_vars` read as unparseable. That fails BOTH
  // consumers the wrong way: the invariant reports the file unreadable and the
  // scanner reports a safe upload as destructive (#1995 r23). One strip here,
  // because one reader is the point of this module.
  return JSON.parse(
    stripJsonComments(raw.replace(/^\uFEFF/, '')).replace(/,(\s*[}\]])/g, '$1'),
  );
}
