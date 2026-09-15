/**
 * The periodic-interest lane respects the loan quarantine (#2213 r2
 * `4011776403`).
 *
 * This lane sends a payment-due Push/Telegram and stamps the checkpoint
 * permanently — an unretractable message, derived from `status = 'active'` in
 * the shared D1. A loan whose terminal event the indexer missed for good sits
 * at exactly that status, which is why `loan_reconcile_quarantine` exists.
 *
 * The indexer's calendar sweep was taught to withhold those. THIS lane was
 * not, and reads the same rows from the same database — so a user could
 * still be told their payment was due on a loan the chain says has ended,
 * while every other reminder for it was correctly suppressed. Two lanes, one
 * rule; these cases pin that this one applies it.
 */
import { describe, it, expect, vi } from 'vitest';
import { quarantineExclusionSql } from '@vaipakam/lib/reminderEligibility';

/**
 * A D1 fake that records the SQL it was asked to prepare.
 *
 * The assertion is on the QUERY rather than on which rows came back: the
 * exclusion is a `WHERE` clause, so "did it reach the query" is the claim,
 * and a row-level assertion would pass just as well against a post-select
 * filter — which is the thing the shared rule deliberately is not.
 */
function recordingDb(hasQuarantineTable: boolean) {
  const prepared: string[] = [];
  const db = {
    prepare(sql: string) {
      prepared.push(sql);
      return {
        bind: () => ({
          all: async () => ({ results: [] }),
          first: async () => null,
          run: async () => ({ meta: { changes: 0 } }),
        }),
        // The availability probe reads `sqlite_master` with no binds.
        first: async () =>
          hasQuarantineTable && sql.includes('sqlite_master')
            ? { name: 'loan_reconcile_quarantine' }
            : null,
        all: async () => ({ results: [] }),
        run: async () => ({ meta: { changes: 0 } }),
      };
    },
  };
  return { db, prepared };
}

/** The loan-selection query, found by a column only it selects. */
const loanSelect = (prepared: string[]) =>
  prepared.find((s) => s.includes('periodic_interest_cadence') && s.includes('FROM loans'));

async function runLane(hasTable: boolean) {
  vi.resetModules();
  const { db, prepared } = recordingDb(hasTable);
  const mod = await import('../src/periodicPreNotify');
  const env = {
    DB: db,
    // One chain, an RPC that cannot answer — the lead-time read falls back to
    // its default, which is the documented behaviour and keeps this test off
    // the network.
    RPC_BASE_SEPOLIA: 'http://127.0.0.1:1/unused',
  } as never;
  await mod.runPeriodicPreNotify(env).catch(() => undefined);
  return { prepared, sql: loanSelect(prepared) };
}

describe('periodic-interest pre-notify and the quarantine', () => {
  it('excludes quarantined loans from the lane that sends payment-due messages', async () => {
    const { sql } = await runLane(true);
    expect(sql).toBeDefined();
    // The SHARED predicate, not a copy of it: comparing against the exported
    // rule is what makes a future divergence fail here rather than drift.
    expect(sql?.replace(/\s+/g, ' ')).toContain(
      quarantineExclusionSql('loans').replace(/\s+/g, ' '),
    );
  });

  it('still selects loans when the quarantine table is not there yet', async () => {
    // The deploy window (#2214): the Worker is published before its
    // migrations are applied. Naming a missing table would fail this query
    // and silence the whole lane — worse than the defect, and for every loan
    // rather than the unconfirmed ones.
    const { sql } = await runLane(false);
    expect(sql).toBeDefined();
    expect(sql).not.toContain('loan_reconcile_quarantine');
    expect(sql).toContain("status = 'active'");
  });
});
