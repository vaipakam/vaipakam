import { describe, expect, it } from 'vitest';
import { IndexerUnavailable, type IndexerClient } from '../reads/world/indexerClient';
import { readIssuerPowers, summarise } from './issuerPowers';

const A = ('0x' + 'a'.repeat(40)) as `0x${string}`;

function client(body: unknown, seen: string[] = []): IndexerClient {
  return {
    origin: 'https://index.test',
    getJson: async <T>(path: string) => {
      seen.push(path);
      return body as T;
    },
  };
}

const run = (checks: unknown[], extra: Record<string, unknown> = {}) => ({
  address: A,
  kind: 'erc20',
  checkedAt: 2_000,
  blockNumber: 123,
  checkerVersion: '1',
  complete: true,
  detail: null,
  checks,
  ...extra,
});

describe('#3433 issuer-power reads', () => {
  it('asks for the one asset on the token’s own network', async () => {
    const seen: string[] = [];
    await readIssuerPowers(client({ chainId: 8453, assets: [], notChecked: [A] }, seen), 8453, A.toUpperCase().replace('0X', '0x') as `0x${string}`);
    expect(seen).toEqual([`/assets/issuer-powers?chainId=8453&address=${A}`]);
  });

  it('says an asset with no stored run was not checked', async () => {
    expect(await readIssuerPowers(client({ chainId: 8453, assets: [], notChecked: [A] }), 8453, A)).toEqual({ kind: 'notChecked' });
  });

  it('reads a run and groups what was found, unknown and not found; an unknown check id is kept', async () => {
    const r = await readIssuerPowers(
      client({
        chainId: 8453,
        assets: [
          run([
            { check: 'freeze', result: 'found', evidence: 'blacklist(address)', known: true },
            { check: 'pause', result: 'unknown', evidence: null, known: true },
            { check: 'upgradeable_proxy', result: 'not_found', evidence: null, known: true },
            { check: 'mint_any', result: 'found', evidence: null, known: false },
          ]),
        ],
        notChecked: [],
      }),
      8453,
      A,
    );
    expect(r.kind).toBe('checked');
    if (r.kind !== 'checked') return;
    expect(r.run.blockNumber).toBe(123);
    expect(summarise(r.run)).toEqual({ canMoveOrFreeze: true, found: ['freeze', 'mint_any'], unknown: ['pause'], notFound: ['upgradeable_proxy'] });
  });

  it('a power that cannot move or freeze is found without the move-or-freeze statement', async () => {
    const r = await readIssuerPowers(client({ chainId: 8453, assets: [run([{ check: 'pause', result: 'found', evidence: null }])], notChecked: [] }), 8453, A);
    if (r.kind !== 'checked') throw new Error('not read');
    expect(summarise(r.run).canMoveOrFreeze).toBe(false);
  });

  it('refuses an answer for another network, another asset, or one it cannot read', async () => {
    await expect(readIssuerPowers(client({ chainId: 1, assets: [], notChecked: [A] }), 8453, A)).rejects.toBeInstanceOf(IndexerUnavailable);
    await expect(readIssuerPowers(client({ chainId: 8453, assets: [], notChecked: [] }), 8453, A)).rejects.toThrow('did not answer');
    await expect(readIssuerPowers(client({ chainId: 8453, assets: [run([], { checkedAt: 'x' })], notChecked: [] }), 8453, A)).rejects.toThrow('readable date');
    await expect(readIssuerPowers(client({ chainId: 8453, assets: [run([{ check: 'freeze', result: 'maybe' }])], notChecked: [] }), 8453, A)).rejects.toThrow('finding');
  });
});
