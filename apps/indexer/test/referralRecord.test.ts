/**
 * #3727 — the referral record behind the inviter's page, pinned against
 * the REAL migrated schema: ingest of `InviterBound` and
 * `ReferralShareSettled`, replay idempotence, the refusal to guess an
 * unknown outcome, and the page's read (per-asset totals, the redirect
 * reason as the event gave it, the block the figures are current to).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import {
  inviterReferrals,
  recordReferralLogs,
  totalsPerAsset,
  type ReferralLog,
} from '../src/referralRecord';
import { createSqliteD1 } from './helpers/sqliteD1';

const MIGRATIONS_DIR = new URL('../migrations/', import.meta.url);
const ALL_MIGRATIONS = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => readFileSync(new URL(f, MIGRATIONS_DIR), 'utf8'));

const CHAIN = 84532;
const INVITER = '0x00000000000000000000000000000000000000AA';
const USER_A = '0x00000000000000000000000000000000000000A1';
const USER_B = '0x00000000000000000000000000000000000000B1';
const USDC = '0x00000000000000000000000000000000000000C1';
const WETH = '0x00000000000000000000000000000000000000C2';

function harness() {
  const h = createSqliteD1(ALL_MIGRATIONS);
  const env = { DB: h.d1 } as unknown as Env;
  return { h, env, db: h.d1 as D1Database };
}

const bound = (newUser: string, block: bigint, logIndex = 0): ReferralLog => ({
  eventName: 'InviterBound',
  args: { newUser, inviter: INVITER, endsAt: 1_800_000_000n },
  blockNumber: block,
  transactionHash: `0xb${block}`,
  logIndex,
});

const settled = (
  loanId: bigint,
  newUser: string,
  asset: string,
  share: bigint,
  outcome: number,
  block: bigint,
  logIndex = 0,
): ReferralLog => ({
  eventName: 'ReferralShareSettled',
  args: { loanId, newUser, inviter: INVITER, asset, offerId: loanId + 100n, cut: share * 10n, share, outcome },
  blockNumber: block,
  transactionHash: `0xs${block}`,
  logIndex,
});

const times = (...blocks: bigint[]) => new Map(blocks.map((b) => [b, 1_700_000_000 + Number(b)]));

describe('totalsPerAsset', () => {
  it('sums exactly per asset and never across assets', () => {
    expect(
      totalsPerAsset([
        { asset: '0xb', share: '1' },
        { asset: '0xa', share: '99999999999999999999' },
        { asset: '0xa', share: '1' },
      ]),
    ).toEqual([
      { asset: '0xa', amount: '100000000000000000000' },
      { asset: '0xb', amount: '1' },
    ]);
  });
});

describe('recordReferralLogs', () => {
  it('records both events once, and a replay changes nothing', async () => {
    const { h, db } = harness();
    const logs = [bound(USER_A, 10n), settled(1n, USER_A, USDC, 50n, 0, 11n)];
    expect(await recordReferralLogs(db, CHAIN, logs, times(10n, 11n))).toBe(2);
    await recordReferralLogs(db, CHAIN, logs, times(10n, 11n));
    const b = h.db.prepare('SELECT COUNT(*) AS n FROM referral_binding').get() as { n: number };
    const s = h.db.prepare('SELECT COUNT(*) AS n FROM referral_share').get() as { n: number };
    expect([b.n, s.n]).toEqual([1, 1]);
    const row = h.db.prepare('SELECT inviter, asset, share, cut FROM referral_share').get() as Record<string, string>;
    expect(row).toEqual({ inviter: INVITER.toLowerCase(), asset: USDC.toLowerCase(), share: '50', cut: '500' });
  });

  it('skips an outcome this build does not know rather than guessing a reason', async () => {
    const { h, db } = harness();
    expect(await recordReferralLogs(db, CHAIN, [settled(1n, USER_A, USDC, 5n, 9, 11n)], times(11n))).toBe(0);
    const s = h.db.prepare('SELECT COUNT(*) AS n FROM referral_share').get() as { n: number };
    expect(s.n).toBe(0);
  });

  it('refuses a block it has no chain time for', async () => {
    const { db } = harness();
    await expect(recordReferralLogs(db, CHAIN, [bound(USER_A, 10n)], new Map())).rejects.toThrow(/no chain time/);
  });
});

describe('inviterReferrals', () => {
  it('builds the page from the two events only', async () => {
    const { h, env, db } = harness();
    await recordReferralLogs(
      db,
      CHAIN,
      [
        bound(USER_A, 10n),
        bound(USER_B, 12n),
        settled(1n, USER_A, USDC, 50n, 0, 13n),
        settled(2n, USER_A, WETH, 7n, 0, 14n),
        settled(3n, USER_B, USDC, 25n, 0, 15n),
        settled(4n, USER_B, USDC, 30n, 3, 16n), // payment failed → reserve
        settled(5n, USER_B, USDC, 0n, 1, 17n), // no share: neither list
      ],
      times(10n, 12n, 13n, 14n, 15n, 16n, 17n),
    );
    h.db.prepare(`INSERT INTO indexer_cursor (chain_id, kind, last_block, updated_at) VALUES (?, 'diamond', 17, 0)`).run(CHAIN);

    const page = await inviterReferrals(env, CHAIN, INVITER, 'diamond');
    expect(page.indexedThroughBlock).toBe(17);
    expect(page.invited.rows.map((r) => [r.wallet, r.loansWithShare])).toEqual([
      [USER_B.toLowerCase(), 2],
      [USER_A.toLowerCase(), 2],
    ]);
    expect(page.received.rows.map((r) => r.loanId)).toEqual(['3', '2', '1']);
    expect(page.received.totals).toEqual([
      { asset: USDC.toLowerCase(), amount: '75' },
      { asset: WETH.toLowerCase(), amount: '7' },
    ]);
    expect(page.sentToReserve.rows).toHaveLength(1);
    expect(page.sentToReserve.rows[0]).toMatchObject({ loanId: '4', outcome: 'payment-failed', share: '30' });
    expect(page.invited.truncated || page.received.truncated || page.sentToReserve.truncated).toBe(false);
  });

  it('says the indexer has not started rather than inventing a block', async () => {
    const { env } = harness();
    const page = await inviterReferrals(env, CHAIN, INVITER, 'diamond');
    expect(page.indexedThroughBlock).toBeNull();
    expect(page.received.totals).toEqual([]);
  });
});
