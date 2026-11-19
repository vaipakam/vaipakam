/**
 * #3453 — the indexer reads the price guard's and the protocol registry's
 * logs beside the Diamond's, keeps the guard's pending changes, and serves
 * them on `/config/:chainId`.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, type Abi, type Address, type Hex, type PublicClient } from 'viem';
import { PriceGuardABI, ProtocolRegistryABI } from '@vaipakam/contracts/abis';
import { getDeployment } from '@vaipakam/contracts/deployments';
import {
  governanceAddresses,
  governanceChangesConfig,
  governanceStatements,
  readPendingGuardChanges,
  reconcilePendingGuardChanges,
  governanceWatchFrom,
  splitGovernanceLogs,
  type GovernanceLog,
  type GovernanceWatch,
} from '../src/priceGuardWatch';
import type { Env } from '../src/env';
import { createSqliteD1 } from './helpers/sqliteD1';

const MIGRATIONS_DIR = new URL('../migrations/', import.meta.url);
const ALL = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => readFileSync(new URL(f, MIGRATIONS_DIR), 'utf8'));

const CHAIN = 84532;
const GUARD = '0x00000000000000000000000000000000000000aa' as Address;
const OTHER_GUARD = '0x00000000000000000000000000000000000000bb' as Address;
const REGISTRY = '0x00000000000000000000000000000000000000cc' as Address;
const DIAMOND = '0x00000000000000000000000000000000000000dd' as Address;
const w = (n: number | bigint) => `0x${BigInt(n).toString(16).padStart(64, '0')}` as Hex;

function harness() {
  const { db, d1 } = createSqliteD1(ALL);
  return { db, env: { DB: d1 } as unknown as Env };
}

function guardLog(eventName: string, args: Record<string, unknown>, block: bigint, logIndex = 0, address: string = GUARD) {
  const abi = PriceGuardABI as Abi;
  const item = abi.find((e) => e.type === 'event' && e.name === eventName) as {
    inputs: { name: string; type: string; indexed?: boolean; components?: unknown }[];
  };
  const topics = encodeEventTopics({ abi, eventName, args } as never) as Hex[];
  const unindexed = item.inputs.filter((i) => !i.indexed);
  const data = encodeAbiParameters(unindexed as never, unindexed.map((i) => args[i.name]) as never);
  return { address, topics, data, blockNumber: block, logIndex };
}

const WATCH: GovernanceWatch = { guard: GUARD, registry: REGISTRY, recorded: false };

function decoded(...raw: ReturnType<typeof guardLog>[]): GovernanceLog[] {
  return splitGovernanceLogs(raw, WATCH).governance;
}

async function apply(env: Env, logs: GovernanceLog[], scanFrom = 100n, watch = WATCH) {
  const db = env.DB;
  await db.batch(governanceStatements(db, { chainId: CHAIN, watch, logs, scanFrom }));
}

describe('splitting the scan (#3453)', () => {
  it('decodes the guard and registry logs apart, and leaves the rest for the Diamond decode', () => {
    // OwnershipTransferred shares its signature with the Diamond's own event:
    // from the guard's address it must never reach the Diamond's handlers.
    const owner = guardLog('OwnershipTransferred', { previousOwner: DIAMOND, newOwner: REGISTRY }, 10n);
    const diamondLog = { ...owner, address: DIAMOND };
    const reg = (() => {
      const abi = ProtocolRegistryABI as Abi;
      const ev = abi.find((e) => e.type === 'event' && e.name === 'GuardianSet') as { inputs: { name: string }[] };
      const args = Object.fromEntries(ev.inputs.map((i) => [i.name, DIAMOND]));
      return { address: REGISTRY, topics: encodeEventTopics({ abi, eventName: 'GuardianSet', args } as never) as Hex[], data: '0x' as Hex, blockNumber: 11n, logIndex: 0 };
    })();
    const { rest, governance } = splitGovernanceLogs([owner, diamondLog, reg], WATCH);
    expect(rest).toEqual([diamondLog]);
    expect(governance.map((g) => [g.source, g.eventName])).toEqual([
      ['guard', 'OwnershipTransferred'],
      ['registry', 'GuardianSet'],
    ]);
    expect(governanceChangesConfig(governance)).toBe(true);
  });

  it('does not count a price report as a settings change', () => {
    const logs: GovernanceLog[] = [
      { source: 'guard', eventName: 'RateRecorded', args: {}, blockNumber: 1n, logIndex: 0 },
    ];
    expect(governanceChangesConfig(logs)).toBe(false);
  });

  it('adds only addresses the scan does not already read', () => {
    expect(governanceAddresses(WATCH, [DIAMOND, GUARD])).toEqual([REGISTRY]);
    expect(governanceAddresses({ guard: null, registry: null, recorded: false }, [DIAMOND])).toEqual([]);
  });
});

describe('the pending-change list (#3453)', () => {
  it('records a proposal and drops it when executed', async () => {
    const h = harness();
    await apply(h.env, decoded(guardLog('ChangeProposed', { kind: 2, subject: w(0), value: w(0xfeed), executableAt: 5_000n }, 101n)));
    expect(h.db.prepare(`SELECT kind, value, executable_at, proposed_block FROM price_guard_pending_changes`).all()).toEqual([
      { kind: 2, value: w(0xfeed), executable_at: 5_000, proposed_block: 101 },
    ]);
    await apply(h.env, decoded(guardLog('ConfigSet', { kind: 2, subject: w(0), value: w(0xfeed) }, 150n)));
    expect(h.db.prepare(`SELECT COUNT(*) AS n FROM price_guard_pending_changes`).get()).toEqual({ n: 0 });
  });

  it('applies one pass in chain order: cancel then propose again keeps the new one', async () => {
    const h = harness();
    await apply(
      h.env,
      decoded(
        guardLog('ChangeProposed', { kind: 19, subject: w(0), value: w(60), executableAt: 7_000n }, 105n, 3),
        guardLog('ChangeCancelled', { kind: 19, subject: w(0), by: DIAMOND }, 101n, 0),
        guardLog('ChangeProposed', { kind: 19, subject: w(0), value: w(30), executableAt: 6_000n }, 100n, 1),
      ),
    );
    expect(h.db.prepare(`SELECT value, proposed_block FROM price_guard_pending_changes`).all()).toEqual([
      { value: w(60), proposed_block: 105 },
    ]);
    await apply(h.env, decoded(guardLog('DelaySet', { oldDelay: 120n, newDelay: 60n }, 200n)));
    expect(h.db.prepare(`SELECT COUNT(*) AS n FROM price_guard_pending_changes`).get()).toEqual({ n: 0 });
  });

  it('records a secondary source removal and drops it when it executes', async () => {
    const h = harness();
    await apply(h.env, decoded(guardLog('SecondaryRemovalProposed', { source: 1, by: DIAMOND, executableAt: 9_000n }, 120n)));
    expect(h.db.prepare(`SELECT kind, subject FROM price_guard_pending_changes`).all()).toEqual([{ kind: 255, subject: w(1) }]);
    await apply(h.env, decoded(guardLog('SecondaryRemoved', { source: 1 }, 130n)));
    expect(h.db.prepare(`SELECT COUNT(*) AS n FROM price_guard_pending_changes`).get()).toEqual({ n: 0 });
  });

  it('keeps where reading began for the same guard, and restarts it for a new one', async () => {
    const h = harness();
    await apply(h.env, [], 100n);
    await apply(h.env, [], 500n);
    expect(h.db.prepare(`SELECT guard, from_block FROM price_guard_watch`).all()).toEqual([{ guard: GUARD, from_block: 100 }]);
    await apply(h.env, [], 900n, { ...WATCH, guard: OTHER_GUARD });
    // Once recorded, a pass that names the same guard leaves the row alone.
    await apply(h.env, [], 950n, { ...WATCH, guard: OTHER_GUARD, recorded: true });
    expect(h.db.prepare(`SELECT guard, from_block FROM price_guard_watch`).all()).toEqual([{ guard: OTHER_GUARD, from_block: 900 }]);
  });

  it('writes nothing when no guard is known', () => {
    const h = harness();
    expect(governanceStatements(h.env.DB, { chainId: CHAIN, watch: { guard: null, registry: null, recorded: false }, logs: [], scanFrom: 1n })).toEqual([]);
  });
});

describe('the re-read against the guard (#3453)', () => {
  it('drops what the guard no longer holds, updates what it does, and forgets other guards', async () => {
    const h = harness();
    await apply(
      h.env,
      decoded(
        guardLog('ChangeProposed', { kind: 2, subject: w(0), value: w(1), executableAt: 5_000n }, 101n, 0),
        guardLog('ChangeProposed', { kind: 9, subject: w(0), value: w(400), executableAt: 5_000n }, 101n, 1),
        guardLog('SecondaryRemovalProposed', { source: 2, by: DIAMOND, executableAt: 8_000n }, 101n, 2),
      ),
    );
    h.db.prepare(
      `INSERT INTO price_guard_pending_changes VALUES (?, ?, 3, ?, ?, 1, 1)`,
    ).run(CHAIN, OTHER_GUARD, w(0), w(0));
    const calls: { functionName: string; args: readonly unknown[] }[][] = [];
    const client = {
      multicall: async (a: { contracts: { functionName: string; args: readonly unknown[] }[] }) => {
        calls.push(a.contracts);
        return a.contracts.map((c) => {
          if (c.functionName === 'secondaryRemovalAt') return { status: 'success', result: 8_000n };
          if (c.args[0] === 2) return { status: 'success', result: [w(0), 0n] }; // executed meanwhile
          return { status: 'success', result: [w(450), 5_500n] };
        });
      },
    } as unknown as PublicClient;
    await reconcilePendingGuardChanges({ env: h.env, chainId: CHAIN, client, guard: GUARD, blockNumber: 200n });
    expect(calls[0].map((c) => c.functionName).sort()).toEqual(['pendingChange', 'pendingChange', 'secondaryRemovalAt']);
    expect(
      h.db.prepare(`SELECT guard, kind, value, executable_at FROM price_guard_pending_changes ORDER BY kind`).all(),
    ).toEqual([
      { guard: GUARD, kind: 9, value: w(450), executable_at: 5_500 },
      { guard: GUARD, kind: 255, value: w(0), executable_at: 8_000 },
    ]);
  });

  it('keeps the rows when the read fails', async () => {
    const h = harness();
    await apply(h.env, decoded(guardLog('ChangeProposed', { kind: 2, subject: w(0), value: w(1), executableAt: 5_000n }, 101n)));
    const client = { multicall: async () => { throw new Error('rpc down'); } } as unknown as PublicClient;
    await reconcilePendingGuardChanges({ env: h.env, chainId: CHAIN, client, guard: GUARD, blockNumber: 200n });
    expect(h.db.prepare(`SELECT COUNT(*) AS n FROM price_guard_pending_changes`).get()).toEqual({ n: 1 });
  });
});

describe('what /config serves (#3453)', () => {
  it('lists the snapshot guard\'s changes, with the setting each one moves and where reading began', async () => {
    const h = harness();
    await apply(h.env, decoded(guardLog('ChangeProposed', { kind: 2, subject: w(0), value: w(0xfeed), executableAt: 5_000n }, 101n)));
    const view = await readPendingGuardChanges(h.env, CHAIN, GUARD);
    expect(view).toEqual({
      guard: GUARD,
      listedFromBlock: 100,
      sinceDeploy: 100 <= (getDeployment(CHAIN)?.deployBlock ?? -1),
      changes: [
        {
          kind: 2,
          kindName: 'EthNumeraireFeed',
          subject: w(0),
          value: w(0xfeed),
          executableAt: 5_000,
          proposedBlock: 101,
          knobKey: 'ethNumeraireFeed',
        },
      ],
    });
  });

  it('serves nothing rather than an empty list when it cannot say', async () => {
    const h = harness();
    expect(await readPendingGuardChanges(h.env, CHAIN, undefined)).toBeNull();
    expect(await readPendingGuardChanges(h.env, CHAIN, GUARD)).toBeNull(); // guard never read
    await apply(h.env, []);
    expect(await readPendingGuardChanges(h.env, CHAIN, OTHER_GUARD)).toBeNull(); // snapshot names another guard
    const old = createSqliteD1([]);
    expect(await readPendingGuardChanges({ DB: old.d1 } as unknown as Env, CHAIN, GUARD)).toBeNull();
  });

  it('reads the watch targets from the snapshot, else from the deployment record', () => {
    const dep = getDeployment(CHAIN);
    const fallback = governanceWatchFrom(CHAIN, null);
    expect(fallback.guard).toBe(dep?.priceGuard ? dep.priceGuard.toLowerCase() : null);
    const junk = governanceWatchFrom(CHAIN, { snapshot_guard: 'not an address', snapshot_registry: 7, watched_guard: null, watched_registry: null });
    expect(junk.guard).toBe(fallback.guard);
    const fromSnapshot = governanceWatchFrom(CHAIN, { snapshot_guard: OTHER_GUARD, snapshot_registry: REGISTRY, watched_guard: null, watched_registry: null });
    expect(fromSnapshot.guard).toBe(OTHER_GUARD);
    expect(fromSnapshot.registry).toBe(REGISTRY);
    expect(fromSnapshot.recorded).toBe(false);
    const steady = governanceWatchFrom(CHAIN, { snapshot_guard: OTHER_GUARD, snapshot_registry: REGISTRY, watched_guard: OTHER_GUARD, watched_registry: REGISTRY });
    expect(steady.recorded).toBe(true);
    // A steady pass with no guard log writes nothing.
    expect(governanceStatements(createSqliteD1([]).d1 as D1Database, { chainId: CHAIN, watch: steady, logs: [], scanFrom: 1n })).toEqual([]);
  });
});
