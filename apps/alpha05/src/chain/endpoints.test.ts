import { describe, expect, it } from 'vitest';
import { connectSources, rpcConfigProblems, rpcEndpointsFor, rpcProxyOrigin, serviceOriginProblem } from './endpoints';

const TESTNETS = [84532, 421614, 97];

describe('rpcConfigProblems', () => {
  it('accepts a proxy-configured build with no provider URLs', () => {
    expect(rpcConfigProblems({ VITE_RPC_PROXY_ORIGIN: 'https://rpc.vaipakam.com' }, [...TESTNETS, 8453])).toEqual([]);
  });
  it('refuses a mainnet build without the proxy', () => {
    const problems = rpcConfigProblems({}, [8453]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/mainnet/);
  });
  it('refuses a per-chain HTTP provider URL, used or not', () => {
    const problems = rpcConfigProblems(
      { VITE_RPC_PROXY_ORIGIN: 'https://rpc.vaipakam.com', VITE_BASE_SEPOLIA_RPC_URL: 'https://x.example/KEY' },
      TESTNETS,
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/VITE_BASE_SEPOLIA_RPC_URL/);
  });
  it('refuses a per-chain socket URL the app never opens (an unused credential still ships)', () => {
    const problems = rpcConfigProblems(
      { VITE_RPC_PROXY_ORIGIN: 'https://rpc.vaipakam.com', VITE_ARBITRUM_SEPOLIA_WSS_URL: 'wss://x.example/KEY' },
      TESTNETS,
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/VITE_ARBITRUM_SEPOLIA_WSS_URL/);
  });
});

describe('service origins', () => {
  it('refuses a malformed, pathed, http, credentialed or queried value by name, not by omission', () => {
    for (const [value, why] of [
      ['not-a-url', /not a URL/],
      ['https://rpc.vaipakam.com/rpc', /path/],
      ['http://rpc.vaipakam.com', /https/],
      ['https://user:pw@rpc.vaipakam.com', /credentials/],
      ['https://rpc.vaipakam.com/?x=1', /query/],
    ] as const) {
      expect(serviceOriginProblem(value), value).toMatch(why);
      const problems = rpcConfigProblems({ VITE_RPC_PROXY_ORIGIN: value }, TESTNETS);
      expect(problems, value).toHaveLength(1);
      expect(problems[0]).toMatch(/^VITE_RPC_PROXY_ORIGIN /);
      expect(problems[0]).not.toContain('user:pw');
    }
  });
  it('accepts an origin, a trailing slash, and http on localhost', () => {
    expect(serviceOriginProblem('https://rpc.vaipakam.com')).toBeNull();
    expect(serviceOriginProblem('https://rpc.vaipakam.com/')).toBeNull();
    expect(serviceOriginProblem('http://localhost:8787')).toBeNull();
    expect(rpcProxyOrigin({ VITE_RPC_PROXY_ORIGIN: 'https://rpc.vaipakam.com/' })).toBe('https://rpc.vaipakam.com');
  });
  it('never lets a refused value reach a transport as a proxy route, nor read as "no proxy"', () => {
    expect(() => rpcEndpointsFor(84532, { VITE_RPC_PROXY_ORIGIN: 'not-a-url' })).toThrow(/VITE_RPC_PROXY_ORIGIN/);
    expect(() => connectSources({ VITE_INDEXER_ORIGIN: 'indexer' }, [84532])).toThrow(/VITE_INDEXER_ORIGIN/);
    // A malformed proxy on a mainnet build is reported once, as the malformed value, not as "no proxy".
    expect(rpcConfigProblems({ VITE_RPC_PROXY_ORIGIN: 'not-a-url' }, [8453])).toHaveLength(1);
  });
});

describe('rpcEndpointsFor', () => {
  it('tries the proxy route first, then the keyless public endpoint', () => {
    const list = rpcEndpointsFor(84532, { VITE_RPC_PROXY_ORIGIN: 'https://rpc.vaipakam.com/' });
    expect(list.map((e) => [e.url, e.viaProxy])).toEqual([
      ['https://rpc.vaipakam.com/rpc/84532', true],
      ['https://sepolia.base.org', false],
    ]);
  });
});

describe('connectSources', () => {
  it('names every origin the bundle reads from, once', () => {
    const sources = connectSources({ VITE_RPC_PROXY_ORIGIN: 'https://rpc.vaipakam.com', VITE_INDEXER_ORIGIN: 'https://indexer.vaipakam.com' }, [84532]);
    expect(sources).toContain('https://rpc.vaipakam.com');
    expect(sources).toContain('https://indexer.vaipakam.com');
    expect(sources).toContain('wss://indexer.vaipakam.com');
    expect(sources).toContain('https://sepolia.base.org');
    expect(new Set(sources).size).toBe(sources.length);
  });
});
