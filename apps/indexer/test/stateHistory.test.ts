/**
 * #3921 — the event history and the state at a block, against the REAL
 * migrated schema (migration 0125) on SQLite.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, parseAbi, type Hex } from 'viem';
import { DIAMOND_ABI_VIEM } from '@vaipakam/contracts/abis';
import { createSqliteD1 } from './helpers/sqliteD1';
import {
  SETTINGS_READ_ATTEMPTS,
  eventSettingKey,
  facetAt,
  fillSettingsHistory,
  historyStatements,
  settingsAt,
  VALUE_NOT_CARRIED_EVENTS,
  VALUE_NOT_CARRIED_GETTERS,
  type HistoryDb,
  type RawLog,
} from '../src/stateHistory';
import { isSettingsHistoryEvent } from '../src/configSnapshot';

const DDL = readFileSync(new URL('../migrations/0125_event_and_state_history.sql', import.meta.url), 'utf8');
const CHAIN = 84532;
const DIAMOND = '0x00000000000000000000000000000000000000d1';
const TOKEN = '0x00000000000000000000000000000000000000e2';
const FACET_A = '0x00000000000000000000000000000000000000a1';
const FACET_B = '0x00000000000000000000000000000000000000b2';
const SELECTOR = '0x12345678';

function db(): { d1: HistoryDb; raw: ReturnType<typeof createSqliteD1>['db'] } {
  const s = createSqliteD1([DDL]);
  return { d1: s.d1 as HistoryDb, raw: s.db };
}

let logIndex = 0;
function log(block: number, txIndex: number, address: string, topics: readonly Hex[], data: Hex): RawLog {
  return {
    address,
    blockNumber: BigInt(block),
    logIndex: logIndex++,
    transactionIndex: txIndex,
    transactionHash: `0x${String(block).padStart(8, '0')}${String(txIndex).padStart(56, '0')}`,
    topics,
    data,
  };
}

const backstopSet = (block: number, txIndex: number, enabled: boolean) =>
  log(
    block,
    txIndex,
    DIAMOND,
    encodeEventTopics({ abi: DIAMOND_ABI_VIEM, eventName: 'BackstopEnabledSet' } as never) as Hex[],
    encodeAbiParameters([{ type: 'bool' }], [enabled]),
  );

const cut = (block: number, txIndex: number, facet: string, action: number) =>
  cutOf(block, txIndex, [{ facet, action, selectors: [SELECTOR] }]);

const cutOf = (block: number, txIndex: number, entries: Array<{ facet: string; action: number; selectors: string[] }>) =>
  log(
    block,
    txIndex,
    DIAMOND,
    encodeEventTopics({ abi: DIAMOND_ABI_VIEM, eventName: 'DiamondCut' } as never) as Hex[],
    encodeAbiParameters(
      [
        {
          type: 'tuple[]',
          components: [
            { name: 'facetAddress', type: 'address' },
            { name: 'action', type: 'uint8' },
            { name: 'functionSelectors', type: 'bytes4[]' },
          ],
        },
        { type: 'address' },
        { type: 'bytes' },
      ],
      [
        entries.map((e) => ({ facetAddress: e.facet as Hex, action: e.action, functionSelectors: e.selectors as Hex[] })),
        '0x0000000000000000000000000000000000000000',
        '0x',
      ],
    ),
  );

async function record(d1: HistoryDb, logs: RawLog[]) {
  const statements: number[] = [];
  const byBlock = new Map<bigint, RawLog[]>();
  for (const l of logs) byBlock.set(l.blockNumber, [...(byBlock.get(l.blockNumber) ?? []), l]);
  for (const [block, list] of byBlock) {
    const batch = historyStatements({
      db: d1,
      chainId: CHAIN,
      diamond: DIAMOND,
      blockAt: Number(block) * 2,
      logs: list,
      isSettingsEvent: isSettingsHistoryEvent,
    });
    statements.push(batch.length);
    await d1.batch(batch);
  }
  return statements;
}

describe('the event history (#3921)', () => {
  it('keeps every log: decoded where an ABI describes it, raw where none does, from any platform contract', async () => {
    const { d1, raw } = db();
    const transfer = parseAbi(['event Transfer(address indexed from, address indexed to, uint256 value)']);
    const unknown = log(10, 0, DIAMOND, [`0x${'ab'.repeat(32)}`], '0x01');
    const tokenLog = log(
      10,
      1,
      TOKEN,
      encodeEventTopics({ abi: transfer, eventName: 'Transfer', args: { from: DIAMOND, to: TOKEN } }) as Hex[],
      encodeAbiParameters([{ type: 'uint256' }], [5n]),
    );
    await record(d1, [unknown, tokenLog]);
    // Recording the same block again changes nothing.
    await record(d1, [unknown, tokenLog]);
    const rows = raw.prepare('SELECT address, event_name, args_json, raw_json FROM chain_event_log ORDER BY log_index').all() as Array<
      Record<string, string | null>
    >;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ address: DIAMOND, event_name: null, args_json: null });
    expect(JSON.parse(rows[0]!.raw_json!)).toEqual({ topics: unknown.topics, data: '0x01' });
    expect(rows[1]).toMatchObject({ address: TOKEN, event_name: 'Transfer', raw_json: null });
    expect(JSON.parse(rows[1]!.args_json!)).toMatchObject({ value: '5' });
  });

  it('a setting changed twice gives three answers, and a block with two changes says its first is unknown between', async () => {
    const { d1, raw } = db();
    await record(d1, [backstopSet(100, 0, true), backstopSet(200, 3, false), backstopSet(200, 5, true)]);
    const reads: bigint[] = [];
    const filled = await fillSettingsHistory({
      db: d1,
      chainId: CHAIN,
      throughBlock: 1000,
      maxBlocks: 10,
      canRead: () => true,
      read: async (b) => {
        reads.push(b);
        return { block: Number(b) };
      },
    });
    expect(filled).toBe(2);
    // One read per block, never one per change.
    expect(reads).toEqual([100n, 200n]);

    expect((await settingsAt(d1, CHAIN, { block: 50 })).inForce).toBeNull();
    const after100 = await settingsAt(d1, CHAIN, { block: 150 });
    expect(after100.inForce).toMatchObject({ block_number: 100, values_basis: 'end-of-block', unknown_between: 0 });
    expect(JSON.parse(after100.inForce!.values_json!)).toEqual({ block: 100 });
    // Inside block 200 at transaction 4: the change at transaction 3 is in
    // force, and it is marked as carrying the block's last values.
    const mid = await settingsAt(d1, CHAIN, { block: 200, txIndex: 4 });
    expect(mid.inForce).toMatchObject({ block_number: 200, tx_index: 3, unknown_between: 1 });
    expect(mid.inBlock.map((r) => r.tx_index)).toEqual([5]);
    // The event layer is exact between the two: the setting is off there,
    // though the block's end-of-block read says on.
    expect(mid.fromEvents.BackstopEnabledSet).toMatchObject({ args: { enabled: false }, block: 200, txIndex: 3, carriesValue: true });
    expect((await settingsAt(d1, CHAIN, { block: 150 })).fromEvents.BackstopEnabledSet?.args).toEqual({ enabled: true });
    expect((await settingsAt(d1, CHAIN, { block: 300 })).fromEvents.BackstopEnabledSet?.args).toEqual({ enabled: true });
    const after200 = await settingsAt(d1, CHAIN, { block: 300 });
    expect(after200.inForce).toMatchObject({ block_number: 200, tx_index: 5, unknown_between: 0 });
    expect(raw.prepare("SELECT COUNT(*) AS n FROM settings_history WHERE values_basis = 'pending'").get()).toEqual({ n: 0 });
  });

  it('a block whose settings cannot be read is marked unreadable with the reason, never given other values', async () => {
    const { d1, raw } = db();
    await record(d1, [backstopSet(100, 0, true)]);
    for (let i = 0; i < SETTINGS_READ_ATTEMPTS; i++) {
      await fillSettingsHistory({
        db: d1,
        chainId: CHAIN,
        throughBlock: 1000,
        maxBlocks: 10,
        canRead: () => true,
        read: async () => {
          throw new Error('missing trie node');
        },
      });
    }
    const row = raw.prepare('SELECT values_basis, values_json, read_attempts, read_error FROM settings_history').get() as Record<string, unknown>;
    expect(row).toMatchObject({ values_basis: 'unreadable', values_json: null, read_attempts: SETTINGS_READ_ATTEMPTS });
    // A bounded description (`describeFailure`): it never carries the node's
    // URL or key, so a plain error is named by its kind.
    expect(String(row.read_error)).not.toBe('');
    // The event's own value stands.
    expect((await settingsAt(d1, CHAIN, { block: 101 })).fromEvents.BackstopEnabledSet?.args).toEqual({ enabled: true });
  });

  it('a pending block above the cursor is not read, and a refused read leaves the row pending', async () => {
    const { d1 } = db();
    await record(d1, [backstopSet(100, 0, true)]);
    const read = async () => ({});
    expect(await fillSettingsHistory({ db: d1, chainId: CHAIN, throughBlock: 99, maxBlocks: 10, canRead: () => true, read })).toBe(0);
    expect(await fillSettingsHistory({ db: d1, chainId: CHAIN, throughBlock: 100, maxBlocks: 10, canRead: () => false, read })).toBe(0);
    expect((await settingsAt(d1, CHAIN, { block: 101 })).inForce?.values_basis).toBe('pending');
  });

  it('a facet refresh gives the old code before it and the new code after it; a removal names none', async () => {
    const { d1 } = db();
    await record(d1, [cut(100, 0, FACET_A, 0), cut(200, 2, FACET_B, 1), cut(300, 0, FACET_A, 2)]);
    expect((await facetAt(d1, CHAIN, SELECTOR, { block: 50 })).lastChange).toBeNull();
    expect((await facetAt(d1, CHAIN, SELECTOR, { block: 150 })).lastChange).toMatchObject({ action: 'add', facet: FACET_A });
    const atRefresh = await facetAt(d1, CHAIN, SELECTOR, { block: 200, txIndex: 1 });
    expect(atRefresh.lastChange).toMatchObject({ facet: FACET_A });
    expect(atRefresh.inBlock).toEqual([expect.objectContaining({ action: 'replace', facet: FACET_B })]);
    expect((await facetAt(d1, CHAIN, SELECTOR, { block: 200, txIndex: 3 })).lastChange).toMatchObject({ facet: FACET_B });
    expect((await facetAt(d1, CHAIN, SELECTOR.toUpperCase().replace('0X', '0x'), { block: 400 })).lastChange).toMatchObject({
      action: 'remove',
      facet: null,
    });
  });

  it('a cut that removes a selector and adds it again records its final routing', async () => {
    const { d1 } = db();
    await record(d1, [
      cutOf(100, 0, [
        { facet: FACET_A, action: 2, selectors: [SELECTOR] },
        { facet: FACET_B, action: 0, selectors: [SELECTOR] },
      ]),
    ]);
    expect((await facetAt(d1, CHAIN, SELECTOR, { block: 101 })).lastChange).toMatchObject({ action: 'add', facet: FACET_B });
  });

  it('a block costs a few statements however many logs and selectors it carries', async () => {
    const { d1, raw } = db();
    const selectors = Array.from({ length: 300 }, (_, i) => `0x${(i + 1).toString(16).padStart(8, '0')}`);
    const logs = [
      cutOf(100, 0, [{ facet: FACET_A, action: 0, selectors }]),
      ...Array.from({ length: 200 }, (_, i) => backstopSet(100, i + 1, i % 2 === 0)),
    ];
    const [count] = await record(d1, logs);
    expect(count).toBeLessThanOrEqual(3);
    expect(raw.prepare('SELECT COUNT(*) AS n FROM chain_event_log').get()).toEqual({ n: 201 });
    expect(raw.prepare('SELECT COUNT(*) AS n FROM facet_history').get()).toEqual({ n: 300 });
    expect(raw.prepare('SELECT COUNT(*) AS n FROM settings_history WHERE unknown_between = 0').get()).toEqual({ n: 1 });
    expect(raw.prepare('SELECT COUNT(*) AS n FROM settings_history').get()).toEqual({ n: 200 });
  });

  it('keyed settings events fold per key, and an event without its value says so', () => {
    expect(eventSettingKey('KeeperTierSet', { asset: '0xAbC' })).toBe('KeeperTierSet(0xabc)');
    expect(eventSettingKey('BackstopEnabledSet', { enabled: true })).toBe('BackstopEnabledSet');
  });

  it('every settings event that carries only a count, index or version is marked as not carrying its value', () => {
    const countLike = /^(count|.*Count|index|newVersion)$/;
    const missing = (DIAMOND_ABI_VIEM as readonly { type: string; name?: string; inputs?: readonly { name: string }[] }[])
      .filter((e) => e.type === 'event' && e.name && isSettingsHistoryEvent(e.name))
      .filter((e) => (e.inputs ?? []).filter((i) => !countLike.test(i.name) && i.name !== 'adapter').length === 0)
      .map((e) => e.name!)
      .filter((n) => !VALUE_NOT_CARRIED_EVENTS.has(n));
    expect(missing).toEqual([]);
  });

  it('every event that does not carry its value names a zero-argument getter the Diamond ABI has', () => {
    const views = new Set(
      (DIAMOND_ABI_VIEM as readonly { type: string; name?: string; inputs?: readonly unknown[]; stateMutability?: string }[])
        .filter((f) => f.type === 'function' && f.stateMutability === 'view' && (f.inputs ?? []).length === 0)
        .map((f) => f.name),
    );
    for (const [event, getter] of Object.entries(VALUE_NOT_CARRIED_GETTERS)) {
      expect([event, views.has(getter)]).toEqual([event, true]);
    }
  });

  it('states where the history begins', async () => {
    const { d1 } = db();
    expect((await settingsAt(d1, CHAIN, { block: 10 })).historyFrom).toBeNull();
    await record(d1, [backstopSet(500, 0, true), backstopSet(90, 0, false)]);
    expect((await settingsAt(d1, CHAIN, { block: 10 })).historyFrom).toBe(90);
  });

  it('settings and facet rows come only from the Diamond, and a cut is not a settings change', async () => {
    const { d1, raw } = db();
    const fromElsewhere = { ...backstopSet(100, 0, true), address: TOKEN };
    await record(d1, [fromElsewhere, cut(100, 1, FACET_A, 0)]);
    expect(raw.prepare('SELECT COUNT(*) AS n FROM settings_history').get()).toEqual({ n: 0 });
    expect(raw.prepare('SELECT COUNT(*) AS n FROM facet_history').get()).toEqual({ n: 1 });
    expect(raw.prepare('SELECT COUNT(*) AS n FROM chain_event_log').get()).toEqual({ n: 2 });
  });
});
