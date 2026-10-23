/**
 * #43 (ET-017) — the app's script policy allows its own origin and the
 * hashes of its inline boot scripts, nothing else. These tests pin the
 * hashing helpers the build uses and the committed policy they feed.
 *
 * What they cannot do is run the policy: no unit test or Vite-preview
 * spec applies `_headers`. That is measured on a real asset server
 * instead (see the `_headers.base` comment and the COVERAGE row).
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  SCRIPT_HASHES_PLACEHOLDER,
  applyScriptHashes,
  inlineScriptBodies,
  scriptHashSources,
  sha256Source,
} from '../../scripts/cspScriptHashes.mjs';

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

describe('inlineScriptBodies', () => {
  it('finds the inline boot scripts in index.html and skips the module entry', () => {
    // Calibration against the real page: three inline scripts (theme,
    // language and direction, splash timer) and one `src` entry that
    // `'self'` covers. A regex that stopped matching would otherwise
    // produce an empty hash list and a policy that blocks all three.
    const bodies = inlineScriptBodies(indexHtml);
    expect(bodies).toHaveLength(3);
    expect(bodies[0]).toContain('app.theme');
    expect(bodies[1]).toContain('vaipakam_lang');
    expect(bodies[2]).toContain('boot-splash');
    expect(bodies.some((b) => b.includes('main.tsx'))).toBe(false);
  });

  it('keeps the exact text between the tags, which is what a browser hashes', () => {
    const html = '<script>\n  a();\n</script><script type="module">b()</script>';
    expect(inlineScriptBodies(html)).toEqual(['\n  a();\n', 'b()']);
  });

  it('skips any element with a src attribute, however it is written', () => {
    const html =
      '<script src="/a.js"></script><script type="module" crossorigin src="/b.js"></script>' +
      '<script\nsrc="/c.js"></script><script data-src="x">kept()</script>';
    expect(inlineScriptBodies(html)).toEqual(['kept()']);
  });
});

describe('sha256Source', () => {
  it('is the CSP hash source of the UTF-8 text', () => {
    const body = "console.log('ā')";
    const digest = createHash('sha256').update(Buffer.from(body, 'utf8')).digest('base64');
    expect(sha256Source(body)).toBe(`'sha256-${digest}'`);
  });
});

describe('scriptHashSources', () => {
  it('lists one source per distinct inline script', () => {
    const html = '<script>a()</script><script>a()</script><script>b()</script>';
    expect(scriptHashSources(html)).toEqual([sha256Source('a()'), sha256Source('b()')]);
  });
});

describe('applyScriptHashes', () => {
  const policy = `  Content-Security-Policy: default-src 'self'; script-src 'self' ${SCRIPT_HASHES_PLACEHOLDER}; object-src 'none'\n`;

  it('puts the hashes where the placeholder was', () => {
    expect(applyScriptHashes(policy, ["'sha256-A'", "'sha256-B'"])).toBe(
      "  Content-Security-Policy: default-src 'self'; script-src 'self' 'sha256-A' 'sha256-B'; object-src 'none'\n",
    );
  });

  it('drops the placeholder cleanly when there is nothing to allow', () => {
    expect(applyScriptHashes(policy, [])).toBe(
      "  Content-Security-Policy: default-src 'self'; script-src 'self'; object-src 'none'\n",
    );
  });

  it('refuses a file without the placeholder', () => {
    expect(() => applyScriptHashes("script-src 'self';", ["'sha256-A'"])).toThrow(/exactly once/);
  });

  it('refuses a file with the placeholder twice', () => {
    expect(() => applyScriptHashes(policy + policy, ["'sha256-A'"])).toThrow(/found 2/);
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
