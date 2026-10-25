/**
 * #43 (ET-017) — the hashing helpers both web surfaces' builds use to allow
 * their inline boot scripts by hash, and the checks a later step (the
 * marketing site's prerender) runs against the completed policy. Each
 * surface's own suite pins its committed policy and its real page.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  SCRIPT_HASHES_PLACEHOLDER,
  applyScriptHashes,
  inlineScriptBodies,
  policyScriptSources,
  scriptHashSources,
  sha256Source,
  uncoveredScripts,
} from './cspScriptHashes.mjs';

describe('inlineScriptBodies', () => {
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

  it('ends a script where a browser does, whatever the spelling of the end tag', () => {
    // An end tag may carry whitespace and junk attributes before `>`, and
    // its name is case-insensitive. A pattern written for `</script>`
    // missed these; the HTML parser does not.
    const html = '<script>a()</script\t\n bar><SCRIPT>b()</Script ><p>c()</p>';
    expect(inlineScriptBodies(html)).toEqual(['a()', 'b()']);
  });

  it('hashes the text after the parser normalises line endings, as a browser does', () => {
    expect(inlineScriptBodies('<script>a();\r\nb();\r</script>')).toEqual(['a();\nb();\n']);
  });

  it('does not walk into a template, whose content a browser does not run', () => {
    expect(inlineScriptBodies('<template><script>t()</script></template><script>r()</script>')).toEqual(['r()']);
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
});

describe('which scripts a browser runs', () => {
  it('takes a script with no type, an empty type, or a JavaScript MIME type', () => {
    const html =
      '<script>a()</script><script type="">b()</script>' +
      '<script type=" Text/JavaScript ">c()</script><script type="application/x-javascript">d()</script>';
    expect(inlineScriptBodies(html)).toEqual(['a()', 'b()', 'c()', 'd()']);
  });

  it('takes modules, import maps and speculation rules, which a browser runs too', () => {
    const html =
      '<script type="module">m()</script><script type="importmap">{"imports":{}}</script>' +
      '<script type="speculationrules">{}</script>';
    expect(inlineScriptBodies(html)).toEqual(['m()', '{"imports":{}}', '{}']);
  });

  it('reads the legacy language attribute only when there is no type', () => {
    const html =
      '<script language="javascript">a()</script><script language="vbscript">b()</script>' +
      '<script language="">c()</script><script type="text/plain" language="javascript">d()</script>';
    expect(inlineScriptBodies(html)).toEqual(['a()', 'c()']);
  });

  it('skips data blocks, which a browser never runs and the policy does not govern', () => {
    // The marketing site's structured data is one: a hash for it would be
    // an allowance for nothing, and a check that demanded one would fail a
    // page a browser loads without complaint.
    const html =
      '<script type="application/ld+json">{"@type":"Organization"}</script>' +
      '<script type="text/javascript; charset=utf-8">x()</script><script type="text/template">y</script>';
    expect(inlineScriptBodies(html)).toEqual([]);
  });
});

describe('policyScriptSources', () => {
  it("reads the script-src sources of the one policy line", () => {
    const headers =
      "/*\n  X-Content-Type-Options: nosniff\n" +
      "  Content-Security-Policy: default-src 'self'; script-src 'self' 'sha256-A'; object-src 'none'\n";
    expect(policyScriptSources(headers)).toEqual(["'self'", "'sha256-A'"]);
  });

  it('refuses a file with no policy line, or with two', () => {
    // A check against a policy it could not find would pass for any page.
    expect(() => policyScriptSources('/*\n  X-Content-Type-Options: nosniff\n')).toThrow(/found 0/);
    const line = "  Content-Security-Policy: script-src 'self'\n";
    expect(() => policyScriptSources(line + line)).toThrow(/found 2/);
  });

  it('refuses a policy with no script-src', () => {
    expect(() => policyScriptSources("  Content-Security-Policy: default-src 'self'\n")).toThrow(
      /no script-src/,
    );
  });
});

describe('uncoveredScripts', () => {
  it('lists the inline scripts the policy does not allow by hash, and nothing else', () => {
    const html =
      '<script>boot()</script><script>injected()</script>' +
      '<script type="application/ld+json">{}</script><script src="/a.js"></script>';
    expect(uncoveredScripts(html, ["'self'", sha256Source('boot()')])).toEqual(['injected()']);
    expect(uncoveredScripts(html, [sha256Source('boot()'), sha256Source('injected()')])).toEqual([]);
  });
});

