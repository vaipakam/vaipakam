// Tests for contracts/script/check-gas-budgets.mjs (#3915).
// Run: node --test packages/contracts/scripts/gas-budgets.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compareBudgets, instantCosts, largestInstantCount, readMeasurements, sourceRuleCost } from '../../../contracts/script/check-gas-budgets.mjs';

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
  const count = (f) => /largest source count/.test(f);
  assert.ok(!compareBudgets(budgets(rows, { instantBorrow: ib }), meas).findings.some(count));
  assert.match(compareBudgets(budgets(rows, { instantBorrow: { ...ib, maxSources: 8 } }), meas).findings.find(count), /is 4, but maxSources says 8/);
});

test('the suite\'s own probes are ignored', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gas-'));
  writeFileSync(join(dir, '_probe_warm_1.json'), JSON.stringify({ action: '_probe_warm_1', gas: 1 }));
  writeFileSync(join(dir, 'offer_post.json'), JSON.stringify({ action: 'offer_post', gas: 2 }));
  assert.deepEqual(Object.keys(readMeasurements(dir)), ['offer_post']);
});

test('the source rule: guard reads at their full budget, the dearest further fill and skip, for every bound', () => {
  const ib = {
    actionPrefix: 'ib_', sources: [1, 2, 4], headroom: 0.8, maxSources: 1, deployBound: 2, guardReadGas: 1_000,
    skipActions: ['ib_1_skip_a', 'ib_1_skip_b'],
    networkTxGasLimits: { eth: { gas: 1_000_000, why: 'x' } },
  };
  const g = (gas, guardReads) => ({ ...m(gas), guardReads });
  const meas = { ib_1: g(100_000, 10), ib_2: g(190_000, 20), ib_4: g(400_000, 40), ib_1_skip_a: g(105_000, 10), ib_1_skip_b: g(150_000, 15) };
  const c = instantCosts(ib, meas);
  // first 110,000; 2: 210,000 (+100,000); 4: 440,000 (+115,000 each); skips +5,000 and +55,000.
  assert.deepEqual(c, { first: 110_000, perFill: 115_000, skip: 55_000 });
  assert.equal(sourceRuleCost(c, 2, 4), 110_000 + 115_000 + 2 * 55_000);
  Object.defineProperty(meas, '__instantConfig', { value: { defaultBound: 3, topBound: 6, maxSources: 6 }, enumerable: false });
  const rows = Object.fromEntries(Object.keys(meas).map((k) => [k, { gas: 2_000_000, reason: R }]));
  const f = compareBudgets(budgets(rows, { instantBorrow: { ...ib, maxSources: 4 } }), meas).findings.filter((x) => /bound of/.test(x));
  // bound 2: 110k + 115k + 4×55k = 445k, fits 800k; bound 3: 110k + 230k + 3×55k = 505k fits; bound 6: 110k + 575k = 685k fits.
  assert.deepEqual(f, []);
  const tight = { ...ib, maxSources: 4, networkTxGasLimits: { eth: { gas: 600_000, why: 'x' } } };
  const f2 = compareBudgets(budgets(rows, { instantBorrow: tight }), meas).findings.filter((x) => /bound of/.test(x));
  assert.equal(f2.length, 2, f2.join('\n'));
  assert.match(f2[0], /bound of 3 \(the code default\) with a list of 6 needs 505000 gas/);
  assert.match(f2[1], /bound of 6 \(the top of the governance range\)/);
});

test('the source rule without its measurements or the code bounds is a finding, never a silent pass', () => {
  const ib = { actionPrefix: 'ib_', sources: [1, 2], headroom: 0.8, maxSources: 2, deployBound: 2, guardReadGas: 0, skipActions: ['ib_1_skip'], networkTxGasLimits: { eth: { gas: 10_000_000, why: 'x' } } };
  const meas = { ib_1: m(1), ib_2: m(2) };
  const rows = { ib_1: { gas: 10, reason: R }, ib_2: { gas: 10, reason: R } };
  assert.ok(compareBudgets(budgets(rows, { instantBorrow: ib }), meas).findings.some((x) => /needs instant borrow at 1/.test(x)));
  meas.ib_1_skip = m(3);
  rows.ib_1_skip = { gas: 10, reason: R };
  assert.ok(compareBudgets(budgets(rows, { instantBorrow: ib }), meas).findings.some((x) => /needs the code's fill bounds/.test(x)));
});

test('the code bounds file is read beside the measurements and is not an action', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gas-'));
  writeFileSync(join(dir, 'a.json'), JSON.stringify({ action: 'a', ...m(1) }));
  mkdirSync(join(dir, 'config'));
  writeFileSync(join(dir, 'config', 'instant.json'), JSON.stringify({ defaultBound: 8, topBound: 16, maxSources: 16 }));
  const r = readMeasurements(dir);
  assert.deepEqual(Object.keys(r), ['a']);
  assert.deepEqual(r.__instantConfig, { defaultBound: 8, topBound: 16, maxSources: 16 });
});
