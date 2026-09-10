/**
 * The `_headers.base` guarantees that keep locale-prefixed bookmarks out
 * of the index — and the rule budget that constrains how they are
 * written.
 *
 * ## Why the rules exist
 *
 * The retired deployment mounted every route under `/:locale`, so
 * `/es/positions/7` is a real bookmark. This app answers it with a React
 * route that strips the prefix — which a crawler that does not execute
 * the SPA never runs, receiving the generic indexable 200 shell instead.
 * The per-user rules in `_headers.base` are exact paths that a locale
 * prefix walks straight past, so without a locale rule those aliases are
 * indexable where their destinations are not.
 *
 * ## Why ONE rule, and why this file has to police it
 *
 * `_headers` accepts at most 100 rules (documented). Enumerating the 34
 * supported locales as `/xx` + `/xx/*` pairs took the file from 59 rules
 * to 127, and the Cloudflare Workers build failed on both commits that
 * did so, having passed on every commit before them. The build log is
 * not readable from CI, so that is a correlation plus documented
 * arithmetic rather than a log line — which is exactly why the budget is
 * asserted here instead of being left to be rediscovered the same
 * opaque way.
 *
 * A single `/:locale/*` placeholder covers every locale-prefixed deep
 * path, and never grows when a locale is added.
 *
 * ## What makes the single rule SAFE, and what this file really pins
 *
 * `/:locale/*` matches any first segment followed by more path — so it
 * would suppress a public page too, if this app had one at a nested URL.
 * It does not: every URL in the generated sitemap is single-segment. The
 * sitemap assertion below is therefore the load-bearing one. If someone
 * later adds a public nested route and lists it, that rule would quietly
 * withhold it from search, and this test fails first.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const appDir = resolve(__dirname, '..', '..');
const publicDir = resolve(appDir, 'public');
const headers = readFileSync(resolve(publicDir, '_headers.base'), 'utf8');

/** The sitemap, generating it first if this checkout has not built.
 *
 *  `public/sitemap.xml` is a BUILD ARTIFACT and gitignored, so it is
 *  absent from a fresh clone — which is how the first version of this
 *  file passed locally and failed in CI with an ENOENT. Generating it
 *  here makes the prerequisite explicit and keeps the assertion whole;
 *  skipping when the file is missing would turn the one load-bearing
 *  check into a check that quietly does nothing on exactly the machine
 *  that matters. The generator writes only gitignored outputs and is
 *  the same command `prebuild` runs. */
function sitemap(): string {
  const path = resolve(publicDir, 'sitemap.xml');
  if (!existsSync(path)) {
    execFileSync('node', ['scripts/generate-seo.mjs'], {
      cwd: appDir,
      stdio: 'ignore',
    });
  }
  return readFileSync(path, 'utf8');
}

/** Cloudflare's documented ceiling for `_headers`. */
const MAX_RULES = 100;

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

describe('_headers.base', () => {
  const rules = rulesByPath(headers);

  it('parses the committed file into rules at all', () => {
    // Calibration guard. Every assertion below is "this path carries
    // this directive", which an empty map would fail loudly — but a
    // parser that mis-keyed everything could still pass a sloppier
    // check. Pin two rules that predate this feature so a parsing
    // change cannot make the rest vacuous.
    expect(rules.get('/positions')).toContain('X-Robots-Tag: noindex');
    expect(rules.get('/recover')).toContain('X-Robots-Tag: noindex, nofollow');
  });

  it('withholds every locale-prefixed deep path from the index', () => {
    expect(rules.get('/:locale/*')).toContain('X-Robots-Tag: noindex');
  });

  it('stays within the 100-rule ceiling with room to grow', () => {
    // `generate-seo.mjs` appends at most one more rule to this file on
    // a console-hidden build, so the generated output is this count
    // plus one. The margin matters more than the ceiling: exceeding it
    // surfaces as a Cloudflare build failure whose log CI cannot read,
    // which cost a full diagnostic pass to attribute once already.
    expect(rules.size).toBeLessThanOrEqual(MAX_RULES - 20);
  });

  it('has no public URL that the locale rule would suppress', () => {
    // THE load-bearing assertion. `/:locale/*` matches any first
    // segment plus more path, so it is safe only while nothing this app
    // wants indexed lives at a nested URL. Read from the generated
    // sitemap, which is what actually gets submitted.
    const paths = [...sitemap().matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) =>
      new URL(m[1]).pathname.replace(/\/+$/, ''),
    );
    expect(paths.length).toBeGreaterThan(0);
    const nested = paths.filter((p) => p.split('/').filter(Boolean).length > 1);
    // Named, not counted: whoever adds a nested public route needs to
    // know that this rule would hide it, not merely that a number moved.
    expect(nested).toEqual([]);
  });
});
