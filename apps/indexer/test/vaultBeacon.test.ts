/**
 * #3281 / #3422 — the VaultBeacon's events: read in the scan's own
 * `eth_getLogs`, decoded BY ADDRESS with the beacon's ABI, written per block
 * beside the block's Diamond rows, and served on `/vault-beacon/events`.
 * Run against the REAL migrations in SQLite and a fixture RPC.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { encodeAbiParameters, encodeEventTopics, type Abi } from 'viem';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getDeployment } from '@vaipakam/contracts/deployments';
import { DIAMOND_ABI_VIEM, VaultBeaconABI } from '@vaipakam/contracts/abis';
import { createSqliteD1 } from './helpers/sqliteD1';
import { REQUIRED_D1_MIGRATIONS } from '../src/requiredMigrations';
import { RECONCILE_BUDGET_SHARED_TICK, runChainIndexerForChain } from '../src/chainIndexer';
import { createBudget } from '../src/subrequestBudget';
import { BEACON_EVENT_NAMES, beaconColumns, handleVaultBeaconEvents, parseBeaconQuery, vaultBeaconForDiamond } from '../src/vaultBeacon';
import type { ChainConfig, Env } from '../src/env';

const MIGRATIONS_DIR = new URL('../migrations/', import.meta.url);
const migrations = () =>
  readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => readFileSync(new URL(f, MIGRATIONS_DIR), 'utf8'));
const MIGRATIONS_DDL = `CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)`;

const BASE = 84532;
const bundle = getDeployment(BASE)!;
const BEACON = vaultBeaconForDiamond(bundle.diamond)!;
const CURSOR = bundle.deployBlock + 5;
const HEAD = CURSOR + 100;
const DIAMOND_BLOCK = CURSOR + 10;
const BEACON_ONLY_BLOCK = CURSOR + 20;
const VAULT = '0x0000000000000000000000000000000000000a0a';
const hex = (n: bigint | number) => `0x${BigInt(n).toString(16)}`;

function rawLog(address: string, block: number, logIndex: number, topics: readonly string[], data: string) {
  return {
    address: address.toLowerCase(),
    topics,
    data,
    blockNumber: hex(block),
    blockHash: `0x${block.toString(16).padStart(64, '0')}`,
    transactionHash: `0x${(block * 7 + logIndex).toString(16).padStart(64, '0')}`,
    transactionIndex: hex(logIndex),
    logIndex: hex(logIndex),
    removed: false,
  };
}

const keeperLog = () =>
  rawLog(
    bundle.diamond,
    DIAMOND_BLOCK,
    0,
    encodeEventTopics({ abi: DIAMOND_ABI_VIEM as Abi, eventName: 'LoanKeeperEnabled', args: { loanId: 1n, keeper: VAULT } } as never),
    encodeAbiParameters([{ type: 'bool' }, { type: 'address' }], [true, '0x00000000000000000000000000000000000000a1']),
  );
// The beacon's OwnershipTransferred has the Diamond's signature: decoding by
// topic alone would file it as a Diamond event.
const beaconOwnershipLog = () =>
  rawLog(
    BEACON,
    DIAMOND_BLOCK,
    1,
    encodeEventTopics({
      abi: VaultBeaconABI as Abi,
      eventName: 'OwnershipTransferred',
      args: { previousOwner: '0x00000000000000000000000000000000000000b1', newOwner: '0x00000000000000000000000000000000000000b2' },
    } as never),
    '0x',
  );
const proposalLog = () =>
  rawLog(
    BEACON,
    BEACON_ONLY_BLOCK,
    0,
    encodeEventTopics({ abi: VaultBeaconABI as Abi, eventName: 'CurrentVaultVersionProposed', args: { id: 3n } } as never),
    encodeAbiParameters([{ type: 'uint256' }], [1_800_000_000n]),
  );
const pinLog = () =>
  rawLog(
    BEACON,
    BEACON_ONLY_BLOCK,
    1,
    encodeEventTopics({ abi: VaultBeaconABI as Abi, eventName: 'VaultPinRequested', args: { vault: VAULT, target: 2n } } as never),
    encodeAbiParameters([{ type: 'uint256' }], [1_800_000_500n]),
  );

function rpc() {
  const addresses: unknown[] = [];
  const fetchFn = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const req = JSON.parse(String(init?.body)) as { id: number; method: string; params?: unknown[] };
    const ok = (result: unknown) => new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }), { headers: { 'content-type': 'application/json' } });
    if (req.method === 'eth_chainId') return ok(hex(BASE));
    if (req.method === 'eth_blockNumber') return ok(hex(HEAD));
    if (req.method === 'eth_getLogs') {
      const p = (req.params?.[0] ?? {}) as { fromBlock: string; toBlock: string; address: unknown };
      addresses.push(p.address);
      return ok([keeperLog(), beaconOwnershipLog(), proposalLog(), pinLog()].filter((l) => Number(l.blockNumber) >= Number(p.fromBlock) && Number(l.blockNumber) <= Number(p.toBlock)));
    }
    if (req.method === 'eth_getBlockByNumber') {
      const tag = req.params?.[0] as string;
      const number = tag === 'safe' || tag === 'latest' ? hex(HEAD) : tag;
      return ok({
        number, hash: `0x${'11'.repeat(32)}`, parentHash: `0x${'22'.repeat(32)}`, timestamp: hex(1_700_000_000 + Number(number)),
        transactions: [], logsBloom: `0x${'00'.repeat(256)}`, gasLimit: '0x1', gasUsed: '0x0', baseFeePerGas: '0x1', difficulty: '0x0',
        extraData: '0x', miner: `0x${'00'.repeat(20)}`, nonce: '0x0000000000000000', sha3Uncles: `0x${'00'.repeat(32)}`, size: '0x1',
        stateRoot: `0x${'00'.repeat(32)}`, receiptsRoot: `0x${'00'.repeat(32)}`, transactionsRoot: `0x${'00'.repeat(32)}`, uncles: [],
      });
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id, error: { code: -32000, message: 'unsupported' } }), { headers: { 'content-type': 'application/json' } });
  });
  return { fetchFn, addresses };
}

function chainDb() {
  const h = createSqliteD1([...migrations(), MIGRATIONS_DDL]);
  for (const n of REQUIRED_D1_MIGRATIONS) h.db.prepare('INSERT INTO d1_migrations (name) VALUES (?)').run(n);
  h.db
    .prepare('INSERT INTO indexer_deployment (chain_id, diamond, deploy_block, adopted_at, reset_pending, adopted_blind) VALUES (?, ?, ?, ?, 0, 0)')
    .run(BASE, bundle.diamond, bundle.deployBlock, 1_000);
  h.db.prepare('INSERT INTO indexer_cursor (chain_id, kind, last_block, updated_at) VALUES (?, ?, ?, ?)').run(BASE, 'diamond', CURSOR, 1);
  return h;
}

const chain = { id: BASE, rpc: 'https://rpc.invalid', diamond: bundle.diamond } as unknown as ChainConfig;

describe('the scan reads the vault beacon (#3281)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('reads the beacon in the same request, stores its events by block, and never files them as Diamond events', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const h = chainDb();
    const { fetchFn, addresses } = rpc();
    vi.stubGlobal('fetch', fetchFn);
    await runChainIndexerForChain({ DB: h.d1 } as unknown as Env, chain, RECONCILE_BUDGET_SHARED_TICK, createBudget('test pass'));

    expect(addresses.length).toBeGreaterThan(0);
    for (const a of addresses) expect((a as string[]).map((x) => x.toLowerCase())).toContain(BEACON.toLowerCase());

    const beaconRows = h.db
      .prepare('SELECT block_number, log_index, kind, vault, version_id, executable_at FROM vault_beacon_events ORDER BY block_number, log_index')
      .all();
    expect(beaconRows).toEqual([
      { block_number: DIAMOND_BLOCK, log_index: 1, kind: 'OwnershipTransferred', vault: null, version_id: null, executable_at: null },
      { block_number: BEACON_ONLY_BLOCK, log_index: 0, kind: 'CurrentVaultVersionProposed', vault: null, version_id: '3', executable_at: 1_800_000_000 },
      { block_number: BEACON_ONLY_BLOCK, log_index: 1, kind: 'VaultPinRequested', vault: VAULT, version_id: '2', executable_at: 1_800_000_500 },
    ]);
    expect(h.db.prepare('SELECT kind FROM activity_events').all()).toEqual([{ kind: 'LoanKeeperEnabled' }]);
    expect((h.db.prepare(`SELECT last_block FROM indexer_cursor WHERE kind = 'diamond'`).get() as { last_block: number }).last_block).toBeGreaterThanOrEqual(BEACON_ONLY_BLOCK);

    // Served: a vault's page gets its own events and every chain-wide one.
    const res = await handleVaultBeaconEvents(
      new Request(`https://x/vault-beacon/events?chainId=${BASE}&vault=${VAULT.toUpperCase().replace('0X', '0x')}`),
      { DB: h.d1, RPC_BASE_SEPOLIA: 'http://127.0.0.1:9' } as unknown as Env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { throughBlock: number; events: { kind: string; vault: string | null }[]; nextBefore: string | null };
    expect(body.events.map((e) => e.kind)).toEqual(['VaultPinRequested', 'CurrentVaultVersionProposed', 'OwnershipTransferred']);
    expect(body.throughBlock).toBeGreaterThanOrEqual(BEACON_ONLY_BLOCK);
    expect(body.nextBefore).toBeNull();
  });
});

describe('the beacon route and columns', () => {
  it('keeps every beacon event but the EIP-712 notice', () => {
    expect(BEACON_EVENT_NAMES.has('VaultVersionRevoked')).toBe(true);
    expect(BEACON_EVENT_NAMES.has('EIP712DomainChanged')).toBe(false);
  });

  it('reads the version an event is about from the field that names it', () => {
    expect(beaconColumns({ eventName: 'CurrentVaultVersionSet', args: { oldId: 1n, newId: 2n } }).versionId).toBe('2');
    expect(beaconColumns({ eventName: 'VaultPinCancelled', args: { vault: VAULT, target: 4n, by: VAULT } })).toEqual({ vault: VAULT, versionId: '4', executableAt: null });
  });

  it('refuses a malformed query', () => {
    for (const qs of ['vault=0x12', 'kind=Transfer', 'limit=0', 'before=x']) {
      expect(parseBeaconQuery(new URLSearchParams(qs)).ok).toBe(false);
    }
    expect(parseBeaconQuery(new URLSearchParams('kind=VaultVersionRevoked,CurrentVaultVersionProposed&limit=5'))).toMatchObject({ ok: true, limit: 5 });
  });

  it('answers 503, never an empty list, before the migration', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = createSqliteD1([]);
    const res = await handleVaultBeaconEvents(new Request(`https://x/vault-beacon/events?chainId=${BASE}`), {
      DB: h.d1,
      RPC_BASE_SEPOLIA: 'http://127.0.0.1:9',
    } as unknown as Env);
    expect(res.status).toBe(503);
    vi.restoreAllMocks();
  });
});
