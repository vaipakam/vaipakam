// Tests for contracts/script/review-coverage.mjs (#3936,
// ReviewCoveragePassDesign §10). The tool reads solc's parse tree, so these
// cases read a real one: fixtures/review-coverage/ast.json, generated from
// the .sol files beside it by regen.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildReport,
  declarationsOf,
  ledgerProblems,
  normalize,
} from '../../../contracts/script/review-coverage.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, 'fixtures', 'review-coverage');
const UNITS = JSON.parse(readFileSync(join(FIXTURE, 'ast.json'), 'utf8')).units;
const decls = (file) => declarationsOf(file, UNITS[file], readFileSync(join(FIXTURE, file)));
const fn = (file, name) => decls(file).find((d) => d.label.endsWith(`.${name}`));

test('normalize drops comments and spacing but keeps string literals and token boundaries', () => {
  assert.equal(normalize('uint256  a = b + 1; // note\n/* x */ return a;'), 'uint256 a=b+1;return a;');
  assert.equal(normalize('x = "a // b";'), 'x="a // b";');
  assert.equal(normalize("y = 'c /* d */';"), "y='c /* d */';");
});

test('a function moved to another contract and file keeps its hash (design §10.1)', () => {
  assert.equal(fn('src/Moved.sol', 'add(uint256)').hash, fn('src/Original.sol', 'add(uint256)').hash);
  assert.equal(fn('src/Moved.sol', 'event Added(uint256)').hash, fn('src/Original.sol', 'event Added(uint256)').hash);
});

test('one changed operator changes the hash (design §10.1)', () => {
  assert.notEqual(fn('src/Edited.sol', 'add(uint256)').hash, fn('src/Original.sol', 'add(uint256)').hash);
});

test('a comment-only change keeps the hash (design §10.1)', () => {
  assert.equal(fn('src/Commented.sol', 'add(uint256)').hash, fn('src/Original.sol', 'add(uint256)').hash);
  assert.equal(fn('src/Commented.sol', 'total').hash, fn('src/Original.sol', 'total').hash);
});

test('every kind of declaration is listed, and a contract header is its own entry', () => {
  const labels = decls('src/Original.sol').map((d) => d.label);
  assert.deepEqual(labels, [
    'Original (header)',
    'Original.total',
    'Original.event Added(uint256)',
    'Original.error TooMuch(uint256)',
    'Original.add(uint256)',
  ]);
  assert.ok(decls('src/Iface.sol').some((d) => d.label === 'LibText.using LibText for uint256'));
});

test('the report: code covered by both layers over all code, each layer beside it, exclusions with reasons (design §10.6, §10.11)', () => {
  const all = [...decls('src/Original.sol'), ...decls('src/Iface.sol')];
  const add = all.find((d) => d.label === 'Original.add(uint256)');
  const total = all.find((d) => d.label === 'Original.total');
  const head = all.find((d) => d.label === 'Original (header)');
  const ledger = {
    entries: {
      [add.hash]: { reader: 'R1', reviewer: 'V1', commit: 'abcdef1' },
      [total.hash]: { reviewer: 'V1', commit: 'abcdef1' }, // reviewer only: not covered
      [head.hash]: { reader: 'R1', commit: 'abcdef1' }, // reader only: not covered
    },
  };
  const r = buildReport(all, ledger, { declarations: {} });
  const counted = all.filter((d) => d.contractKind !== 'interface');
  assert.equal(r.total, counted.reduce((a, d) => a + d.size, 0));
  assert.equal(r.coveredBoth, add.size);
  assert.equal(r.coveredReviewer, add.size + total.size);
  assert.equal(r.coveredReader, add.size + head.size);
  const unc = r.uncovered.map((u) => u.declaration);
  assert.ok(unc.includes('src/Original.sol:Original.total'), 'reviewer mark alone is not coverage');
  assert.ok(unc.includes('src/Original.sol:Original (header)'), 'reader mark alone is not coverage');
  assert.ok(!unc.includes('src/Original.sol:Original.add(uint256)'));
  assert.ok(!unc.some((u) => u.includes('IAdder')), 'an interface is excluded, not uncovered');
  const iface = r.exclusions.find((x) => x.prefix === '(any interface)');
  assert.ok(iface.declarations >= 2 && iface.reason.length > 20);
  assert.match(r.limit, /not every combination/);
});

