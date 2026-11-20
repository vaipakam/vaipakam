import { describe, expect, it } from 'vitest';
import type { PublicClient } from 'viem';
import { IndexerUnavailable, type IndexerClient } from '../reads/world/indexerClient';
import { arrivalKey, checkUnrecognised, plainLabel, readArrivals, type ArrivalScan } from './unrecognised';

type Hex = `0x${string}`;
const OWNER = '0x00000000000000000000000000000000000000aa' as Hex;
const VAULT = '0x00000000000000000000000000000000000000bb' as Hex;
const DIAMOND = '0x00000000000000000000000000000000000000dd' as Hex;
const T1 = '0x0000000000000000000000000000000000000001' as Hex;
const T2 = '0x0000000000000000000000000000000000000002' as Hex;
const T3 = '0x0000000000000000000000000000000000000003' as Hex;

function indexer(pages: Record<string, unknown>, fail?: IndexerUnavailable): IndexerClient & { asked: string[] } {
  const asked: string[] = [];
  return {
    origin: 'https://index.test',
    asked,
    async getJson<T>(path: string): Promise<T> {
      asked.push(path);
      if (fail) throw fail;
      if (!(path in pages)) throw new IndexerUnavailable('status', `no page ${path}`, 503);
      return pages[path] as T;
    },
  };
}

const base = `/vaults/84532/${OWNER}/unrecognised`;
const page = (candidates: unknown[], nextCursor: string | null, extra: Record<string, unknown> = {}) => ({
  chainId: 84532,
  owner: OWNER,
  vault: VAULT,
  scannedFromBlock: 100,
  scannedToBlock: 500,
  headBlock: 900,
  complete: false,
  candidates,
  truncated: nextCursor !== null,
  pruned: false,
  nextCursor,
  ...extra,
});

describe('readArrivals', () => {
  it('follows the cursor, keeps the first page’s scan state and reads token ids', async () => {
    const ix = indexer({
      [base]: page([{ asset: T1, kind: 'erc20', tokenId: null, firstBlock: 120, lastBlock: 400 }], '400:x'),
      [`${base}?cursor=400%3Ax`]: page([{ asset: T2, kind: 'erc721', tokenId: '7', firstBlock: 130, lastBlock: 130 }], null),
    });
    const r = await readArrivals(ix, 84532, OWNER);
    expect(r.kind).toBe('scan');
    if (r.kind !== 'scan') return;
    expect(r.scan.complete).toBe(false);
    expect(r.scan.scannedToBlock).toBe(500);
    expect(r.scan.arrivals.map(arrivalKey)).toEqual([`erc20:${T1}:`, `erc721:${T2}:7`]);
    expect(r.scan.pagesCut).toBe(false);
  });

  it('says a page limit cut the list short', async () => {
    const ix = indexer({ [base]: page([], 'c1'), [`${base}?cursor=c1`]: page([], 'c2') });
    const r = await readArrivals(ix, 84532, OWNER, 2);
    expect(r.kind === 'scan' && r.scan.pagesCut).toBe(true);
  });

  it('reads a 404 naming no-vault as no vault and 429 as busy; a bare 404 or a 503 is a failure', async () => {
    expect((await readArrivals(indexer({}, new IndexerUnavailable('status', 'x', 404, 'no-vault')), 84532, OWNER)).kind).toBe('noVault');
    // An index without the route: never read as an empty vault.
    await expect(readArrivals(indexer({}, new IndexerUnavailable('status', 'x', 404)), 84532, OWNER)).rejects.toBeInstanceOf(IndexerUnavailable);
    expect((await readArrivals(indexer({}, new IndexerUnavailable('status', 'x', 429)), 84532, OWNER)).kind).toBe('busy');
    await expect(readArrivals(indexer({}, new IndexerUnavailable('status', 'x', 503)), 84532, OWNER)).rejects.toBeInstanceOf(IndexerUnavailable);
  });

  it('refuses an answer out of shape', async () => {
    const bad = [
      page([{ asset: 'nope', kind: 'erc20', tokenId: null, firstBlock: 1, lastBlock: 1 }], null),
      page([{ asset: T1, kind: 'erc20', tokenId: '1', firstBlock: 1, lastBlock: 1 }], null),
      page([{ asset: T1, kind: 'erc721', tokenId: null, firstBlock: 1, lastBlock: 1 }], null),
      page([], null, { complete: 'yes' }),
    ];
    for (const b of bad) await expect(readArrivals(indexer({ [base]: b }), 84532, OWNER)).rejects.toMatchObject({ why: 'shape' });
  });
});

