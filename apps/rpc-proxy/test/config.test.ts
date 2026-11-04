import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RPC_PROXY_CHAINS } from '@vaipakam/lib/rpcProxyPolicy';

/** Base Sepolia, Arbitrum Sepolia, BNB Testnet: the chains the testnet app reads. */
const TESTNET_CHAIN_IDS = [84532, 421614, 97];

const HERE = dirname(fileURLToPath(import.meta.url));
const wrangler = readFileSync(resolve(HERE, '..', 'wrangler.jsonc'), 'utf8');

describe('wrangler.jsonc carries what the handler reads (#1724)', () => {
  it('binds one dedicated Secrets Store entry per testnet chain, and only served chains', () => {
    const bindings = [...wrangler.matchAll(/"binding":\s*"([A-Z0-9_]+)",\s*"store_id":\s*"[0-9a-f]+",\s*"secret_name":\s*"([A-Z0-9_]+)"/g)];
    // Binding and secret carry the same name, so the config cannot quietly
    // point one chain's binding at another chain's (or the keeper's) key.
    for (const [, binding, secret] of bindings) expect(binding).toBe(secret);
    const bound = bindings.map((m) => m[1]);
    expect(new Set(bound).size).toBe(bound.length);
    // Every binding names a chain the handler serves.
    for (const name of bound) expect(Object.values(RPC_PROXY_CHAINS)).toContain(name);
    // The testnets are bound. The mainnet entries join with their keys at
    // mainnet (Workers Paid, #1724); until then those chains answer 503.
    for (const id of TESTNET_CHAIN_IDS) expect(bound).toContain(RPC_PROXY_CHAINS[id]);
  });

  it('declares the caller limiter the handler takes a slot from', () => {
    expect(wrangler).toMatch(/"name":\s*"RPC_CALLER_RATELIMIT",\s*"type":\s*"ratelimit"/);
  });

  it('keeps dashboard vars across a deploy and holds no D1 or other secret', () => {
    expect(wrangler).toMatch(/"keep_vars":\s*true/);
    expect(wrangler).not.toMatch(/"d1_databases"/);
    expect(wrangler).not.toMatch(/"secret_name":\s*"(?!RPC_PROXY_)/);
  });
});