test('the launch-check shape: coveredBoth, total, uncovered[{declaration, ownerAcceptance}]', () => {
  const all = decls('src/Original.sol');
  const key = 'src/Original.sol:Original.total';
  const r = buildReport(all, { entries: {} }, { declarations: { [key]: { reason: 'storage kept as is', owner: 'https://example/decision' } } });
  assert.equal(typeof r.coveredBoth, 'number');
  assert.equal(typeof r.total, 'number');
  for (const u of r.uncovered) assert.deepEqual(Object.keys(u).filter((k) => ['declaration', 'ownerAcceptance'].includes(k)).sort(), ['declaration', 'ownerAcceptance']);
  assert.deepEqual(r.uncovered.find((u) => u.declaration === key).ownerAcceptance, { reason: 'storage kept as is', owner: 'https://example/decision' });
  assert.equal(r.uncovered.find((u) => u.declaration === 'src/Original.sol:Original.add(uint256)').ownerAcceptance, null);
});

test('entry check: a hash that matches no declaration at its commit is refused (design §10.4)', () => {
  const at = new Set(decls('src/Original.sol').map((d) => d.hash));
  const good = fn('src/Original.sol', 'add(uint256)').hash;
  const stale = fn('src/Edited.sol', 'add(uint256)').hash;
  const p = ledgerProblems(
    { entries: { [good]: { reader: 'R1', reviewer: 'V1', commit: 'abcdef1' }, [stale]: { reader: 'R1', reviewer: 'V1', commit: 'abcdef1' } } },
    () => at,
  );
  assert.equal(p.length, 1);
  assert.match(p[0], /matches no declaration at abcdef1/);
  const unknown = ledgerProblems({ entries: { [good]: { reader: 'R1', commit: 'deadbee' } } }, () => {
    throw new Error('unknown revision');
  });
  assert.match(unknown[0], /cannot be read/);
});

test('entry check: a reader mark by the thread that wrote the fix is refused (design §10.11)', () => {
  const good = fn('src/Original.sol', 'add(uint256)').hash;
  const at = new Set([good]);
  const p = ledgerProblems({ entries: { [good]: { reader: 'R1', readerThread: 't-a', fixThread: 't-a', commit: 'abcdef1' } } }, () => at);
  assert.match(p[0], /thread that wrote the fix/);
});

test('entry check: a reviewer mark recorded while the latest planted-fault run has a miss is refused (design §10.13)', () => {
  const good = fn('src/Original.sol', 'add(uint256)').hash;
  const at = new Set([good]);
  const ledger = {
    plantedRuns: [{ id: 'P1', at: '2026-11-22T00:00:00Z', missed: 1 }],
    entries: { [good]: { reviewer: 'V2', commit: 'abcdef1', recordedAt: '2026-11-23T00:00:00Z' } },
  };
  assert.match(ledgerProblems(ledger, () => at)[0], /planted-fault run \(P1\) has a miss/);
});

test('entry check: the ledger holds marks only, never a finding', () => {
  const good = fn('src/Original.sol', 'add(uint256)').hash;
  const p = ledgerProblems({ entries: { [good]: { reader: 'R1', commit: 'abcdef1', finding: 'x' } } }, () => new Set([good]));
  assert.match(p[0], /unknown field finding/);
});

// ─── The unit tool, the ladder and the review repository (design §10.2–3, §10.9, §10.12–14, §10.16) ──

