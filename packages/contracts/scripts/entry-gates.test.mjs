// Tests for contracts/script/check-entry-gates.mjs (#3944, ReviewCoveragePassDesign
// §3.4, §10.18, §10.19). The fixture is solc's own AST of fixtures/entry-gates.
// Run: node --test packages/contracts/scripts/entry-gates.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applies, checklist, compareRules, readEntry, rulesProblems } from '../../../contracts/script/check-entry-gates.mjs';
import { entryPoints } from '../../../contracts/script/check-permissionless-steps.mjs';
import { makeContext } from '../../../contracts/script/refactor-reports.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const UNITS = Object.values(JSON.parse(readFileSync(join(HERE, 'fixtures', 'entry-gates', 'ast.json'), 'utf8')).units);
const shipped = ['GFacet', 'HostFacet'];
const ctx = makeContext(UNITS, shipped);
const { entries } = entryPoints(UNITS, shipped, ctx.byId);
const entry = (name) => entries.find((e) => e.contract === 'GFacet' && e.name === name);
const carried = (name, gates) => readEntry(entry(name).fn, ctx.contracts.get('GFacet'), ctx, new Set(gates));

const FLAG = 'LibGate.requireNotFlagged';
const rule = (over = {}) => ({
  id: 'screen-flagged',
  statement: 'Every GFacet entry refuses a flagged wallet before it changes state.',
  appliesTo: { contracts: ['GFacet'], caller: 'open' },
  check: { anyOf: [{ call: FLAG }] },
  ...over,
});
const run = (doc) => compareRules(doc, entries, { shipped, ctx });
const flagged = (doc) => run(doc).findings.map((f) => f.entry.replace(/^GFacet\./, '').replace(/\(.*$/, '')).sort();

test('reading: modifiers, calls before the first state change, and where it stopped', () => {
  const good = carried('good');
  assert.deepEqual(good.modifiers, ['nonReentrant', 'whenNotPaused']);
  assert.ok(good.calls.has('LibGate.requireNotPaused'), 'a modifier body counts up to its _');
  assert.ok(good.calls.has(FLAG));
  assert.equal(good.stoppedAt, 'a storage write');
  assert.ok(!carried('writesFirst').calls.has(FLAG), 'a check after a storage write does not count');
  assert.equal(carried('writesThroughPointer').stoppedAt, 'a storage push');
  assert.ok(carried('viaHelper').calls.has(FLAG), 'an internal helper is read in place');
  assert.equal(carried('branchOnly').calls.get(FLAG).conditional, true);
  assert.match(carried('externalFirst').stoppedAt, /external call \(IOther\.poke\)/);
  assert.match(carried('externalWithOptionsFirst').stoppedAt, /external call \(IOther\.pay\)/, 'call options {value, gas} do not hide the call');
  assert.match(carried('selfMutateFirst').stoppedAt, /call back into the Diamond \(HostFacet\.mutate\)/);
  assert.ok(carried('viaHost').calls.has('HostFacet.requireTerms'), 'a self-call to a view host is a check, read through');
  assert.equal(carried('viaHelperEarlyReturn').calls.get(FLAG).conditional, true, 'a check after a helper\'s early return runs on some paths only');
  assert.equal(carried('viaHelper').calls.get(FLAG).conditional, false);
  const out = carried('modifierCallsOut');
  assert.match(out.stoppedAt, /external call \(IOther\.poke\)/, 'a modifier is exempt for its lock writes, not for a call out');
  assert.ok(!out.calls.has(FLAG));
  const helperMod = carried('viaModifiedHelper');
  assert.match(helperMod.stoppedAt, /external call \(IOther\.poke\)/, 'a helper\'s modifier runs before its body');
  assert.ok(!helperMod.calls.has(FLAG));
  const post = carried('viaPostambleHelper');
  assert.match(post.stoppedAt, /external call \(IOther\.poke\)/, 'a helper modifier\'s code after the placeholder runs before the caller resumes');
  assert.ok(!post.calls.has(FLAG));
  assert.equal(carried('viaMaybeHelper').calls.get(FLAG).conditional, true, 'a modifier that may skip its placeholder makes the helper body conditional');
});

test('the gate check reports the entry and the rule, and passes it once given the check (§10.18)', () => {
  assert.deepEqual(flagged({ rules: [rule()] }), ['branchOnly', 'externalFirst', 'externalWithOptionsFirst', 'modifierCallsOut', 'selfMutateFirst', 'viaHelperEarlyReturn', 'viaHost', 'viaMaybeHelper', 'viaModifiedHelper', 'viaPostambleHelper', 'writesFirst', 'writesThroughPointer']);
  const f = run({ rules: [rule()] }).findings.find((x) => x.entry.startsWith('GFacet.writesFirst'));
  assert.equal(f.rule, 'screen-flagged');
  assert.match(f.why, /none of LibGate\.requireNotFlagged before a storage write/);
  assert.match(run({ rules: [rule()] }).findings.find((x) => x.entry.startsWith('GFacet.branchOnly')).why, /only on some paths/);
  // The Diamond-only entry is caller-gated, so an "open" rule skips it.
  assert.ok(!flagged({ rules: [rule()] }).includes('internalOnly'));
  // Another check in anyOf satisfies it.
  assert.ok(!flagged({ rules: [rule({ check: { anyOf: [{ call: FLAG }, { call: 'HostFacet.requireTerms' }] } })] }).includes('viaHost'));
});

test('an exemption passes an entry with a reason, and is refused without one, when stale, or when needless', () => {
  const key = entry('writesFirst').key;
  const ok = run({ rules: [rule({ exempt: { [key]: 'writes only a counter the screen itself reads first' } })] });
  assert.ok(!ok.findings.some((f) => f.entry === key));
  assert.deepEqual(ok.problems, []);
  assert.match(run({ rules: [rule({ exempt: { [key]: 'short' } })] }).problems[0], /needs a reason/);
  assert.match(run({ rules: [rule({ exempt: { 'GFacet.gone()': 'a reason that is long enough to pass' } })] }).problems[0], /not an entry point/);
  assert.match(run({ rules: [rule({ exempt: { [entry('good').key]: 'a reason that is long enough to pass' } })] }).problems[0], /carries the check: drop/);
  assert.match(run({ rules: [rule({ exempt: { [entry('internalOnly').key]: 'a reason that is long enough to pass' } })] }).problems[0], /does not apply/);
});

test('modifier checks and the applies-to vocabulary', () => {
  const guard = rule({ id: 'reentry-guard', statement: 'Every open GFacet entry holds the re-entry guard.', check: { anyOf: [{ modifier: 'nonReentrant' }] } });
  assert.deepEqual(flagged({ rules: [guard] }), ['modifierCallsOut', 'noGuard']);
  const gated = rule({ id: 'diamond-only', statement: 'Every caller-gated GFacet entry is the Diamond-only kind.', appliesTo: { contracts: ['GFacet'], caller: 'gated' }, check: { anyOf: [{ modifier: 'onlySelf' }] } });
  assert.deepEqual(flagged({ rules: [gated] }), []);
  const reached = () => new Set(['LibGate.s']);
  assert.ok(applies({ appliesTo: { reaches: ['LibGate.s'] } }, entry('good'), { shipped, reached }));
  assert.ok(!applies({ appliesTo: { match: 'viaHost' } }, entry('good'), { shipped, reached }));
  assert.ok(!applies({ appliesTo: { contracts: ['*'], excludeContracts: ['GFacet'] } }, entry('good'), { shipped, reached }));
  assert.ok(!entries.some((e) => e.name === 'peek'), 'a view is not an entry point');
});

test('the rules file itself is checked', () => {
  assert.deepEqual(rulesProblems({ rules: [rule()] }), []);
  assert.match(rulesProblems({})[0], /rules. array/);
  assert.ok(rulesProblems({ rules: [rule({ id: 'Bad Id' })] }).some((p) => /kebab-case/.test(p)));
  assert.ok(rulesProblems({ rules: [rule(), rule()] }).some((p) => /used twice/.test(p)));
  assert.ok(rulesProblems({ rules: [rule({ check: { anyOf: [] } })] }).some((p) => /at least one check/.test(p)));
  assert.ok(rulesProblems({ rules: [rule({ check: { anyOf: [{ modifier: 'a', call: 'b' }] } })] }).some((p) => /each check/.test(p)));
  assert.ok(rulesProblems({ rules: [rule({ appliesTo: { caller: 'whoever' } })] }).some((p) => /caller must be/.test(p)));
  assert.ok(rulesProblems({ rules: [rule({ extra: 1 })] }).some((p) => /unknown field extra/.test(p)));
});

test('the checklist names each rule in plain words with the entries it applies to (§10.19)', () => {
  const text = checklist({ rules: [rule()] }, entries.filter((e) => ['good', 'writesFirst'].includes(e.name)), { shipped, ctx });
  assert.match(text, /\*\*screen-flagged\*\*: Every GFacet entry refuses a flagged wallet/);
  assert.match(text, /`GFacet\.good\(\)`: carries the check/);
  assert.match(text, /`GFacet\.writesFirst\(\)`: carries NONE of the checks/);
});
