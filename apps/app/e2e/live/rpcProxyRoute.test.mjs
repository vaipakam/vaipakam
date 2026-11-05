import { describe, expect, it } from 'vitest';
import { DEFAULT_RPC_PROXY_ORIGIN, makeIsRpcProxyEndpoint } from './rpcProxyRoute.mjs';

describe('makeIsRpcProxyEndpoint', () => {
  const isProxy = makeIsRpcProxyEndpoint(undefined);

  it('defaults to the production proxy', () => {
    expect(DEFAULT_RPC_PROXY_ORIGIN).toBe('https://rpc.vaipakam.com');
    expect(makeIsRpcProxyEndpoint('')('https://rpc.vaipakam.com/rpc/84532')).toBe(true);
  });

  it("accepts the proxy's /rpc/<chainId> route", () => {
    expect(isProxy('https://rpc.vaipakam.com/rpc/84532')).toBe(true);
    expect(isProxy('https://rpc.vaipakam.com/rpc/1')).toBe(true);
    // Same host spelling rules as the guard's hostOf: case and root dot.
    expect(isProxy('https://RPC.vaipakam.com./rpc/97')).toBe(true);
  });

  it('refuses any other path, query, scheme or credentials on the proxy host', () => {
    expect(isProxy('https://rpc.vaipakam.com/')).toBe(false);
    expect(isProxy('https://rpc.vaipakam.com/rpc')).toBe(false);
    expect(isProxy('https://rpc.vaipakam.com/rpc/84532/x')).toBe(false);
    expect(isProxy('https://rpc.vaipakam.com/rpc/base')).toBe(false);
    expect(isProxy('https://rpc.vaipakam.com/admin')).toBe(false);
    expect(isProxy('https://rpc.vaipakam.com/rpc/84532?x=1')).toBe(false);
    expect(isProxy('http://rpc.vaipakam.com/rpc/84532')).toBe(false);
    expect(isProxy('https://u:p@rpc.vaipakam.com/rpc/84532')).toBe(false);
  });

  it('refuses our other surfaces on the same route shape', () => {
    expect(isProxy('https://indexer.vaipakam.com/rpc/84532')).toBe(false);
    expect(isProxy('https://agent.vaipakam.com/rpc/84532')).toBe(false);
    expect(isProxy('https://app.vaipakam.com/rpc/84532')).toBe(false);
    expect(isProxy('https://evilrpc.vaipakam.com/rpc/84532')).toBe(false);
    expect(isProxy('https://rpc.vaipakam.com.evil.example/rpc/84532')).toBe(false);
    expect(isProxy('not a url')).toBe(false);
  });

  it('follows RPC_PROXY_ORIGIN when a drive is pointed at another proxy', () => {
    const staging = makeIsRpcProxyEndpoint('https://rpc-proxy.example.workers.dev');
    expect(staging('https://rpc-proxy.example.workers.dev/rpc/84532')).toBe(true);
    expect(staging('https://rpc.vaipakam.com/rpc/84532')).toBe(false);
  });

  it('exempts nothing when the configured origin is unusable', () => {
    for (const bad of ['not a url', 'http://rpc.vaipakam.com', 'https://rpc.vaipakam.com/rpc', 'https://rpc.vaipakam.com/?x=1']) {
      expect(makeIsRpcProxyEndpoint(bad)('https://rpc.vaipakam.com/rpc/84532')).toBe(false);
    }
  });
});