import {
  applyPlantedRun,
  baseFiles,
  buildDeclarations,
  copyProblems,
  strippedCopyProblems,
  deriveUnit,
  describeSlice,
  isReviewOnlyBase,
  plantedRunDue,
  reviewPrProblems,
  strayBranches,
} from '../../../contracts/script/review-coverage.mjs';
import { makeContext, reach, walk } from '../../../contracts/script/refactor-reports.mjs';

// The refactor-reports fixture is a FULL build AST (with references), which
// the unit tool's call graph needs.
const RR = join(HERE, 'fixtures', 'refactor-reports');
const RR_UNITS = Object.values(JSON.parse(readFileSync(join(RR, 'ast.json'), 'utf8')).units);
function graph() {
  const ctx = makeContext(RR_UNITS, ['AFacet', 'BFacet']);
  const pathOf = new Map();
  for (const u of RR_UNITS) for (const n of u.nodes ?? []) if (n.nodeType === 'ContractDefinition') pathOf.set(n.id, u.absolutePath);
  ctx.pathOf = (id) => pathOf.get(id);
  const decls = buildDeclarations(RR_UNITS, (p) => readFileSync(join(RR, p)));
  return { ctx, reachFn: reach, walk, decls };
}

test('unit: the facet with the library functions its code reaches, not what it reaches through the Diamond (design §10.2)', () => {
  const g = graph();
  const u = deriveUnit('AFacet', { ...g, ledger: { entries: {} } });
  const labels = u.slices.flatMap((s) => s.declarations.map((d) => d.label));
  assert.ok(labels.includes('AFacet (header)'));
  assert.ok(labels.includes('AFacet.emitsThroughLibrary()'));
  assert.ok(labels.includes('LibLoud.did()'), 'a library function the facet calls is in its unit');
  assert.ok(!labels.some((l) => l.startsWith('BFacet.')), 'a facet reached by a self-call is its own unit');
});

test('unit: covered declarations are dropped, and a shared library is left to its own slices', () => {
  const g = graph();
  const did = [...g.decls.byKey.values()].find((d) => d.label === 'LibLoud.did()');
  const covered = deriveUnit('AFacet', { ...g, ledger: { entries: { [did.hash]: { reader: 'R1', reviewer: 'V1', commit: 'abcdef1' } } } });
  assert.equal(covered.dropped, 1);
  assert.ok(!covered.slices.flatMap((s) => s.declarations).some((d) => d.label === 'LibLoud.did()'));
  const shared = deriveUnit('AFacet', { ...g, ledger: { entries: {} }, shared: ['LibLoud'] });
  assert.ok(!shared.slices.flatMap((s) => s.declarations).some((d) => d.label === 'LibLoud.did()'));
});

test('unit: over the limit it splits into slices of whole declarations, in order', () => {
  const g = graph();
  const whole = deriveUnit('AFacet', { ...g, ledger: { entries: {} } });
  const sliced = deriveUnit('AFacet', { ...g, ledger: { entries: {} }, limit: 20 });
  assert.equal(whole.slices.length, 1);
  assert.ok(sliced.slices.length > 1);
  assert.deepEqual(
    sliced.slices.flatMap((s) => s.declarations.map((d) => d.label)),
    whole.slices[0].declarations.map((d) => d.label),
    'slicing keeps every declaration whole, once, in the same order',
  );
  for (const s of sliced.slices) assert.ok(s.lines <= 20 || s.oversize);
});

