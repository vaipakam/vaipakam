// Tests for contracts/script/check-gas-budgets.mjs (#3915).
// Run: node --test packages/contracts/scripts/gas-budgets.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compareBudgets, fullGas, guardReadCost, instantCosts, largestInstantCount, readMeasurements, sourceRuleCost, withGuardReadCost, main, budgetRaises } from '../../../contracts/script/check-gas-budgets.mjs';

const R = 'the measured figure on the first suite run, with mocked oracles';
const budgets = (actions, extra = {}) => ({ blocking: false, lowerAt: 0.8, actions, ...extra });
const m = (gas) => ({ gas, slotsWritten: 1, slotsRead: 1, facetCalls: 0, events: 1 });

/** Attaches a guard rig whose one read costs `gas` with no source calls. */
// A rig whose read costs `gas` above the suite guard's own read (100).
const withRig = (meas, gas) => {
  Object.defineProperty(meas, '__guardRig', { value: { reads: [{ read: 'r', gas: gas + 100, sourceCalls: {} }] }, enumerable: false });
  return Object.defineProperty(meas, '__guardSuiteRead', { value: { read: 's', gas: 100 }, enumerable: false });
};

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

test('--raises-only checks the raise rule with no measurements, and a named base that is missing refuses', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gas-'));
  const cur = join(dir, 'budgets.json');
  const base = join(dir, 'base.json');
  writeFileSync(cur, JSON.stringify(budgets({ a: { gas: 120, reason: R }, b: { gas: 50, reason: R } })));
  writeFileSync(base, JSON.stringify(budgets({ a: { gas: 100, reason: R }, b: { gas: 50, reason: R } })));
  const quiet = (fn) => { const [l, e] = [console.log, console.error]; console.log = console.error = () => {}; try { return fn(); } finally { console.log = l; console.error = e; } };
  assert.equal(quiet(() => main(['--raises-only', '--budgets', cur, '--base', base])), 1);
  writeFileSync(base, JSON.stringify(budgets({ a: { gas: 120, reason: R }, b: { gas: 50, reason: R } })));
  assert.equal(quiet(() => main(['--raises-only', '--budgets', cur, '--base', base])), 0);
  assert.equal(quiet(() => main(['--raises-only', '--budgets', cur])), 2, 'the raise rule needs a base');
  assert.equal(quiet(() => main(['--raises-only', '--budgets', cur, '--base', join(dir, 'none.json')])), 1, 'a named base that is missing is never a pass');
  // A row with no measurement still has its raise checked.
  assert.deepEqual(budgetRaises(budgets({ z: { gas: 2, reason: R } }), budgets({ z: { gas: 1, reason: R } })), ['z: budget raised from 1 to 2 without a changed reason']);
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

test('the source rule: reads at their measured cost, one budget in hand, the skip allowance, for every bound', () => {
  const ib = {
    actionPrefix: 'ib_', sources: [1, 2, 4], headroom: 0.8, maxSources: 1, deployBound: 2,
    guardReadBudget: 50_000, skipAllowance: 1,
    skipActions: ['ib_1_skip_a', 'ib_1_skip_b'],
    networkTxGasLimits: { eth: { gas: 1_000_000, why: 'x' } },
  };
  const g = (gas, guardReads) => ({ ...m(gas), guardReads });
  const meas = withRig({ ib_1: g(100_000, 10), ib_2: g(190_000, 20), ib_4: g(400_000, 40), ib_1_skip_a: g(105_000, 10), ib_1_skip_b: g(150_000, 15) }, 1_000);
  const c = instantCosts({ ...ib, guardReadCost: 1_000 }, meas);
  // first 110,000; 2: 210,000 (+100,000); 4: 440,000 (+115,000 each); skips +5,000 and +55,000.
  assert.deepEqual(c, { first: 110_000, perFill: 115_000, skip: 55_000 });
  assert.equal(sourceRuleCost(c, 2, 1, 50_000), 110_000 + 115_000 + 55_000 + 50_000);
  Object.defineProperty(meas, '__instantConfig', { value: { defaultBound: 3, topBound: 6, maxSources: 3 }, enumerable: false });
  const rows = Object.fromEntries(Object.keys(meas).map((k) => [k, { gas: 2_000_000, reason: R }]));
  const f = compareBudgets(budgets(rows, { instantBorrow: { ...ib, maxSources: 4 } }), meas).findings.filter((x) => /bound of|accepts a list/.test(x));
  // bound 2: 330k; bound 3: 445k; bound 6: 110k + 575k + 55k + 50k = 790k: all within 800k. A list of 3 = 2 + 1.
  assert.deepEqual(f, []);
  const tight = { ...ib, maxSources: 4, networkTxGasLimits: { eth: { gas: 600_000, why: 'x' } } };
  const f2 = compareBudgets(budgets(rows, { instantBorrow: tight }), meas).findings.filter((x) => /bound of/.test(x));
  assert.equal(f2.length, 1, f2.join('\n'));
  assert.match(f2[0], /bound of 6 \(the top of the governance range\) with 1 skip\(s\) needs 790000 gas/);
});

test('the source rule: a code list cap above the bound plus the skip allowance is a finding', () => {
  const ib = {
    actionPrefix: 'ib_', sources: [1, 2], headroom: 0.8, maxSources: 2, deployBound: 2,
    guardReadBudget: 0, skipAllowance: 1, skipActions: ['ib_1_skip'],
    networkTxGasLimits: { eth: { gas: 10_000_000, why: 'x' } },
  };
  const meas = withRig({ ib_1: m(100), ib_2: m(200), ib_1_skip: m(150) }, 1);
  Object.defineProperty(meas, '__instantConfig', { value: { defaultBound: 2, topBound: 2, maxSources: 16 }, enumerable: false });
  const rows = Object.fromEntries(Object.keys(meas).map((k) => [k, { gas: 1_000, reason: R }]));
  assert.ok(compareBudgets(budgets(rows, { instantBorrow: ib }), meas).findings.some((x) => /accepts a list of 16 sources, over the bound 2 plus the skip allowance 1/.test(x)));
  const noRig = { ib_1: m(100), ib_2: m(200), ib_1_skip: m(150) };
  Object.defineProperty(noRig, '__instantConfig', { value: meas.__instantConfig, enumerable: false });
  const r = compareBudgets(budgets(rows, { instantBorrow: { ...ib, guardReadCost: 5 } }), noRig).refusals;
  assert.ok(r.some((x) => /guard rig was not run/.test(x)), r.join('\n'));
});

test('a guard read costs its rig gas plus each source call at its measured cost, and an unpriced source refuses', () => {
  const ib = { guardSourceCosts: { tellor: { gas: 100 }, pyth: { gas: 10 } } };
  const rig = { reads: [{ read: 'a', gas: 1_000, sourceCalls: { tellor: 2, pyth: 1 } }, { read: 'b', gas: 1_150, sourceCalls: { pyth: 0 } }] };
  const suite = { read: 's', gas: 200 };
  // The worst read is 1,210; the suite's figures already hold 200 of it.
  assert.deepEqual(guardReadCost(ib, rig, suite), { cost: 1_010, read: 'a', worst: 1_210, suite: 200 });
  assert.match(guardReadCost(ib, { reads: [{ read: 'c', gas: 1, sourceCalls: { dia: 1 } }] }, suite).problem, /calls dia, which has no measured cost/);
  assert.match(guardReadCost(ib, undefined, suite).problem, /was not run/);
  assert.match(guardReadCost(ib, rig, undefined).problem, /suite guard's own read was not measured/);
});

test('a read already in the measured gas at the suite guard\'s cost is counted once, at its worst', () => {
  const ib = { actionPrefix: 'ib_', guardSourceCosts: {} };
  const meas = { ib_1: { ...m(10_000), guardPriceReads: 3 } };
  Object.defineProperty(meas, '__guardRig', { value: { reads: [{ read: 'r', gas: 900, sourceCalls: {} }] }, enumerable: false });
  Object.defineProperty(meas, '__guardSuiteRead', { value: { read: 's', gas: 300 }, enumerable: false });
  const b = withGuardReadCost({ instantBorrow: ib }, meas);
  // 10,000 already holds three reads at >= 300 each; each is lifted to 900.
  assert.equal(fullGas(b.instantBorrow, meas.ib_1), 10_000 + 3 * 600);
});

test('the suite read file is read beside the measurements', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gas-'));
  mkdirSync(join(dir, 'config'));
  writeFileSync(join(dir, 'config', 'guard-suite-read.json'), JSON.stringify({ read: 'getAssetPrice', gas: 4_321 }));
  assert.deepEqual(readMeasurements(dir).__guardSuiteRead, { read: 'getAssetPrice', gas: 4_321 });
});

test('the source rule without its measurements or the code bounds is a finding, never a silent pass', () => {
  const ib = { actionPrefix: 'ib_', sources: [1, 2], headroom: 0.8, maxSources: 2, deployBound: 2, skipAllowance: 1, skipActions: ['ib_1_skip'], networkTxGasLimits: { eth: { gas: 10_000_000, why: 'x' } } };
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

test('the source rule counts the calls that price an asset, not the guard\'s other views', () => {
  const ib = { guardReadCost: 1_000 };
  assert.equal(fullGas(ib, { gas: 10_000, guardReads: 9, guardPriceReads: 2 }), 12_000);
  assert.equal(fullGas(ib, { gas: 10_000, guardReads: 9 }), 19_000, 'an older measurement without the split counts every call');
});
