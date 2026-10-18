/**
 * #2569 r4 — the epoch fence: a launched pass acts only while the indexer's
 * epoch it was launched under still holds, enforced at the three effect
 * seams (a send, an alert, a database write), re-read every time.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { createWalletClient, custom } from 'viem';
import { deliverAlert } from '../src/alertDelivery';
import type { ChainConfig, Env } from '../src/env';
import { EpochFenceRefusal, assertEpochsHold, disarmEpochFence } from '../src/epochFence';
import { putNotifyState } from '../src/db';
import { resetSubmissionQueues, withSubmissionSlot } from '../src/submissionQueue';
import { createSharedD1 } from './helpers/schemas';
import { armFenceReading, armHeldFence, settleIndexer } from './helpers/epochFence';

const OLD = '0x' + '1'.repeat(40);
const NEW = '0x' + '2'.repeat(40);
const CHAIN = { id: 84532, diamond: OLD } as unknown as ChainConfig;
const account = privateKeyToAccount('0x' + '11'.repeat(32) as `0x${string}`);

beforeEach(() => {
  resetSubmissionQueues();
  disarmEpochFence();
});
afterEach(() => vi.restoreAllMocks());

describe('assertEpochsHold', () => {
  it('refuses while unarmed: no tick has established the epochs', async () => {
    await expect(assertEpochsHold()).rejects.toBeInstanceOf(EpochFenceRefusal);
    await expect(assertEpochsHold()).rejects.toThrow(/not armed/);
  });

  it('holds while the indexer has settled on every configured Diamond, and refuses the moment it has not', async () => {
    armFenceReading([{ chain_id: 84532, diamond: OLD, reset_pending: 0 }], [CHAIN]);
    await expect(assertEpochsHold()).resolves.toBeUndefined();
    // Recorded the new Diamond, reset still pending: not settled.
    armFenceReading([{ chain_id: 84532, diamond: NEW, reset_pending: 1 }], [CHAIN]);
    await expect(assertEpochsHold()).rejects.toThrow(/chain 84532: configured 0x1{40}, indexer none settled/);
    // Settled on a Diamond this build does not name.
    armFenceReading([{ chain_id: 84532, diamond: NEW, reset_pending: 0 }], [CHAIN]);
    await expect(assertEpochsHold()).rejects.toThrow(new RegExp(`configured ${OLD}, indexer ${NEW}`));
    // No record at all.
    armFenceReading([], [CHAIN]);
    await expect(assertEpochsHold()).rejects.toThrow(/none settled/);
    // Case of the recorded address does not matter.
    armFenceReading([{ chain_id: 84532, diamond: OLD.toUpperCase().replace('0X', '0x'), reset_pending: 0 }], [CHAIN]);
    await expect(assertEpochsHold()).resolves.toBeUndefined();
  });

  it('re-reads every time — a read that fails refuses, and a later read that holds passes', async () => {
    const reads: Array<() => Promise<{ chain_id: number; diamond: string; reset_pending: number }[]>> = [
      async () => { throw new Error('D1 down'); },
      async () => [{ chain_id: 84532, diamond: OLD, reset_pending: 0 }],
    ];
    const { armEpochFenceWith, configuredDiamonds } = await import('../src/epochFence');
    armEpochFenceWith(() => reads.shift()!(), configuredDiamonds([CHAIN]));
    await expect(assertEpochsHold()).rejects.toThrow(/could not re-read the indexer's adoptions \(Error: D1 down\)/);
    await expect(assertEpochsHold()).resolves.toBeUndefined();
  });
});

describe('the send seam', () => {
  it('a send is refused BEFORE signing once the epoch moved: nothing signed, the nonce stays free', async () => {
    const wallet = createWalletClient({
      account,
      transport: custom({
        request: async ({ method }: { method: string }) => {
          if (method === 'eth_getTransactionCount') return '0x0';
          throw new Error(`unexpected ${method}`);
        },
      }),
    });
    armFenceReading([{ chain_id: 84532, diamond: NEW, reset_pending: 0 }], [CHAIN]);
    const send = vi.fn(async (nonce: number, signed: () => void) => {
      signed();
      return nonce;
    });
    await expect(withSubmissionSlot(wallet, 84532, account.address, send)).rejects.toBeInstanceOf(EpochFenceRefusal);
    expect(send, 'the send callback never ran').not.toHaveBeenCalled();
    armHeldFence([CHAIN]);
    expect(await withSubmissionSlot(wallet, 84532, account.address, send), 'the nonce was not reserved by the refusal').toBe(0);
  });
});

describe('the alert seam', () => {
  it('delivers nothing on either channel once the epoch moved, and both once it holds', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      calls.push(String(url).replace(/bot[^/]+/, 'bot<token>'));
      return { ok: true, text: async () => '' } as Response;
    });
    const env = { TG_BOT_TOKEN: 'tok', PUSH_CHANNEL_PK: undefined } as unknown as Env;
    const alert = { tgChatId: '42', pushSubscriber: null, text: 'hi', pushTitle: 't', deepLinkUrl: '' };
    armFenceReading([{ chain_id: 84532, diamond: NEW, reset_pending: 0 }], [CHAIN]);
    await expect(deliverAlert(env, alert)).rejects.toBeInstanceOf(EpochFenceRefusal);
    expect(calls).toEqual([]);
    armHeldFence([CHAIN]);
    await deliverAlert(env, alert);
    expect(calls).toEqual(['https://api.telegram.org/bot<token>/sendMessage']);
    vi.unstubAllGlobals();
  });
});

describe('the write seam — the guard inside the statement', () => {
  it('a shared write is one statement with its guard: it lands only while the indexer has settled on the configured Diamond, and reports a refusal', async () => {
    const shared = createSharedD1();
    const db = shared.d1 as D1Database;
    const row = { wallet: '0xabc', chain_id: 84532, loan_id: 7, last_band: 'warn', last_hf_milli: 1200, last_sent_ts: 1 };
    const count = () => (shared.db.prepare('SELECT COUNT(*) AS n FROM notify_state').get() as { n: number }).n;
    // notify_state references the subscriber's thresholds row.
    shared.db.prepare('INSERT INTO user_thresholds (wallet, chain_id, warn_hf, alert_hf, critical_hf, created_at, updated_at) VALUES (?, ?, 1.5, 1.2, 1.05, 1, 1)').run('0xabc', 84532);
    // Unarmed: no epoch to hold to.
    await expect(putNotifyState(db, row)).rejects.toBeInstanceOf(EpochFenceRefusal);
    // Armed for OLD, but the indexer has moved to NEW (settled): the statement writes nothing and the refusal is thrown.
    settleIndexer(shared, 84532, NEW);
    armHeldFence([CHAIN]);
    await expect(putNotifyState(db, row)).rejects.toThrow(/notify_state for chain 84532 loan 7 was refused by its statement's guard/);
    expect(count()).toBe(0);
    // Mid-reset on OLD: not settled, refused.
    settleIndexer(shared, 84532, OLD, 1);
    await expect(putNotifyState(db, row)).rejects.toBeInstanceOf(EpochFenceRefusal);
    expect(count()).toBe(0);
    // Settled on OLD: lands; the upsert reports its change, so a second write is not a refusal.
    settleIndexer(shared, 84532, OLD);
    await putNotifyState(db, row);
    await putNotifyState(db, { ...row, last_band: 'alert' });
    expect(shared.db.prepare('SELECT last_band FROM notify_state').get()).toEqual({ last_band: 'alert' });
    // A chain this process is not configured for has no epoch to hold to.
    await expect(putNotifyState(db, { ...row, chain_id: 97 })).rejects.toThrow(/chain 97 is not one this process is configured for/);
  });

  it('every write in src/ to a shared table the indexer resets carries the guard — derived from the schema, so a new one cannot be added bare', () => {
    // The tables the indexer's epoch reset clears: shared, chain-scoped, not user-owned.
    const shared = createSharedD1();
    const keep = Object.keys((JSON.parse(readFileSync(new URL('../../indexer/src/diamondEpochKeep.json', import.meta.url), 'utf8')) as { keep: Record<string, string> }).keep);
    const resetTables = (shared.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[])
      .map((t) => t.name)
      .filter((t) => !t.startsWith('sqlite_') && t !== 'd1_migrations' && !keep.includes(t))
      .filter((t) => (shared.db.prepare(`SELECT name FROM pragma_table_info('${t}')`).all() as { name: string }[]).some((c) => c.name === 'chain_id'));
    expect(resetTables).toContain('notify_state');
    const srcDir = new URL('../src/', import.meta.url);
    const bare: string[] = [];
    const written = new Set<string>();
    for (const f of readdirSync(srcDir).filter((f) => f.endsWith('.ts'))) {
      const text = readFileSync(new URL(f, srcDir), 'utf8');
      for (const literal of text.match(/`[^`]*`/g) ?? []) {
        const m = literal.match(/\b(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|UPDATE|DELETE\s+FROM)\s+"?(\w+)"?/i);
        if (!m || !resetTables.includes(m[1]!)) continue;
        written.add(m[1]!);
        if (!literal.includes('${guard.where}')) bare.push(`${f}: ${m[0]}`);
      }
    }
    expect(bare, 'a write to a table the indexer resets, without the epoch guard in its statement').toEqual([]);
    // The seam is exercised, not vacuous: the keeper does write such tables.
    expect([...written].sort()).toEqual(['liquidity_confidence', 'notifications', 'notify_state', 'oracle_snapshot_state', 'pre_grace_notify_state']);
  });
});

describe('the tick arms the fence for the process', () => {
  it('arms after the epoch reconciliation and before any launch', () => {
    const src = readFileSync(new URL('../src/tick.ts', import.meta.url), 'utf8');
    const adopt = src.indexOf('await adoptKeeperDeployments(resolved, chains)');
    const arm = src.indexOf('armEpochFence(resolved.DB, chains)');
    const launchLoop = src.indexOf('for (const pass of KEEPER_PASSES)');
    expect(adopt).toBeGreaterThan(0);
    expect(arm).toBeGreaterThan(adopt);
    expect(launchLoop).toBeGreaterThan(arm);
  });

  it('every send goes through the fenced slot, and every alert through the fenced delivery', () => {
    const read = (f: string) => readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8');
    expect(read('submissionQueue.ts')).toContain('await assertEpochsHold();');
    for (const f of ['watcher.ts', 'preGraceWatcher.ts']) {
      const s = read(f);
      expect(s, `${f} delivers through the seam`).toContain("from './alertDelivery'");
      expect(s, `${f} does not reach a channel itself`).not.toMatch(/from '\.\/(telegram|push)'/);
    }
  });
});
