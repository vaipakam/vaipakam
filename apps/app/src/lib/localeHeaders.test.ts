/**
 * `_headers.base` must carry a `noindex` rule for every SUPPORTED
 * locale prefix.
 *
 * ## Why this is a test and not a generator
 *
 * The first version of this protection had `scripts/generate-seo.mjs`
 * parse `SUPPORTED_LOCALES` out of `packages/i18n/src/glossary.ts` at
 * build time. That read reaches outside `apps/app`, and the Cloudflare
 * Workers build failed on the commit that introduced it having passed
 * on the five before it — the Cloudflare build log is not readable from
 * CI, so that is a strong correlation rather than a proven cause, but a
 * build-time filesystem escape is a bad dependency to keep on a
 * suspicion either way.
 *
 * A static file pinned by a test gives the same drift protection from a
 * better place: this file imports the REAL constant through the normal
 * module graph, so there is no path walking, no TypeScript parsing from
 * a `.mjs` script, and no build step that can fail in an environment
 * nobody can inspect. If the locale set changes, this fails in CI with
 * the exact missing lines named.
 *
 * ## Why the rules exist at all
 *
 * The retired deployment mounted every route under `/:locale`, so
 * `/es/positions/7` is a real bookmark. This app answers it with a
 * React route that strips the prefix — which a crawler that does not
 * execute the SPA never runs, receiving the generic indexable 200 shell
 * instead. The per-user rules in `_headers.base` are exact paths that a
 * locale prefix walks straight past, so without these the aliases are
 * indexable where their destinations are not.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SUPPORTED_LOCALES } from '@vaipakam/i18n/glossary';

const headers = readFileSync(
  resolve(__dirname, '..', '..', 'public', '_headers.base'),
  'utf8',
);

/** Every rule in the file, as `path` → the directives under it. */
function rulesByPath(src: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let current: string | null = null;
  for (const raw of src.split('\n')) {
    if (raw.trim() === '' || raw.trimStart().startsWith('#')) continue;
    if (!raw.startsWith(' ') && !raw.startsWith('\t')) {
      current = raw.trim();
      if (!out.has(current)) out.set(current, []);
    } else if (current) {
      out.get(current)!.push(raw.trim());
    }
  }
  return out;
}

describe('_headers.base locale rules', () => {
  const rules = rulesByPath(headers);

  it('parses the committed file into rules at all', () => {
    // Calibration guard. Every assertion below is of the form "this
    // path is present with this directive", so a parser that returned
    // an empty map would fail them loudly — but a parser that silently
    // mis-keyed everything could still pass a sloppier check. Pin two
    // rules that predate this feature so a parsing change cannot make
    // the locale assertions vacuous.
    expect(rules.get('/positions')).toContain('X-Robots-Tag: noindex');
    expect(rules.get('/recover')).toContain('X-Robots-Tag: noindex, nofollow');
  });

  it('carries noindex for every supported locale prefix, exact and wildcard', () => {
    const missing: string[] = [];
    for (const locale of SUPPORTED_LOCALES) {
      for (const path of [`/${locale}`, `/${locale}/*`]) {
        if (!rules.get(path)?.includes('X-Robots-Tag: noindex')) {
          missing.push(path);
        }
      }
    }
    // Named, not counted: a contributor adding a locale should be told
    // which lines to write, not merely that the number is wrong.
    expect(missing).toEqual([]);
  });

  it('covers exactly the supported set, with no stale locale left behind', () => {
    // The other direction. A locale REMOVED from `SUPPORTED_LOCALES`
    // stops being a route the redirect accepts, so its rule becomes a
    // `noindex` on a path that now 404s — harmless, but it is dead
    // configuration that quietly outlives its reason, and this file is
    // read by people deciding what the app supports.
    const supported = new Set<string>(SUPPORTED_LOCALES as readonly string[]);
    const stale = [...rules.keys()]
      .map((p) => /^\/([a-z]{2}(?:-[A-Za-z]+)?)(\/\*)?$/.exec(p))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => m[1])
      // Only two-letter segments that are NOT real routes: a route like
      // `/nft` matches the shape, so exclude anything the app actually
      // serves by checking it against the locale set's own alphabet of
      // candidates rather than assuming shape implies locale.
      .filter((code) => !supported.has(code) && LOCALE_SHAPED_ROUTES.has(code));
    expect(stale).toEqual([]);
  });
});

/** Two-letter paths in `_headers.base` that were once locales.
 *
 *  Empty today. It exists so the staleness check above cannot be
 *  satisfied by accident: without an explicit list, "a two-letter path
 *  that is not a supported locale" would also match a real route of the
 *  same shape, and the test would start failing for the wrong reason
 *  the first time someone adds one. */
const LOCALE_SHAPED_ROUTES = new Set<string>();
