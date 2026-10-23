/**
 * #2687 — the service worker's allowlist. Everything not named as a shell
 * file must reach the network untouched: page loads (so a deploy replaces
 * the shell and an old build never runs from a cache), and all dynamic data.
 */
import { describe, expect, it } from 'vitest';
import {
  SHELL_FILES,
  mayStore,
  shellCacheName,
  staleShellCaches,
  swRoute,
} from './swPolicy';

const ORIGIN = 'https://app.vaipakam.com';
const get = (url: string, mode = 'cors') => ({ url, method: 'GET', mode });

describe('swRoute', () => {
  it('caches hashed build files and the named shell files', () => {
    expect(swRoute(get(`${ORIGIN}/assets/index-DDsVVRRH.js`, 'cors'), ORIGIN)).toBe('shell-asset');
    expect(swRoute(get(`${ORIGIN}/assets/index-abc.css`, 'no-cors'), ORIGIN)).toBe('shell-asset');
    for (const file of SHELL_FILES) {
      expect(swRoute(get(`${ORIGIN}${file}`, 'no-cors'), ORIGIN)).toBe('shell-asset');
    }
  });

  it('never intercepts a page load, of any path', () => {
    for (const path of ['/', '/positions', '/vpfi?x=1', '/assets/index-a.js', '/manifest.webmanifest']) {
      expect(swRoute(get(`${ORIGIN}${path}`, 'navigate'), ORIGIN)).toBe('network');
    }
  });

  it('never intercepts another origin: chain RPC, the indexer, the agent, quotes, wallets', () => {
    for (const url of [
      'https://sepolia.base.org/',
      'https://indexer.vaipakam.com/loans/recent?chainId=84532',
      'https://agent.vaipakam.com/push/status',
      'https://api.0x.org/swap/v1/quote',
      'https://relay.walletconnect.com/',
      // Same host name, other scheme or port: a different origin.
      'http://app.vaipakam.com/assets/index-a.js',
      'https://app.vaipakam.com:8443/assets/index-a.js',
    ]) {
      expect(swRoute(get(url), ORIGIN)).toBe('network');
    }
  });

  it('never intercepts a same-origin path that is not a shell file', () => {
    for (const path of ['/sw.js', '/sitemap.xml', '/robots.txt', '/_headers', '/api/anything', '/icons/other.png', '/assetsX/a.js']) {
      expect(swRoute(get(`${ORIGIN}${path}`), ORIGIN)).toBe('network');
    }
  });

  it('never intercepts a write, or a shell file asked for with a query string', () => {
    expect(swRoute({ url: `${ORIGIN}/assets/a.js`, method: 'POST', mode: 'cors' }, ORIGIN)).toBe('network');
    expect(swRoute({ url: `${ORIGIN}/assets/a.js`, method: 'HEAD', mode: 'cors' }, ORIGIN)).toBe('network');
    expect(swRoute(get(`${ORIGIN}/assets/a.js?v=2`), ORIGIN)).toBe('network');
  });

  it('leaves a request it cannot parse to the network', () => {
    expect(swRoute(get('not a url'), ORIGIN)).toBe('network');
  });
});

describe('mayStore', () => {
  it('stores a successful same-origin file', () => {
    expect(mayStore({ ok: true, type: 'basic', contentType: 'text/javascript' })).toBe(true);
    expect(mayStore({ ok: true, type: 'basic', contentType: 'image/png' })).toBe(true);
  });

  it("never stores HTML: the host's page fallback for a missing file is not that file", () => {
    expect(mayStore({ ok: true, type: 'basic', contentType: 'text/html; charset=utf-8' })).toBe(false);
    expect(mayStore({ ok: true, type: 'basic', contentType: 'TEXT/HTML' })).toBe(false);
  });

  it('never stores a failure, a redirect or an opaque response', () => {
    expect(mayStore({ ok: false, type: 'basic', contentType: 'text/javascript' })).toBe(false);
    expect(mayStore({ ok: false, type: 'opaqueredirect', contentType: null })).toBe(false);
    expect(mayStore({ ok: false, type: 'opaque', contentType: null })).toBe(false);
    expect(mayStore({ ok: true, type: 'cors', contentType: 'application/json' })).toBe(false);
  });
});

describe('shell caches', () => {
  it('a new build deletes earlier shells and nothing else', () => {
    const names = [shellCacheName('old-1'), shellCacheName('new'), 'someone-else', shellCacheName('old-2')];
    expect(staleShellCaches(names, 'new')).toEqual([shellCacheName('old-1'), shellCacheName('old-2')]);
  });
});
