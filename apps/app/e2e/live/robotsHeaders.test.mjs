/** #2089 — the robots probes are derived from the committed `_headers` policy. */
import { describe, expect, it } from 'vitest';
import { composeHeaders, readHeadersBase } from '../../scripts/headersPolicy.mjs';
import {
  expectedRobots,
  parseHeadersFile,
  pathMatches,
  robotsDirectives,
  robotsProbes,
} from './robotsHeaders.mjs';

// The committed base as a public-console build serves it; never the
// generated `public/_headers`, which a clean checkout does not have.
const HEADERS = composeHeaders(readHeadersBase(), { consolePublic: true });

describe('robotsHeaders', () => {
  it('parses rules, comments and header lines', () => {
    const rules = parseHeadersFile('# c\n/a\n  X-Robots-Tag: noindex\n\n/b/*\n  Cache-Control: x\n');
    expect(rules).toEqual([
      { path: '/a', headers: [['x-robots-tag', 'noindex']] },
      { path: '/b/*', headers: [['cache-control', 'x']] },
    ]);
    expect(() => parseHeadersFile('  X: y\n')).toThrow(/before any path/);
  });

  it('matches a splat against any remainder, including none, and nothing else', () => {
    expect(pathMatches('/nft/*', '/nft/1')).toBe(true);
    expect(pathMatches('/nft/*', '/nft/')).toBe(true);
    expect(pathMatches('/nft/*', '/nft')).toBe(false);
    expect(pathMatches('/a.b', '/aXb')).toBe(false);
  });

  it('matches a placeholder against exactly one non-empty segment', () => {
    expect(pathMatches('/:locale/*', '/es/positions/7')).toBe(true);
    expect(pathMatches('/:locale/*', '/nft/1')).toBe(true);
    expect(pathMatches('/:locale/*', '/es')).toBe(false);
    expect(pathMatches('/:locale', '/es/x')).toBe(false);
  });

  it('compares directives as a set', () => {
    expect(robotsDirectives('noindex, nofollow')).toEqual(robotsDirectives('NOFOLLOW,noindex'));
    expect(robotsDirectives(null)).toEqual([]);
  });

  // The coverage row this drive replaces: `/nft/1` carries noindex and
  // `/nft` does not.
  it('asks the committed policy for noindex on /nft/1 and nothing on /nft', () => {
    const rules = parseHeadersFile(HEADERS);
    expect(expectedRobots(rules, '/nft/1')).toEqual(['noindex']);
    expect(expectedRobots(rules, '/nft')).toEqual([]);
    const probes = robotsProbes(rules);
    expect(probes.find((p) => p.path === '/nft/1')?.expected).toEqual(['noindex']);
    expect(probes.find((p) => p.path === '/nft')?.expected).toEqual([]);
    expect(probes.find((p) => p.path === '/recover')?.expected).toEqual(['nofollow', 'noindex']);
    expect(probes.find((p) => p.path === '/')?.expected).toEqual([]);
    // The locale-alias rule is probed at a real alias, and its bare form is
    // the residual `_headers` states: not covered.
    expect(probes.find((p) => p.path === '/es/1')?.expected).toEqual(['noindex']);
    expect(probes.find((p) => p.path === '/es')?.expected).toEqual([]);
    expect(probes.some((p) => p.path.includes(':'))).toBe(false);
    // Every robots rule produced at least one probe, and no path twice.
    expect(new Set(probes.map((p) => p.path)).size).toBe(probes.length);
  });

  it('adds the exact console rule only for a hidden-console build', () => {
    const shown = parseHeadersFile(HEADERS);
    const hidden = parseHeadersFile(composeHeaders(readHeadersBase(), { consolePublic: false }));
    expect(expectedRobots(shown, '/protocol-console')).toEqual([]);
    expect(expectedRobots(hidden, '/protocol-console')).toEqual(['noindex']);
    expect(robotsProbes(hidden).find((p) => p.path === '/protocol-console')?.expected).toEqual([
      'noindex',
    ]);
  });
});
