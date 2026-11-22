// Tests for contracts/script/check-gas-budgets.mjs (#3915).
// Run: node --test packages/contracts/scripts/gas-budgets.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compareBudgets, largestInstantCount, readMeasurements } from '../../../contracts/script/check-gas-budgets.mjs';

const R = 'the measured figure on the first suite run, with mocked oracles';
const budgets = (actions, extra = {}) => ({ blocking: false, lowerAt: 0.8, actions, ...extra });
const m = (gas) => ({ gas, slotsWritten: 1, slotsRead: 1, facetCalls: 0, events: 1 });

test('over a budget is a finding; well under asks for a lower budget; within is quiet', () => {
  const b = budgets({ a: { gas: 100_000, reason: R }, b: { gas: 100_000, reason: R }, c: { gas: 100_000, reason: R } });
  const r = compareBudgets(b, { a: m(100_001), b: m(79_000), c: m(90_000) });
  assert.deepEqual(r.findings, ['a: 100001 gas, over its budget of 100000 by 1']);
  assert.match(r.notes[0], /^b: .*lower the budget/);
  assert.deepEqual(r.refusals, []);
});

test('a budget with no measurement, and a measurement with no budget, are findings', () => {
  const r = compareBudgets(budgets({ gone: { gas: 1, reason: R } }), { fresh: m(5) });
  assert.ok(r.findings.some((f) => /gone: has a budget but no measurement/.test(f)));
  assert.ok(r.findings.some((f) => /fresh: measured but has no budget/.test(f)));
});

test('a raise without a changed reason is refused against the base; with a new reason it passes', () => {
  const base = budgets({ a: { gas: 100, reason: R } });
  assert.match(compareBudgets(budgets({ a: { gas: 120, reason: R } }), { a: m(110) }, base).refusals[0], /raised from 100 to 120 without a changed reason/);
  assert.deepEqual(compareBudgets(budgets({ a: { gas: 120, reason: `${R}; raised for the new screen` } }), { a: m(110) }, base).refusals, []);
  assert.deepEqual(compareBudgets(budgets({ a: { gas: 90, reason: R } }), { a: m(89) }, base).refusals, [], 'a lowering needs no new reason');
  assert.match(compareBudgets(budgets({ a: { gas: 100, reason: 'short' } }), { a: m(90) }).refusals[0], /needs a reason/);
});

test('instant borrow: the largest count within the headroom of the smallest network limit must match maxSources', () => {
  const ib = { actionPrefix: 'ib_', sources: [1, 2, 4, 8], headroom: 0.8, maxSources: 4, networkTxGasLimits: { eth: { gas: 1_000_000, why: 'x' }, arb: { gas: 2_000_000, why: 'y' } } };
  const meas = { ib_1: m(200_000), ib_2: m(400_000), ib_4: m(790_000), ib_8: m(1_500_000) };
  assert.deepEqual(largestInstantCount({ instantBorrow: ib }, meas), { limit: 1_000_000, cap: 800_000, best: 4 });
  const rows = Object.fromEntries(Object.keys(meas).map((k) => [k, { gas: 2_000_000, reason: R }]));
  assert.ok(!compareBudgets(budgets(rows, { instantBorrow: ib }), meas).findings.some((f) => /instantBorrow/.test(f)));
  assert.match(compareBudgets(budgets(rows, { instantBorrow: { ...ib, maxSources: 8 } }), meas).findings.find((f) => /instantBorrow/.test(f)), /is 4, but maxSources says 8/);
});

test('the suite\'s own probes are ignored', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gas-'));
  writeFileSync(join(dir, '_probe_warm_1.json'), JSON.stringify({ action: '_probe_warm_1', gas: 1 }));
  writeFileSync(join(dir, 'offer_post.json'), JSON.stringify({ action: 'offer_post', gas: 2 }));
  assert.deepEqual(Object.keys(readMeasurements(dir)), ['offer_post']);
});
