// #43 — a content-policy report on the page fails the drive. The narrow
// connect-src goes out report-only first, so a host missing from it changes
// nothing the page does; only this verdict turns it into a finding.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CSP_VIOLATION_BINDING,
  cspViolationVerdict,
  describeViolation,
  installCspViolationWatch,
} from './cspViolations.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

const reported = {
  directive: 'connect-src',
  blocked: 'https://pulse.walletconnect.org/batch',
  disposition: 'report',
  page: '/offers',
};
const refused = { ...reported, directive: 'script-src-elem', blocked: 'https://evil.example/x.js', disposition: 'enforce' };

describe('cspViolationVerdict', () => {
  it('leaves the drive alone when the page reported nothing', () => {
    expect(cspViolationVerdict(0, [])).toBeNull();
    expect(cspViolationVerdict(2, [])).toBeNull();
  });

  it('withdraws a PASS, and turns a BLOCKED or UNDETERMINED into a FAIL', () => {
    for (const code of [0, 2, 3]) {
      const v = cspViolationVerdict(code, [reported]);
      expect(v?.code).toBe(1);
      expect(v?.message).toMatch(/^\nFAIL: the page reported content-policy violations/);
      expect(v?.message).toContain('connect-src reported (report-only) https://pulse.walletconnect.org/batch on /offers');
    }
  });

  it('lets a FAIL stand and names the violations beside it', () => {
    const v = cspViolationVerdict(1, [refused]);
    expect(v?.code).toBe(1);
    expect(v?.message).not.toContain('FAIL:');
    expect(v?.message).toContain('script-src-elem refused https://evil.example/x.js');
  });

  it('names each distinct violation once however often it repeats', () => {
    const v = cspViolationVerdict(0, [reported, reported, { ...reported }, refused]);
    expect(v?.message.match(/pulse\.walletconnect\.org/g)).toHaveLength(1);
  });

  it('says what an inline refusal blocked', () => {
    expect(describeViolation({ ...refused, blocked: '' })).toContain('(inline)');
  });
});

describe('installCspViolationWatch', () => {
  it('exposes the binding and installs the listener on every page of the context', async () => {
    const calls = [];
    const ctx = {
      exposeBinding: async (name, fn) => calls.push(['binding', name, fn]),
      addInitScript: async (fn, arg) => calls.push(['init', fn, arg]),
    };
    const seen = [];
    await installCspViolationWatch(ctx, (v) => seen.push(v));
    expect(calls.map((c) => c[0])).toEqual(['binding', 'init']);
    expect(calls[0][1]).toBe(CSP_VIOLATION_BINDING);
    expect(calls[1][2]).toBe(CSP_VIOLATION_BINDING);
    // The binding hands the page's report straight to the record.
    calls[0][2]({}, reported);
    expect(seen).toEqual([reported]);
    // The init script listens for the event the browser fires for both
    // dispositions, not for console text.
    expect(String(calls[1][1])).toContain("'securitypolicyviolation'");
    expect(String(calls[1][1])).toContain('e.disposition');
  });
});

describe('every drive that opens a browser context watches it', () => {
  // The verdict is applied at exit for every drive importing the driver,
  // but it can only count what a watch recorded: a context opened without
  // one is a drive whose report-only refusals pass silently.
  const drives = readdirSync(HERE).filter((f) => /^live-.*\.mjs$/.test(f));

  it('finds the drives', () => {
    expect(drives.length).toBeGreaterThan(10);
  });

  for (const f of drives) {
    const src = readFileSync(join(HERE, f), 'utf8');
    if (!/\.newContext\(|launchPersistentContext\(/.test(src)) continue;
    it(`${f} watches the context it opens`, () => {
      expect(src).toMatch(/watchCspViolations\(ctx\)/);
    });
  }

  it('the shared launch watches its own context', () => {
    const driver = readFileSync(join(HERE, 'driver.mjs'), 'utf8');
    expect(driver).toMatch(/setup\('watching for content-policy violations', \(\) => watchCspViolations\(ctx\)\)/);
    expect(driver).toMatch(/cspViolationVerdict\(code, OBSERVED_CSP_VIOLATIONS\)/);
  });
});
