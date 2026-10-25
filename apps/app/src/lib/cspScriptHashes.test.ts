/**
 * #43 (ET-017) — the app's script policy allows its own origin and the
 * hashes of its inline boot scripts, nothing else. These tests pin the
 * committed policy and the real page it is completed from. The hashing
 * helpers themselves are tested beside them, in packages/lib.
 *
 * What they cannot do is run the policy: no unit test or Vite-preview
 * spec applies `_headers`. That is measured on a real asset server
 * instead (see the `_headers.base` comment and the COVERAGE row).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  SCRIPT_HASHES_PLACEHOLDER,
  applyScriptHashes,
  inlineScriptBodies,
  scriptHashSources,
} from '@vaipakam/lib/cspScriptHashes';

const appDir = resolve(__dirname, '..', '..');
const headersBase = readFileSync(resolve(appDir, 'public', '_headers.base'), 'utf8');
const indexHtml = readFileSync(resolve(appDir, 'index.html'), 'utf8');

/** The directives of the one Content-Security-Policy line in `_headers.base`. */
function cspDirectives(src: string): Map<string, string[]> {
  const line = src
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.startsWith('Content-Security-Policy:'));
  if (!line) throw new Error('no Content-Security-Policy line');
  const out = new Map<string, string[]>();
  for (const part of line.slice('Content-Security-Policy:'.length).split(';')) {
    const [name, ...values] = part.trim().split(/\s+/);
    if (name) out.set(name, values);
  }
  return out;
}

describe('the committed script policy', () => {
  const csp = cspDirectives(headersBase);

  it("allows its own origin and the build's hashes, and nothing else", () => {
    expect(csp.get('script-src')).toEqual(["'self'", SCRIPT_HASHES_PLACEHOLDER]);
  });

  it('carries no unsafe keyword in any script directive', () => {
    for (const [name, values] of csp) {
      if (!name.startsWith('script-src')) continue;
      expect(values.filter((v) => /unsafe/i.test(v))).toEqual([]);
    }
  });

  it('names the placeholder exactly once, so the build can complete it', () => {
    // The build throws otherwise; this says so before a build is run.
    expect(headersBase.split(SCRIPT_HASHES_PLACEHOLDER).length - 1).toBe(1);
  });
});

describe('the real page', () => {
  it('has its inline boot scripts found, and its module entry skipped', () => {
    // Calibration against the real page: three inline scripts (theme,
    // language and direction, splash timer) and one `src` entry that
    // `'self'` covers. An extractor that stopped finding them would otherwise
    // produce an empty hash list and a policy that blocks all three.
    const bodies = inlineScriptBodies(indexHtml);
    expect(bodies).toHaveLength(3);
    expect(bodies[0]).toContain('app.theme');
    expect(bodies[1]).toContain('vaipakam_lang');
    expect(bodies[2]).toContain('boot-splash');
    expect(bodies.some((b) => b.includes('main.tsx'))).toBe(false);
  });

  it('completes the committed policy into one with no placeholder left', () => {
    const built = applyScriptHashes(headersBase, scriptHashSources(indexHtml));
    expect(built).not.toContain(SCRIPT_HASHES_PLACEHOLDER);
    expect(cspDirectives(built).get('script-src')).toEqual([
      "'self'",
      ...scriptHashSources(indexHtml),
    ]);
  });
});