describe('plainLabel', () => {
  it('drops control and direction characters, collapses space and caps length', () => {
    expect(plainLabel('Claim‮ at\u0007   site.example\n')).toBe('Claim at site.example');
    expect(plainLabel('​‏')).toBeNull();
    expect(plainLabel(42)).toBeNull();
    const long = plainLabel('x'.repeat(100))!;
    expect(Array.from(long).length).toBe(40);
    expect(long.endsWith('…')).toBe(true);
  });
});

describe('checkUnrecognised', () => {
  const scan: ArrivalScan = {
    vault: VAULT,
    scannedFromBlock: 100,
    scannedToBlock: 900,
    headBlock: 900,
    complete: true,
    pruned: false,
    pagesCut: false,
    arrivals: [
      { asset: T1, kind: 'erc20', tokenId: null, firstBlock: 120, lastBlock: 120 },
      { asset: T2, kind: 'erc721', tokenId: 7n, firstBlock: 130, lastBlock: 130 },
      { asset: T3, kind: 'erc1155', tokenId: 2n, firstBlock: 140, lastBlock: 140 },
    ],
  };

  function client(o: { vault?: Hex; untracked: Record<string, bigint | 'revert'>; name?: Record<string, unknown> }): PublicClient {
    return {
      getBlockNumber: async () => 1000n,
      readContract: async (p: { address: Hex; functionName: string; args?: readonly unknown[]; blockNumber?: bigint }) => {
        expect(p.blockNumber).toBe(1000n);
        if (p.functionName === 'getUserVaultAddress') return o.vault ?? VAULT;
        if (p.functionName === 'untrackedHolding') {
          const v = o.untracked[(p.args![2] as string).toLowerCase()];
          if (v === 'revert') {
            const { ContractFunctionRevertedError, ContractFunctionExecutionError } = await import('viem');
            throw new ContractFunctionExecutionError(new ContractFunctionRevertedError({ abi: [], functionName: 'untrackedHolding' }), {
              abi: [],
              functionName: 'untrackedHolding',
            });
          }
          return v;
        }
        if (p.functionName === 'name' || p.functionName === 'symbol') {
          const n = o.name?.[p.address.toLowerCase()];
          if (n instanceof Error) throw n;
          return n ?? null;
        }
        if (p.functionName === 'decimals') return 18;
        throw new Error(`unexpected ${p.functionName}`);
      },
    } as unknown as PublicClient;
  }

  it('keeps only what the chain says sits uncounted, with its own text made plain', async () => {
    const r = await checkUnrecognised(
      client({ untracked: { [T1]: 5n * 10n ** 18n, [T2]: 0n, [T3]: 'revert' }, name: { [T1]: 'Visit‮ scam.example', [T3]: new Error('boom') } }),
      DIAMOND,
      OWNER,
      scan,
    );
    expect(r.vaultMismatch).toBe(false);
    expect(r.items.map(arrivalKey)).toEqual([`erc20:${T1}:`]);
    expect(r.items[0].name).toBe('Visit scam.example');
    expect(r.items[0].decimals).toBe(18);
    expect(r.unread.map(arrivalKey)).toEqual([`erc1155:${T3}:2`]);
  });

  it('shows nothing when the index scanned another vault', async () => {
    const r = await checkUnrecognised(client({ vault: '0x00000000000000000000000000000000000000cc', untracked: {} }), DIAMOND, OWNER, scan);
    expect(r.vaultMismatch).toBe(true);
    expect(r.items).toEqual([]);
  });
});
