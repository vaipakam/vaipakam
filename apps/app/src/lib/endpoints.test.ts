/**
 * #43 (ET-017) — one resolver for every endpoint the app talks to, read by
 * the bundle and by the build that writes the page's `connect-src`.
 *
 * Pins three things: the resolver's rules (unset, empty, trailing slash,
 * the socket derivation), that the list the build writes covers every
 * endpoint the bundle can reach, and the committed policy's current STAGE
 * (the narrow list report-only, the enforced line still open). The stage
 * test is meant to change when the list is enforced.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CONNECT_SOURCES_PLACEHOLDER,
  REPORT_ONLY_HEADER,
  applyConnectSources,
  connectSource,
  policyConnectSources,
} from '@vaipakam/lib/cspConnectSources';
import deployments from '@vaipakam/contracts/deployments.json';
import { RPC_PROXY_CHAINS, RPC_PROXY_MAX_LOG_RANGE_BLOCKS } from '@vaipakam/lib/rpcProxyPolicy';
import BOOK_CATCH_UP_RULES from '../data/bookCatchUpRules.json';
import {
  COINBASE_SOURCES,
  COINGECKO_API_BASE,
  ENS_FALLBACK_RPC_URL,
  GOPLUS_ORIGIN,
  RPC_CHAIN_IDS,
  WALLETCONNECT_SOURCES,
  agentOrigin,
  connectSources,
  ensMainnetRpcEndpoints,
  indexerOrigin,
  indexerWsOrigin,
  isMainnetChain,
  rpcConfigProblems,
  rpcEndpointsFor,
  rpcProxyOrigin,
  wsUrlFor,
} from './endpoints';

/** A chain's first HTTP endpoint: the one a read tries first. */
const rpcUrlFor = (chainId: number, env: Record<string, string>) => rpcEndpointsFor(chainId, env)[0].url;

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const headersBase = readFileSync(resolve(appDir, 'public', '_headers.base'), 'utf8');

const deployedChainIds = Object.entries(deployments as Record<string, { diamond?: string }>)
  .filter(([, d]) => typeof d?.diamond === 'string' && d.diamond !== '')
  .map(([id]) => Number(id));

/** A production-shaped build: both Workers, WalletConnect, one socket. */
const PROD_ENV = {
  VITE_INDEXER_ORIGIN: 'https://indexer.vaipakam.com/',
  VITE_AGENT_ORIGIN: 'https://agent.vaipakam.com',
  VITE_WALLETCONNECT_PROJECT_ID: 'abc123',
  VITE_BASE_SEPOLIA_RPC_URL: 'https://base-sepolia.example.org/v2/key',
  VITE_BASE_SEPOLIA_WSS_URL: 'wss://base-sepolia.example.org/v2/key',
};