test('unit: the description lists each declaration with its lines, what it calls outside and who calls it', () => {
  const g = graph();
  const u = deriveUnit('AFacet', { ...g, ledger: { entries: {} }, shared: ['LibLoud'] });
  const text = describeSlice(u, 0, g);
  assert.match(text, /`src\/Fixture\.sol:\d+-\d+` AFacet\.emitsThroughLibrary\(\)/);
  assert.match(text, /calls outside the unit: LibLoud\.did\(\)/);
  assert.match(text, /BFacet\.loud \(through the Diamond\)/);
  assert.match(text, /AFacet\._bubble\(bytes\)\n  - called by: [^\n]*src\/Fixture\.sol:AFacet\.viaKeccakConstant\(\)/);
  assert.match(text, /AFacet\.viaKeccakConstant\(\)\n  - calls outside the unit: BFacet\.loud \(through the Diamond\)/, "a selector constant is followed like a selector member");
});

test('base files: the head with the unit\'s declarations cut out, nothing else', () => {
  const head = Buffer.from('aaaXXXbbbYYYccc');
  const out = baseFiles({ 'f.sol': head }, [
    { path: 'f.sol', start: 3, end: 6 },
    { path: 'f.sol', start: 9, end: 12 },
  ]);
  assert.equal(out['f.sol'].toString(), 'aaabbbccc');
});

