/**
 * #43 (ET-017) — completing a surface's `connect-src` from the origins its
 * build configuration resolves. Each surface's own suite pins its committed
 * policy and the origins it allows.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CONNECT_SOURCES_PLACEHOLDER,
  applyConnectSources,
  connectSource,
  cspConnectSourcesPlugin,
  policyConnectSources,
} from './cspConnectSources.mjs';

const P = CONNECT_SOURCES_PLACEHOLDER;
const headers = (connect: string) =>
  `/*\n  Content-Security-Policy: default-src 'self'; script-src 'self'; connect-src ${connect}; frame-ancestors 'none'\n`;

describe('connectSource', () => {
  it('reduces a configured endpoint to its origin', () => {
    expect(connectSource('https://indexer.vaipakam.com')).toBe('https://indexer.vaipakam.com');
    expect(connectSource('https://indexer.vaipakam.com/')).toBe('https://indexer.vaipakam.com');
    expect(connectSource('https://preview.example.dev/config/84532')).toBe('https://preview.example.dev');
    expect(connectSource('wss://indexer.vaipakam.com/ws/chain/84532')).toBe('wss://indexer.vaipakam.com');
  });

  it('keeps a port only when it is not the default', () => {
    expect(connectSource('https://h.example:443/x')).toBe('https://h.example');
    expect(connectSource('https://h.example:8443/x')).toBe('https://h.example:8443');
  });

  it('refuses what is not a plain https: or wss: origin', () => {
    expect(() => connectSource('http://indexer.vaipakam.com')).toThrow(/not https: or wss:/);
    expect(() => connectSource('https://user:pw@h.example')).toThrow(/credentials/);
    expect(() => connectSource('https://*.example.com')).toThrow(/wildcard/);
    expect(() => connectSource('indexer.vaipakam.com')).toThrow(/not a URL/);
    expect(() => connectSource('')).toThrow(/not a URL/);
  });
});

describe('applyConnectSources', () => {
  it('writes the origins in place of the placeholder, deduplicated, in order', () => {
    const out = applyConnectSources(headers(`'self' ${P}`), [
      'https://b.example/x',
      'https://a.example',
      'https://b.example/',
    ]);
    expect(policyConnectSources(out)).toEqual(["'self'", 'https://b.example', 'https://a.example']);
    expect(out).not.toContain(P);
  });

  it('refuses a placeholder that is missing, doubled or outside connect-src', () => {
    expect(() => applyConnectSources(headers("'self'"), ['https://a.example'])).toThrow(/exactly once/);
    expect(() => applyConnectSources(headers(`'self' ${P} ${P}`), ['https://a.example'])).toThrow(/exactly once/);
    const outside = `/*\n  Content-Security-Policy: default-src 'self' ${P}; connect-src 'self'\n`;
    expect(() => applyConnectSources(outside, ['https://a.example'])).toThrow(/outside connect-src/);
  });

  it('refuses an empty origin list and an origin it cannot use', () => {
    expect(() => applyConnectSources(headers(`'self' ${P}`), [])).toThrow(/no origins/);
    expect(() => applyConnectSources(headers(`'self' ${P}`), ['http://a.example'])).toThrow(/not https:/);
  });

  it('refuses a file without exactly one policy line', () => {
    expect(() => policyConnectSources('/*\n  X-Frame-Options: DENY\n')).toThrow(/one Content-Security-Policy/);
    expect(() => policyConnectSources("/*\n  Content-Security-Policy: default-src 'self'\n")).toThrow(/no connect-src/);
  });
});

describe('cspConnectSourcesPlugin', () => {
  const run = (files: Record<string, string>, sources: string[]) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csp-connect-'));
    for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
    const plugin = cspConnectSourcesPlugin({ sources: () => sources, missingHeadersHint: 'hint' });
    const ctx = {
      error(message: string): never {
        throw new Error(message);
      },
    };
    plugin.writeBundle.call(ctx, { dir });
    return fs.existsSync(path.join(dir, '_headers')) ? fs.readFileSync(path.join(dir, '_headers'), 'utf8') : null;
  };

  it('completes the built _headers', () => {
    const out = run({ 'index.html': '<!doctype html>', _headers: headers(`'self' ${P}`) }, ['https://a.example/']);
    expect(policyConnectSources(out!)).toEqual(["'self'", 'https://a.example']);
  });

  it('leaves an output without a page alone, and fails one without _headers', () => {
    expect(run({ _headers: headers(`'self' ${P}`) }, ['https://a.example'])).toContain(P);
    expect(() => run({ 'index.html': '<!doctype html>' }, ['https://a.example'])).toThrow(/missing; hint/);
  });
});
