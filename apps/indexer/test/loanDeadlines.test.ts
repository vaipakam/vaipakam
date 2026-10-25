/**
 * #2808 — the loan routes date an Active loan on the D2 loan clock
 * (#668 / #935): the original due date moved by the protocol's paused time
 * since the loan's start, from the pause log and grace schedule the config
 * refresh snapshots. What the indexer does not know is said, never filled
 * in with the original date. Runs against the real migrated schema.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/env';
import { handleLoanById, handleLoansActive } from '../src/loanRoutes';
import { createSqliteD1 } from './helpers/sqliteD1';

const MIGRATIONS_DIR = new URL('../migrations/', import.meta.url);
const FILES = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort();
const load = (files: string[]) => files.map((f) => readFileSync(new URL(f, MIGRATIONS_DIR), 'utf8'));

const CHAIN = 84532;
const DAY = 86_400;
const NOW = 1_800_000_000;
const START = NOW - 20 * DAY; // a 30-day loan, 20 days in

type Deadlines = {
  available: boolean;
  reason?: string;
  originalMaturity?: number;
  pauseCredit?: number;
  maturity?: number;
  graceEnd?: number;
  pauseInForce?: boolean;
  asOf?: number;
};

function harness(files = FILES) {
  const h = createSqliteD1(load(files));
  const env = { DB: h.d1, RPC_BASE_SEPOLIA: 'http://127.0.0.1:9' } as unknown as Env;
  const seedLoan = (loanId: number, status = 'active') =>
    h.db
      .prepare(
        `INSERT INTO loans (chain_id, loan_id, offer_id, status, lender, borrower,
           principal, collateral_amount, asset_type, collateral_asset_type,
           lending_asset, collateral_asset, duration_days, token_id,
           collateral_token_id, lender_token_id, borrower_token_id,
           lender_current_owner, borrower_current_owner, interest_rate_bps,
           start_time, start_block, start_at, updated_at)
         VALUES (?, ?, 1, ?, '0xa', '0xb', '100', '200', 0, 0, '0xd', '0xc',
           30, '0', '0', '1', '2', '0xa', '0xb', 500, ?, 0, 0, 0)`,
      )
      .run(CHAIN, loanId, status, START);
  const seedClock = (grace: string | null, pauseLog: string | null) =>
    h.db
      .prepare(
        `INSERT INTO protocol_config
           (chain_id, bundle_json, master_flags_json, grace_buckets_json, pause_intervals_json,
            source_block, updated_at)
         VALUES (?, '[]', '[]', ?, ?, 1, ?)`,
      )
      .run(CHAIN, grace, pauseLog, NOW);
  const byId = async (loanId: number) =>
    (await (
      await handleLoanById(new Request(`https://idx/loans/${loanId}?chainId=${CHAIN}`), env, String(loanId))
    ).json()) as { deadlines?: Deadlines };
  const active = async () =>
    (await (
      await handleLoansActive(new Request(`https://idx/loans/active?chainId=${CHAIN}`), env)
    ).json()) as { loans: { loanId: number; deadlines?: Deadlines }[] };
  return { ...h, seedLoan, seedClock, byId, active };
}

/** A 2-day pause during the loan, long over. */
const CLOSED = JSON.stringify([
  { start: String(START + 3 * DAY), end: String(START + 5 * DAY), pausedBefore: '0' },
]);

describe('loan routes on the loan clock (#2808)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW * 1000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('serves the moved due date and grace end beside the original', async () => {
    const h = harness();
    h.seedClock('[]', CLOSED);
    h.seedLoan(1);
    const d = (await h.byId(1)).deadlines!;
    expect(d).toEqual({
      available: true,
      originalMaturity: START + 30 * DAY,
      pauseCredit: 2 * DAY,
      maturity: START + 32 * DAY,
      graceEnd: START + 32 * DAY + 3 * DAY, // 30-day loan: 3 days' default grace
      pauseInForce: false,
      asOf: NOW,
    });
    // The list routes date every loan at the same instant, the same way.
    const list = await h.active();
    expect(list.loans[0].deadlines).toEqual(d);
  });

  it('honours the snapshotted governance grace schedule', async () => {
    const h = harness();
    h.seedClock(JSON.stringify([{ maxDurationDays: '0', graceSeconds: String(10 * DAY) }]), '[]');
    h.seedLoan(1);
    const d = (await h.byId(1)).deadlines!;
    expect(d.pauseCredit).toBe(0);
    expect(d.graceEnd).toBe(START + 40 * DAY);
  });

  it('says a pause is in force, with the credit counted up to now', async () => {
    const h = harness();
    h.seedClock(
      '[]',
      JSON.stringify([{ start: String(NOW - DAY), end: '18446744073709551615', pausedBefore: '0' }]),
    );
    h.seedLoan(1);
    const d = (await h.byId(1)).deadlines!;
    expect(d.pauseInForce).toBe(true);
    expect(d.pauseCredit).toBe(DAY);
  });

  it('withholds the dates, by reason, when the clock inputs are not known', async () => {
    const noRow = harness();
    noRow.seedLoan(1);
    expect((await noRow.byId(1)).deadlines).toEqual({ available: false, reason: 'no-row' });

    const unread = harness();
    unread.seedClock('[]', null);
    unread.seedLoan(1);
    expect((await unread.byId(1)).deadlines).toEqual({ available: false, reason: 'pause-log-unread' });

    const damaged = harness();
    damaged.seedClock('[]', '[{"start":"9"}]');
    damaged.seedLoan(1);
    expect((await damaged.byId(1)).deadlines).toEqual({ available: false, reason: 'damaged' });
  });

  it('tolerates a database the pause-log migration has not reached', async () => {
    const h = harness(FILES.filter((f) => f !== '0072_protocol_config_pause_log.sql'));
    h.seedLoan(1);
    h.db
      .prepare(
        `INSERT INTO protocol_config (chain_id, bundle_json, master_flags_json, grace_buckets_json,
           source_block, updated_at) VALUES (?, '[]', '[]', '[]', 1, ?)`,
      )
      .run(CHAIN, NOW);
    expect((await h.byId(1)).deadlines).toEqual({ available: false, reason: 'pre-migration' });
  });

  it('omits deadlines for a loan that is no longer Active', async () => {
    const h = harness();
    h.seedClock('[]', CLOSED);
    h.seedLoan(1, 'repaid');
    expect((await h.byId(1)).deadlines).toBeUndefined();
  });
});