test('review-only pull requests: recognised by the base name; never against main; head and base checked (design §10.3, §10.9)', () => {
  assert.equal(isReviewOnlyBase('main'), false);
  assert.equal(isReviewOnlyBase('claude/planted-1-base'), false, 'a planted-fault base is not review-only');
  assert.equal(isReviewOnlyBase('claude/review-profilefacet-1-base'), true);
  const diff = (a, b) => ({ 'pin|head': ['contracts/src/Fix.sol'], 'head|base': ['contracts/src/Unit.sol'] })[`${a}|${b}`] ?? [];
  const ok = { base: 'claude/review-u-1-base', head: 'claude/review-u-1-head', pinned: 'pin', headTree: 'head', baseTree: 'base', unitPaths: ['contracts/src/Unit.sol'], fixPaths: ['contracts/src/Fix.sol'], diff };
  assert.deepEqual(reviewPrProblems(ok), []);
  assert.match(reviewPrProblems({ ...ok, base: 'main' })[0], /never opened against main/);
  assert.match(reviewPrProblems({ ...ok, fixPaths: [] }).join(), /outside the unit's fix branch/);
  assert.match(reviewPrProblems({ ...ok, unitPaths: [] }).join(), /outside the unit's files/);
});

test('ladder: a miss steps down and removes reviewer marks since the last full catch (design §10.13)', () => {
  const ledger = {
    sizeLimit: { lines: 1500, setBy: 'P1' },
    plantedRuns: [{ id: 'P1', at: '2026-11-20T00:00:00Z', size: 1500, planted: 3, missed: 0 }],
    entries: {
      a: { reader: 'R1', reviewer: 'V1', commit: 'abcdef1', recordedAt: '2026-11-19T00:00:00Z' },
      b: { reader: 'R2', reviewer: 'V2', commit: 'abcdef1', recordedAt: '2026-11-21T00:00:00Z' },
      c: { reviewer: 'V3', commit: 'abcdef1', recordedAt: '2026-11-21T00:00:00Z' },
    },
  };
  const r = applyPlantedRun(ledger, { id: 'P2', at: '2026-11-22T00:00:00Z', size: 1500, planted: 4, missed: 1 });
  assert.deepEqual(r.ledger.sizeLimit, { lines: 1000, setBy: 'P2' });
  assert.deepEqual(r.reReview, ['V2', 'V3']);
  assert.equal(r.ledger.entries.a.reviewer, 'V1', 'converged before the last full catch: kept');
  assert.equal(r.ledger.entries.b.reviewer, undefined);
  assert.equal(r.ledger.entries.c, undefined, 'an entry left with no mark is removed');
  assert.equal(ledger.entries.b.reviewer, 'V2', 'pure: the input is unchanged');
});

test('ladder: a step up needs a full catch AT the next rung', () => {
  const base = { sizeLimit: { lines: 1000, setBy: 'P0' }, plantedRuns: [], entries: {} };
  assert.equal(applyPlantedRun(base, { id: 'P1', at: 't1', size: 1000, planted: 3, missed: 0 }).ledger.sizeLimit.lines, 1000, 'a full catch at the current size does not step up');
  assert.equal(applyPlantedRun(base, { id: 'P1', at: 't1', size: 2000, planted: 3, missed: 0 }).ledger.sizeLimit.lines, 1000, 'two rungs up is not the next rung');
  assert.equal(applyPlantedRun(base, { id: 'P1', at: 't1', size: 1500, planted: 3, missed: 0 }).ledger.sizeLimit.lines, 1500);
  assert.throws(() => applyPlantedRun(base, { id: 'P1', at: 't1', size: 1500, planted: 2, missed: 3 }));
});

test('the planted-fault run repeats after ten converged units', () => {
  const entries = Object.fromEntries([...Array(10).keys()].map((i) => [`h${i}`, { reviewer: `V${i}`, commit: 'abcdef1', recordedAt: '2026-11-23T00:00:00Z' }]));
  const ledger = { plantedRuns: [{ id: 'P1', at: '2026-11-22T00:00:00Z', size: 1000, planted: 3, missed: 0 }], entries };
  assert.equal(plantedRunDue(ledger).due, true);
  delete entries.h9;
  assert.equal(plantedRunDue(ledger).due, false);
});

test('stray branches: review and planted branches with no open pull request are listed (design §10.14)', () => {
  const branches = ['main', 'claude/review-a-1-base', 'claude/review-a-1-head', 'claude/review-b-1-base', 'claude/planted-3-base', 'feature'];
  const open = [{ base: 'claude/review-a-1-base', head: 'claude/review-a-1-head' }];
  assert.deepEqual(strayBranches(branches, open), ['claude/planted-3-base', 'claude/review-b-1-base']);
});

test('the one-way copy refuses with workflows on, with no answer, or towards this repository (design §10.16)', () => {
  const commit = 'a'.repeat(40);
  assert.deepEqual(copyProblems({ actions: { enabled: false }, commit, repo: 'vaipakam/review' }), []);
  assert.match(copyProblems({ actions: { enabled: true }, commit, repo: 'vaipakam/review' })[0], /workflows are enabled/);
  assert.match(copyProblems({ actions: null, commit, repo: 'vaipakam/review' })[0], /no answer/);
  assert.match(copyProblems({ actions: { enabled: false }, commit, repo: 'vaipakam/vaipakam' })[0], /never this one/);
  assert.match(copyProblems({ actions: { enabled: false }, commit: 'abc', repo: 'vaipakam/review' })[0], /full pinned commit/);
});

test('copy: it differs from the pinned commit by exactly the workflow files and the dependency-update config, each left out (#3944)', () => {
  const pinnedPaths = ['contracts/src/A.sol', '.github/workflows/ci.yml', '.github/workflows/x.yml', '.github/dependabot.yml', '.github/LABELS.md'];
  const del = (path) => ({ status: 'D', path });
  const good = [del('.github/workflows/ci.yml'), del('.github/workflows/x.yml'), del('.github/dependabot.yml')];
  assert.deepEqual(strippedCopyProblems({ diff: good, pinnedPaths }), []);
  assert.match(strippedCopyProblems({ diff: good.slice(1), pinnedPaths })[0], /still carries \.github\/workflows\/ci\.yml/);
  assert.match(strippedCopyProblems({ diff: [...good, { status: 'M', path: 'contracts/src/A.sol' }], pinnedPaths })[0], /not a stripped path/);
  assert.match(strippedCopyProblems({ diff: [...good, del('.github/LABELS.md')], pinnedPaths })[0], /LABELS\.md, which is not a stripped path/);
  assert.match(strippedCopyProblems({ diff: [...good.slice(0, 2), { status: 'M', path: '.github/dependabot.yml' }], pinnedPaths })[0], /changes \.github\/dependabot\.yml instead of leaving it out/);
});
