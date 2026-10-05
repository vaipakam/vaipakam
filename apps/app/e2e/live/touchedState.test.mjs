/**
 * #2422 r6 — the touched-state ledger's diff and remedy rules. A live drive
 * reaches them only after a failure, which a healthy run never has, so
 * every rule is pinned here.
 */
import { describe, expect, it } from 'vitest';

import { formatLedgerRow, ledgerRows } from './touchedState.mjs';

const allowance = {
  key: 'borrowerAllowance',
  label: 'borrower allowance',
  touchedBy: ['b-approve-reset', 'b-approve-set', 'l-accept'],
  format: (v) => `${v}`,
  restore: (baseline) => `approve(Diamond, ${baseline})`,
};
const ok = (value) => ({ ok: true, value });
const rowFor = (b, n, consumed) => ledgerRows([allowance], { borrowerAllowance: b }, { borrowerAllowance: n }, consumed)[0];

describe('ledgerRows — what changed, who changed it, how to put it back', () => {
  it('restores the BASELINE, never a blanket zero, when this run changed it', () => {
    const r = rowFor(ok(7n), ok(100n), ['b-approve-set']);
    expect(r.status).toBe('changed-by-run');
    expect(r.remedy).toBe('approve(Diamond, 7)'); // the pre-run grant comes back
    expect(r.touchedSteps).toEqual(['b-approve-set']);
  });

  it('offers no remedy for state this run did not change — a pre-existing grant stays', () => {
    // The approval step was skipped because a pre-run allowance covered the
    // payoff: nothing consumed touches it, and it is unchanged.
    const r = rowFor(ok(500n), ok(500n), ['b-caps', 'b-create']);
    expect(r).toMatchObject({ status: 'unchanged', remedy: null });
  });

  it('calls a change it did not make "not this run’s", with no remedy', () => {
    const r = rowFor(ok(500n), ok(0n), ['b-create']);
    expect(r).toMatchObject({ status: 'changed-not-by-run', remedy: null });
  });

  it('reports back-at-baseline as unchanged even when a step touched it', () => {
    expect(rowFor(ok(0n), ok(0n), ['b-approve-set', 'l-accept']).status).toBe('unchanged');
  });

  it('is UNKNOWN when either read failed — never compared with a guess', () => {
    const r = rowFor({ ok: false, error: 'rpc down' }, ok(1n), ['b-approve-set']);
    expect(r.status).toBe('unknown');
    expect(r.baselineText).toMatch(/UNREADABLE \(rpc down\)/);
    expect(rowFor(ok(1n), undefined, []).status).toBe('unknown');
  });

  it('states an irreversible change instead of inventing a fix', () => {
    const loanStatus = { key: 'oldLoan', label: 'old loan', touchedBy: ['l-accept'], format: String, restore: () => null };
    const [r] = ledgerRows([loanStatus], { oldLoan: ok(0) }, { oldLoan: ok(1) }, ['l-accept']);
    expect(r.status).toBe('changed-by-run');
    expect(r.remedy).toMatch(/cannot be restored/);
  });

  it('compares structured values (caps) field by field', () => {
    const caps = { key: 'caps', label: 'caps', touchedBy: ['b-caps'], format: (v) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? `${x}` : x)), restore: (b) => `restore ${b.maxRateBps}` };
    const base = { enabled: false, maxRateBps: 0, maxNewExpiry: 0n };
    expect(ledgerRows([caps], { caps: ok(base) }, { caps: ok({ ...base }) }, ['b-caps'])[0].status).toBe('unchanged');
    const [r] = ledgerRows([caps], { caps: ok(base) }, { caps: ok({ ...base, enabled: true, maxRateBps: 1200 }) }, ['b-caps']);
    expect(r).toMatchObject({ status: 'changed-by-run', remedy: 'restore 0' });
  });

  it('prints status, both readings and the remedy', () => {
    const text = formatLedgerRow(rowFor(ok(7n), ok(100n), ['b-approve-set']));
    expect(text).toMatch(/CHANGED BY THIS RUN \(b-approve-set\)/);
    expect(text).toMatch(/baseline: 7/);
    expect(text).toMatch(/now: {6}100/);
    expect(text).toMatch(/REMEDY: {3}approve\(Diamond, 7\)/);
  });
});