describe('the resolver', () => {
  it('reads an unset or empty value as unset, and drops a trailing slash', () => {
    expect(indexerOrigin({})).toBeNull();
    expect(indexerOrigin({ VITE_INDEXER_ORIGIN: '  ' })).toBeNull();
    expect(indexerOrigin({ VITE_INDEXER_ORIGIN: 'https://i.example//' })).toBe('https://i.example');
    expect(agentOrigin({ VITE_AGENT_ORIGIN: '' })).toBeNull();
    expect(agentOrigin({ VITE_AGENT_ORIGIN: 'https://a.example/' })).toBe('https://a.example');
  });

  it('derives the push socket from the indexer unless one is named', () => {
    expect(indexerWsOrigin({ VITE_INDEXER_ORIGIN: 'https://i.example' })).toBe('wss://i.example');
    expect(indexerWsOrigin({ VITE_INDEXER_ORIGIN: 'http://127.0.0.1:8787' })).toBe('ws://127.0.0.1:8787');
    expect(
      indexerWsOrigin({ VITE_INDEXER_ORIGIN: 'https://i.example', VITE_INDEXER_WS_ORIGIN: 'wss://ws.example/' }),
    ).toBe('wss://ws.example');
    expect(indexerWsOrigin({})).toBeNull();
  });

  it('takes a configured RPC over the public default, and a socket only when configured', () => {
    expect(rpcUrlFor(84532, {})).toBe('https://sepolia.base.org');
    expect(rpcUrlFor(84532, { VITE_BASE_SEPOLIA_RPC_URL: '' })).toBe('https://sepolia.base.org');
    expect(rpcUrlFor(84532, PROD_ENV)).toBe(PROD_ENV.VITE_BASE_SEPOLIA_RPC_URL);
    expect(wsUrlFor(84532, {})).toBeUndefined();
    expect(wsUrlFor(84532, PROD_ENV)).toBe(PROD_ENV.VITE_BASE_SEPOLIA_WSS_URL);
    expect(() => rpcUrlFor(5, {})).toThrow(/no RPC configuration/);
  });

  it('reads through the proxy, then the public default, once a proxy origin is set (#1724)', () => {
    const env = { VITE_RPC_PROXY_ORIGIN: 'https://rpc.vaipakam.com/' };
    expect(rpcProxyOrigin(env)).toBe('https://rpc.vaipakam.com');
    expect(rpcEndpointsFor(84532, env)).toEqual([
      { url: 'https://rpc.vaipakam.com/rpc/84532', viaProxy: true },
      { url: 'https://sepolia.base.org', viaProxy: false },
    ]);
    expect(rpcEndpointsFor(84532, {})).toEqual([{ url: 'https://sepolia.base.org', viaProxy: false }]);
    // The proxy forwards no socket, so the live layer polls.
    expect(wsUrlFor(84532, { ...env, VITE_BASE_SEPOLIA_WSS_URL: 'wss://k.example/key' })).toBeUndefined();
    // ENS reads chain 1 through the proxy too, with both public endpoints behind it.
    expect(ensMainnetRpcEndpoints(env).map((e) => e.url)).toEqual([
      'https://rpc.vaipakam.com/rpc/1',
      'https://ethereum-rpc.publicnode.com',
      ENS_FALLBACK_RPC_URL,
    ]);
  });

  it('has RPC configuration for every chain the deployments bundle carries', () => {
    expect(deployedChainIds.length).toBeGreaterThan(0);
    for (const id of deployedChainIds) expect(RPC_CHAIN_IDS).toContain(id);
  });
});

describe('the RPC build guard (#1724)', () => {
  const PROXY = { VITE_RPC_PROXY_ORIGIN: 'https://rpc.vaipakam.com' };

  it('passes a direct testnet build and a proxied build with no provider URL', () => {
    expect(rpcConfigProblems(PROD_ENV, [84532, 421614, 97])).toEqual([]);
    expect(rpcConfigProblems(PROXY, [84532, 8453])).toEqual([]);
  });

  it('refuses a provider URL or socket left set beside the proxy, naming each', () => {
    const problems = rpcConfigProblems(
      { ...PROXY, VITE_BASE_SEPOLIA_RPC_URL: 'https://k.example/key', VITE_ETHEREUM_WSS_URL: 'wss://k.example/key' },
      [84532],
    );
    expect(problems).toHaveLength(2);
    expect(problems.join('\n')).toMatch(/VITE_BASE_SEPOLIA_RPC_URL/);
    expect(problems.join('\n')).toMatch(/VITE_ETHEREUM_WSS_URL/);
    expect(rpcConfigProblems({ ...PROXY, VITE_BASE_SEPOLIA_RPC_URL: '  ' }, [84532])).toEqual([]);
  });

  it('refuses a build serving a mainnet without the proxy, keys or not', () => {
    expect(rpcConfigProblems({}, [84532, 8453])).toEqual([expect.stringMatching(/chain 8453 is a mainnet/)]);
    expect(rpcConfigProblems({}, [84532])).toEqual([]);
  });

  it('marks exactly the five Phase-1 mainnets as mainnet', () => {
    expect(RPC_CHAIN_IDS.filter(isMainnetChain).sort((a, b) => a - b)).toEqual([1, 10, 56, 8453, 42161]);
  });

  it('agrees with the proxy on which chains it serves and how wide a log scan may be', () => {
    expect(Object.keys(RPC_PROXY_CHAINS).map(Number).sort()).toEqual([...RPC_CHAIN_IDS].sort());
    expect(BOOK_CATCH_UP_RULES.chunkBlocks).toBeLessThanOrEqual(RPC_PROXY_MAX_LOG_RANGE_BLOCKS);
  });
});

