// Operator and credential INPUTS the live drives read, and how each is
// refused (#1633). Each of these used to reach a drive unchecked or
// half-checked and surface as a product FAIL: a trailing slash on the
// indexer origin produced a route the indexer does not serve, a route
// without its leading slash was navigated as another URL, and a malformed
// wallet-file element threw a raw TypeError. They are inputs, so a bad one
// is BLOCKED by the drive that reads it; these pin the parsing.
import { describe, expect, it } from 'vitest';
import { normaliseWallets, parseAppRouteList, parseOrigin, parseWalletFile } from './driver.mjs';

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

// #2715 — a wallet file that is not JSON must never have its contents
// echoed: Node's JSON.parse quotes the text it failed on, and the file
// holds private keys.
describe('parseWalletFile', () => {
  const KEY = `0x${'ab'.repeat(32)}`;
  const from = (text) => parseWalletFile('/dev/wallets.json', () => text);

  it('describes a non-JSON file by kind only, never by content', () => {
    for (const text of [KEY, `PRIVATE_KEY=${KEY}`, 'deadbeefcafe', `{"lender": {"privateKey": "${KEY}"`]) {
      const r = from(text);
      expect(r.ok).toBe(false);
      expect(r.why).toMatch(/not valid JSON/);
      expect(r.why).not.toContain(KEY);
      expect(r.why).not.toContain('deadbeef');
      expect(r.why).not.toContain('ab'.repeat(8));
    }
  });

  it('names a read failure by its code, not its message', () => {
    const r = parseWalletFile('/dev/wallets.json', () => {
      throw Object.assign(new Error(`ENOENT: no such file, open ${KEY}`), { code: 'ENOENT' });
    });
    expect(r).toEqual({ ok: false, why: 'it could not be read (ENOENT)' });
  });

  it('forwards only normaliseWallets\u2019 own index-naming message for a bad shape', () => {
    expect(from(JSON.stringify([KEY]))).toEqual({ ok: false, why: 'entry 0 of the wallet array is not an object carrying a role or name' });
    expect(from('42').why).not.toContain(KEY);
  });

  it('returns the normalised wallets for a good file', () => {
    const w = { role: 'lender', address: '0x1', privateKey: KEY };
    expect(from(JSON.stringify([w]))).toEqual({ ok: true, wallets: { lender: w } });
  });
});
