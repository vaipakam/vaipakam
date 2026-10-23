// Operator and credential INPUTS the live drives read, and how each is
// refused (#1633). Each of these used to reach a drive unchecked or
// half-checked and surface as a product FAIL: a trailing slash on the
// indexer origin produced a route the indexer does not serve, a route
// without its leading slash was navigated as another URL, and a malformed
// wallet-file element threw a raw TypeError. They are inputs, so a bad one
// is BLOCKED by the drive that reads it; these pin the parsing.
import { describe, expect, it } from 'vitest';
import { normaliseWallets, parseAppRouteList, parseOrigin } from './driver.mjs';

describe('parseOrigin', () => {
  it('drops a trailing slash, so a route appends to a bare origin', () => {
    expect(parseOrigin('https://indexer.example/')).toEqual({ origin: 'https://indexer.example' });
    expect(parseOrigin('http://localhost:8787')).toEqual({ origin: 'http://localhost:8787' });
  });

  it('refuses what appending a route to would change the meaning of', () => {
    for (const bad of [
      'https://indexer.example/api',
      'https://indexer.example/?x=1',
      'https://indexer.example/#h',
      'https://user:pw@indexer.example',
    ]) {
      expect(parseOrigin(bad)).toHaveProperty('error');
    }
  });

  it('refuses a value that is not an absolute http(s) URL', () => {
    expect(parseOrigin('indexer.example')).toHaveProperty('error');
    expect(parseOrigin('ftp://indexer.example')).toHaveProperty('error');
    expect(parseOrigin('')).toHaveProperty('error');
  });
});

describe('parseAppRouteList', () => {
  it('keeps app-relative routes, trimmed', () => {
    expect(parseAppRouteList(' /borrow, /lend ')).toEqual({ routes: ['/borrow', '/lend'] });
  });

  it('refuses a route without its leading slash, naming it', () => {
    const r = parseAppRouteList('/lend,borrow');
    expect(r).toHaveProperty('error');
    expect(r.error).toContain('"borrow"');
  });

  it('refuses a protocol-relative route, which a browser reads as another host', () => {
    expect(parseAppRouteList('//evil.example/x')).toHaveProperty('error');
  });

  it('refuses a selector that names no route', () => {
    expect(parseAppRouteList(',, ,')).toEqual({ error: 'it selects no routes' });
  });
});

describe('normaliseWallets', () => {
  it('keys the array form by role, or by name', () => {
    const a = { role: 'lender', address: '0x1' };
    const b = { name: 'borrower', address: '0x2' };
    expect(normaliseWallets([a, b])).toEqual({ lender: a, borrower: b });
  });

  it('passes the map form through', () => {
    const map = { lender: { address: '0x1' } };
    expect(normaliseWallets(map)).toBe(map);
  });

  it('throws a described error, never a TypeError, on a malformed element', () => {
    for (const bad of [[null], ['lender'], [{ address: '0x1' }], [{ role: '' }]]) {
      expect(() => normaliseWallets(bad)).toThrow(/entry 0 of the wallet array/);
    }
  });

  it('throws a described error on a file that is neither shape', () => {
    expect(() => normaliseWallets('nope')).toThrow(/neither a role map nor an array/);
    expect(() => normaliseWallets(null)).toThrow(/neither a role map nor an array/);
  });
});
