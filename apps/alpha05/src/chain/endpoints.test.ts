import { describe, expect, it } from 'vitest';
import { connectSources, rpcConfigProblems, rpcEndpointsFor } from './endpoints';

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
