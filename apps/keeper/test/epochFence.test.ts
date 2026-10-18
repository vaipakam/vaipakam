/**
 * #2569 r4 — the epoch fence: a launched pass acts only while the indexer's
 * epoch it was launched under still holds, enforced at the three effect
 * seams (a send, an alert, a database write), re-read every time.
 */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { createWalletClient, custom } from 'viem';
import { deliverAlert } from '../src/alertDelivery';
import type { ChainConfig, Env } from '../src/env';
import { EpochFenceRefusal, assertEpochsHold, disarmEpochFence, fencedD1 } from '../src/epochFence';
import { resetSubmissionQueues, withSubmissionSlot } from '../src/submissionQueue';
import { createKeeperD1 } from './helpers/schemas';
import { armFenceReading, armHeldFence } from './helpers/epochFence';

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

describe('the write seam — fencedD1', () => {
  it('asserts the fence on a write, a batch and exec, whichever method runs them; reads pass unfenced', async () => {
    const { d1, db } = createKeeperD1();
    const fenced = fencedD1(d1 as D1Database);
    armFenceReading([{ chain_id: 84532, diamond: NEW, reset_pending: 0 }], [CHAIN]);
    // Reads: no fence.
    expect((await fenced.prepare('SELECT COUNT(*) AS n FROM hf_band_state').first<{ n: number }>())?.n).toBe(0);
    expect((await fenced.prepare('SELECT COUNT(*) AS n FROM hf_band_state').all<{ n: number }>()).results[0]?.n).toBe(0);
    // Writes, by every method.
    const ins = 'INSERT INTO hf_band_state (chain_id, loan_id, last_band, last_hf_milli, last_recipient, updated_at) VALUES (?, ?, ?, 1000, ?, 1)';
    await expect(fenced.prepare(ins).bind(84532, 1, 'warn', '0xabc').run()).rejects.toBeInstanceOf(EpochFenceRefusal);
    await expect(fenced.prepare(ins).bind(84532, 1, 'warn', '0xabc').all()).rejects.toBeInstanceOf(EpochFenceRefusal);
    await expect(fenced.prepare(ins).bind(84532, 1, 'warn', '0xabc').first()).rejects.toBeInstanceOf(EpochFenceRefusal);
    await expect(fenced.prepare('  delete from hf_band_state').run(), 'case and leading space do not matter').rejects.toBeInstanceOf(EpochFenceRefusal);
    await expect(fenced.batch([fenced.prepare('SELECT 1')]), 'every batch').rejects.toBeInstanceOf(EpochFenceRefusal);
    expect((db.prepare('SELECT COUNT(*) AS n FROM hf_band_state').get() as { n: number }).n, 'nothing written').toBe(0);
    // Holding: the write lands, and a batch of fenced statements reaches the binding unwrapped.
    armHeldFence([CHAIN]);
    await fenced.prepare(ins).bind(84532, 1, 'warn', '0xabc').run();
    await fenced.batch([fenced.prepare(ins).bind(84532, 2, 'warn', '0xabc'), fenced.prepare('DELETE FROM hf_band_state WHERE loan_id = ?').bind(1)]);
    expect((db.prepare('SELECT loan_id FROM hf_band_state').all() as { loan_id: number }[]).map((r) => r.loan_id)).toEqual([2]);
  });
});

describe('the tick arms the fence and hands the passes fenced handles', () => {
  it('arms after the epoch reconciliation and before any launch; passes run with the fenced env', () => {
    const src = readFileSync(new URL('../src/tick.ts', import.meta.url), 'utf8');
    const adopt = src.indexOf('await adoptKeeperDeployments(resolved, chains)');
    const arm = src.indexOf('armEpochFence(resolved.DB, chains)');
    const fencedEnv = src.indexOf('DB: fencedD1(resolved.DB), KEEPER_DB: fencedD1(resolved.KEEPER_DB)');
    const launchLoop = src.indexOf('for (const pass of KEEPER_PASSES)');
    expect(adopt).toBeGreaterThan(0);
    expect(arm).toBeGreaterThan(adopt);
    expect(fencedEnv).toBeGreaterThan(arm);
    expect(launchLoop).toBeGreaterThan(fencedEnv);
    expect(src).toContain('pass.run(fenced, { scheduledTimeMs })');
    expect(src, 'no pass gets the raw env').not.toContain('pass.run(resolved');
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