describe('the connect-src list', () => {
  const origins = (env: Record<string, string>, chains = deployedChainIds) =>
    connectSources(env, chains).map(connectSource);

  it('names every endpoint the bundle can reach under a production-shaped build', () => {
    const got = origins(PROD_ENV);
    const want = [
      'https://indexer.vaipakam.com',
      'wss://indexer.vaipakam.com',
      'https://agent.vaipakam.com',
      ...deployedChainIds.map((id) => connectSource(rpcUrlFor(id, PROD_ENV))),
      'wss://base-sepolia.example.org',
      ...ensMainnetRpcEndpoints(PROD_ENV).map((e) => connectSource(e.url)),
      GOPLUS_ORIGIN,
      connectSource(COINGECKO_API_BASE),
      ...WALLETCONNECT_SOURCES.map((s) => s.source),
      ...COINBASE_SOURCES.map((s) => s.source),
    ];
    expect([...new Set(got)].sort()).toEqual([...new Set(want)].sort());
  });

  it('names no Worker and no WalletConnect host the build does not configure', () => {
    const got = origins({});
    expect(got).not.toContain('https://indexer.vaipakam.com');
    expect(got).not.toContain('https://agent.vaipakam.com');
    for (const s of WALLETCONNECT_SOURCES) expect(got).not.toContain(s.source);
    for (const s of COINBASE_SOURCES) expect(got).toContain(s.source);
  });

  it('names the proxy and the public fallbacks, and no provider host, through the proxy', () => {
    const got = origins({ ...PROD_ENV, VITE_BASE_SEPOLIA_RPC_URL: '', VITE_BASE_SEPOLIA_WSS_URL: '', VITE_RPC_PROXY_ORIGIN: 'https://rpc.vaipakam.com' });
    expect(got).toContain('https://rpc.vaipakam.com');
    expect(got).toContain('https://sepolia.base.org');
    expect(got).not.toContain('https://base-sepolia.example.org');
    expect(got).not.toContain('wss://base-sepolia.example.org');
  });

  it('reads ENS through chain 1 itself once chain 1 is deployed', () => {
    const got = origins({}, [...deployedChainIds, 1]);
    expect(got).not.toContain(connectSource(ENS_FALLBACK_RPC_URL));
    expect(got).toContain(connectSource(rpcUrlFor(1, {})));
  });

  it('gives every wallet SDK host a reason', () => {
    for (const s of [...WALLETCONNECT_SOURCES, ...COINBASE_SOURCES]) {
      expect(connectSource(s.source)).toBe(s.source);
      expect(s.why.length).toBeGreaterThan(10);
    }
  });
});

describe('the committed policy', () => {
  it('sends the narrow list report-only while the enforced line stays open (the current stage)', () => {
    expect(policyConnectSources(headersBase)).toEqual(["'self'", 'https:', 'wss:']);
    expect(policyConnectSources(headersBase, REPORT_ONLY_HEADER)).toEqual([
      "'self'",
      CONNECT_SOURCES_PLACEHOLDER,
    ]);
  });

  it('completes against a production-shaped build with nothing left of the placeholder', () => {
    const out = applyConnectSources(
      headersBase,
      connectSources(PROD_ENV, deployedChainIds),
      REPORT_ONLY_HEADER,
    );
    expect(out).not.toContain(CONNECT_SOURCES_PLACEHOLDER);
    const listed = policyConnectSources(out, REPORT_ONLY_HEADER);
    expect(listed[0]).toBe("'self'");
    expect(listed).not.toContain('https:');
    expect(listed).not.toContain('wss:');
  });
});
