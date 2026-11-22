// Tests for contracts/script/review-coverage.mjs (#3936,
// ReviewCoveragePassDesign §10). The tool reads solc's parse tree, so these
// cases read a real one: fixtures/review-coverage/ast.json, generated from
// the .sol files beside it by regen.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
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
/** The entry check's own rules, as they will run once the dependency-aware hash (#4007) lands. */
const lp = (ledger, at) => ledgerProblems(ledger, at, { hashRulePending: null });
const fn = (file, name) => decls(file).find((d) => d.label.endsWith(`.${name}`));

test('normalize drops comments and spacing but keeps string literals and token boundaries', () => {
  assert.equal(normalize('uint256  a = b + 1; // note\n/* x */ return a;'), 'uint256 a=b+1;return a;');
  assert.equal(normalize('x = "a // b";'), 'x="a // b";');
  assert.equal(normalize("y = 'c /* d */';"), "y='c /* d */';");
  assert.notEqual(normalize('x = a - --b;'), normalize('x = a-- - b;'));
  assert.notEqual(normalize('x = a + +b;'), normalize('x = a++b;'));
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

test('the report: code with all four marks over all code, each mark beside it, exclusions with reasons (design §2.1, §10.6, §10.11, §10.21, §10.26)', () => {
  const all = [...decls('src/Original.sol'), ...decls('src/Iface.sol')];
  const add = all.find((d) => d.label === 'Original.add(uint256)');
  const total = all.find((d) => d.label === 'Original.total');
  const head = all.find((d) => d.label === 'Original (header)');
  const four = { reader: 'R1', reviewer: 'V1', specification: 'S1', crossReview: 'X1', crossReviewThread: 't-x', commit: 'abcdef1' };
  const ledger = {
    entries: {
      [add.hash]: four,
      [total.hash]: { reader: 'R1', reviewer: 'V1', specification: 'S1', commit: 'abcdef1' }, // no cross review: not covered
      [head.hash]: { reader: 'R1', reviewer: 'V1', commit: 'abcdef1' }, // no specification mark: not covered
    },
  };
  const r = buildReport(all, ledger, { declarations: {} });
  const counted = all.filter((d) => d.contractKind !== 'interface');
  assert.equal(r.total, counted.reduce((a, d) => a + d.size, 0));
  assert.equal(r.covered, add.size);
  assert.equal(r.coveredReviewer, add.size + total.size + head.size);
  assert.equal(r.coveredSpecification, add.size + total.size);
  assert.equal(r.coveredCrossReview, add.size);
  const unc = Object.fromEntries(r.uncovered.map((u) => [u.declaration, u.marks]));
  assert.deepEqual(unc['src/Original.sol:Original.total'], { reader: true, reviewer: true, specification: true, crossReview: false }, 'every mark but the cross review is not coverage');
  assert.equal(unc['src/Original.sol:Original (header)'].specification, false, 'reader and reviewer without the specification mark is not coverage');
  assert.ok(!unc['src/Original.sol:Original.add(uint256)']);
  assert.ok(!r.uncovered.some((u) => u.declaration.includes('IAdder')), 'an interface is excluded, not uncovered');
  const iface = r.exclusions.find((x) => x.prefix === '(any interface)');
  assert.ok(iface.declarations >= 2 && iface.reason.length > 20);
  assert.match(r.limit, /not every combination/);
});

test('until the dependency-aware hash lands (#4007), any ledger entry is refused; an empty ledger passes', () => {
  const [d] = decls('src/Original.sol');
  assert.match(ledgerProblems({ entries: { [d.hash]: { reader: 'R1', commit: 'abcdef1' } } }, () => new Set([d.hash]))[0], /#4007/);
  assert.deepEqual(ledgerProblems({ entries: {} }, () => new Set()), []);
});

test('a cross-review mark made by the first reader thread, or naming no thread, is refused (§10.27)', () => {
  const [d] = decls('src/Original.sol');
  const at = new Set([d.hash]);
  const e = { reader: 'R1', readerThread: 't-a', crossReview: 'X1', commit: 'abcdef1' };
  assert.match(lp({ entries: { [d.hash]: { ...e, crossReviewThread: 't-a' } } }, () => at).join(), /cross review was made by the thread that made the first reader pass/);
  assert.match(lp({ entries: { [d.hash]: e } }, () => at).join(), /names no thread/);
  assert.deepEqual(lp({ entries: { [d.hash]: { ...e, crossReviewThread: 't-b' } } }, () => at), []);
});

test('the launch-check shape: covered, total, uncovered[{declaration, ownerAcceptance}]', () => {
  const all = decls('src/Original.sol');
  const key = 'src/Original.sol:Original.total';
  const r = buildReport(all, { entries: {} }, { declarations: { [key]: { reason: 'storage kept as is', owner: 'https://example/decision' } } });
  assert.equal(typeof r.covered, 'number');
  assert.equal(typeof r.total, 'number');
  for (const u of r.uncovered) assert.deepEqual(Object.keys(u).filter((k) => ['declaration', 'ownerAcceptance'].includes(k)).sort(), ['declaration', 'ownerAcceptance']);
  assert.deepEqual(r.uncovered.find((u) => u.declaration === key).ownerAcceptance, { reason: 'storage kept as is', owner: 'https://example/decision' });
  assert.equal(r.uncovered.find((u) => u.declaration === 'src/Original.sol:Original.add(uint256)').ownerAcceptance, null);
});

test('entry check: a hash that matches no declaration at its commit is refused (design §10.4)', () => {
  const at = new Set(decls('src/Original.sol').map((d) => d.hash));
  const good = fn('src/Original.sol', 'add(uint256)').hash;
  const stale = fn('src/Edited.sol', 'add(uint256)').hash;
  const p = lp(
    { entries: { [good]: { reader: 'R1', reviewer: 'V1', commit: 'abcdef1' }, [stale]: { reader: 'R1', reviewer: 'V1', commit: 'abcdef1' } } },
    () => at,
  );
  assert.equal(p.length, 1);
  assert.match(p[0], /matches no declaration at abcdef1/);
  const unknown = lp({ entries: { [good]: { reader: 'R1', commit: 'deadbee' } } }, () => {
    throw new Error('unknown revision');
  });
  assert.match(unknown[0], /cannot be read/);
});

test('entry check: a reader mark by the thread that wrote the fix is refused (design §10.11)', () => {
  const good = fn('src/Original.sol', 'add(uint256)').hash;
  const at = new Set([good]);
  const p = lp({ entries: { [good]: { reader: 'R1', readerThread: 't-a', fixThread: 't-a', commit: 'abcdef1' } } }, () => at);
  assert.match(p[0], /thread that wrote the fix/);
});

test('entry check: a reviewer mark recorded while the latest planted-fault run has a miss is refused (design §10.13)', () => {
  const good = fn('src/Original.sol', 'add(uint256)').hash;
  const at = new Set([good]);
  const ledger = {
    plantedRuns: [{ id: 'P1', at: '2026-11-22T00:00:00Z', missed: 1 }],
    entries: { [good]: { reviewer: 'V2', commit: 'abcdef1', recordedAt: '2026-11-23T00:00:00Z' } },
  };
  assert.match(lp(ledger, () => at)[0], /planted-fault run \(P1\) has a miss/);
});

test('entry check: the ledger holds marks only, never a finding', () => {
  const good = fn('src/Original.sol', 'add(uint256)').hash;
  const p = lp({ entries: { [good]: { reader: 'R1', commit: 'abcdef1', finding: 'x' } } }, () => new Set([good]));
  assert.match(p[0], /unknown field finding/);
});

// ─── The unit tool, the ladder and the review repository (design §10.2–3, §10.9, §10.12–14, §10.16) ──

import {
  applyPlantedRun,
  baseFiles,
  locateInHead,
  makeReviewBranches,
  readSliceRecord,
  unitFromRecord,
  copiedFrom,
  requireReviewableSlice,
  sourcesDifferFromTree,
  leaseArgs,
  fileLevelOwner,
  fileLevelDeclarations,
  reviewDescription,
  descriptionProblems,
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

test('unit: a helper called in a modifier argument is a call the description lists', () => {
  const g = graph();
  const u = deriveUnit('EntryFacet', { ...g, ledger: { entries: {} }, shared: ['LibArg'] });
  const text = describeSlice(u, 0, g);
  assert.match(text, /EntryFacet\.guarded\(\)\n  - calls outside the unit: [^\n]*LibArg\.prepare\(\)/);
});

test('base files: the head with the unit\'s declarations cut out, nothing else', () => {
  const head = Buffer.from('aaaXXXbbbYYYccc');
  const out = baseFiles({ 'f.sol': head }, [
    { path: 'f.sol', start: 3, end: 6 },
    { path: 'f.sol', start: 9, end: 12 },
  ]);
  assert.equal(out['f.sol'].toString(), 'aaabbbccc');
});

test('a merged fix moves offsets: each slice declaration is found again in the head and cut there', () => {
  const file = 'src/Original.sol';
  const pinned = readFileSync(join(FIXTURE, file));
  const slice = decls(file).filter((d) => d.label === 'Original.add(uint256)');
  // The fix adds lines above the declaration: every offset moves by `k`.
  const pad = '// a fix above\n// and another line\n';
  const k = Buffer.byteLength(pad);
  const shifted = JSON.parse(JSON.stringify(UNITS[file]).replace(/"src":"(\d+):/g, (_, a) => `"src":"${Number(a) + k}:`));
  const head = Buffer.concat([Buffer.from(pad), pinned]);
  const [found] = locateInHead(slice, { [file]: head }, () => new Map([[file, shifted]]));
  assert.equal(found.start, slice[0].start + k);
  assert.equal(head.subarray(found.start, found.end).toString(), pinned.subarray(slice[0].start, slice[0].end).toString());
  const cut = baseFiles({ [file]: head }, [found])[file].toString();
  assert.ok(cut.startsWith(pad) && !cut.includes('function add('), 'the declaration is cut, the fix kept');
  assert.throws(() => locateInHead([{ ...slice[0], label: 'Original.gone()' }], { [file]: head }, () => new Map([[file, shifted]])), /no longer matches the head/);
});

test('a review-only description is the generated one: slice then checklist; any other text is refused (§10.19)', () => {
  const body = reviewDescription('Review unit U, slice 1 of 1', '### Cross-cutting rules (from the rules file)\n\n- **R1**: a rule');
  assert.match(body, /slice 1 of 1\n\n### Cross-cutting rules/);
  assert.deepEqual(descriptionProblems(`${body}  \n\n`, body), [], 'trailing spaces aside');
  assert.match(descriptionProblems(body.replace('a rule', 'no rule'), body)[0], /differs from the generated one at line 5/);
  assert.match(descriptionProblems('Review unit U, slice 1 of 1', body)[0], /line 2/, 'a description without the checklist is refused');
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
  const r = applyPlantedRun(ledger, { id: 'P2', at: '2026-11-22T00:00:00Z', size: 1500, planted: 4, missed: 1, missingRule: 1 });
  assert.deepEqual(r.ledger.sizeLimit, { lines: 1000, setBy: 'P2' });
  assert.deepEqual(r.reReview, ['V2', 'V3']);
  assert.equal(r.ledger.entries.a.reviewer, 'V1', 'converged before the last full catch: kept');
  assert.equal(r.ledger.entries.b.reviewer, undefined);
  assert.equal(r.ledger.entries.c, undefined, 'an entry left with no mark is removed');
  assert.equal(ledger.entries.b.reviewer, 'V2', 'pure: the input is unchanged');
});

test('ladder: a step up needs two qualifying runs AT the next rung, provisional in between (§2.3, §10.20)', () => {
  const base = { sizeLimit: { lines: 1000, setBy: 'P0' }, plantedRuns: [], entries: {} };
  const half = { lenses: ['funds', 'access', 'reentry'], depths: ['single', 'pair'] };
  const rest = { lenses: ['upgrade', 'offchain'], depths: ['library'] };
  const r = (l, run) => applyPlantedRun(l, { at: 't', planted: 3, missed: 0, missingRule: 1, ...half, ...run });
  assert.equal(r(base, { id: 'P1', size: 1000 }).ledger.sizeLimit.lines, 1000, 'a full catch at the current size does not step up');
  assert.equal(r(base, { id: 'P1', size: 2000 }).ledger.sizeLimit.lines, 1000, 'two rungs up is not the next rung');
  assert.equal(r(base, { id: 'P1', size: 1500, missingRule: 0 }).ledger.sizeLimit.lines, 1000, 'no missing-rule fault: does not count');
  const one = r(base, { id: 'P1', size: 1500 }).ledger;
  assert.deepEqual(one.sizeLimit, { lines: 1500, setBy: 'P1', provisional: true });
  assert.equal(r(one, { id: 'P2', size: 1500, ...half }).ledger.sizeLimit.provisional, true, 'the two runs do not cover every lens and depth');
  assert.equal(r(one, { id: 'P2', size: 1500, ...rest, missingRule: 0 }).ledger.sizeLimit.provisional, true, 'the second run needs a missing-rule fault too');
  assert.deepEqual(r(one, { id: 'P2', size: 1500, ...rest }).ledger.sizeLimit, { lines: 1500, setBy: 'P2', confirmedBy: ['P1', 'P2'] });
  assert.equal(r(one, { id: 'P2', size: 2000, ...rest }).ledger.sizeLimit.lines, 1500, 'no step from a provisional rung');
  const miss = applyPlantedRun(one, { id: 'P2', at: 't2', size: 1500, planted: 3, missed: 1, missingRule: 1 }).ledger;
  assert.deepEqual(miss.sizeLimit, { lines: 1000, setBy: 'P2' }, 'a miss at a provisional rung steps down');
  assert.throws(() => applyPlantedRun(base, { id: 'P1', at: 't1', size: 1500, planted: 2, missed: 3, missingRule: 0 }));
  assert.throws(() => applyPlantedRun(base, { id: 'P1', at: 't1', size: 1500, planted: 2, missed: 0 }), /missing-rule/);
  assert.throws(() => applyPlantedRun(one, { id: 'P1', at: 't1', size: 1500, planted: 3, missed: 0, missingRule: 1 }), /already recorded/, 'a retried record does not count twice');
  assert.throws(() => r(base, { id: 'P1', size: 1500, lenses: ['speed'] }), /unknown lens/);
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

function historyFreeCopy() {
  const dir = mkdtempSync(join(tmpdir(), 'rc-branches-'));
  const g = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@invalid', ...a], { cwd: dir, encoding: 'utf8' }).trim();
  g('init', '-q', '-b', 'main');
  const file = 'src/Original.sol';
  mkdirSync(join(dir, 'contracts', 'src'), { recursive: true });
  mkdirSync(join(dir, '.github', 'workflows'), { recursive: true });
  writeFileSync(join(dir, 'contracts', file), readFileSync(join(FIXTURE, file)));
  // A trailing blank line: the fix's patch then ends in a blank context line,
  // which a trimmed patch would corrupt.
  writeFileSync(join(dir, 'contracts', 'src', 'Other.sol'), '// other\n\n');
  writeFileSync(join(dir, '.github', 'workflows', 'ci.yml'), 'on: push\n');
  g('add', '-A');
  g('commit', '-q', '-m', 'production');
  const production = g('rev-parse', 'HEAD');
  // The fix, on production: touches another file and the workflows (which the copy never carries).
  g('checkout', '-q', '-b', 'fix');
  writeFileSync(join(dir, 'contracts', 'src', 'Other.sol'), '// other, fixed\n\n');
  writeFileSync(join(dir, '.github', 'workflows', 'ci.yml'), 'on: pull_request\n');
  g('commit', '-q', '-am', 'fix');
  // The copy: a root commit of the production tree without the workflows.
  g('checkout', '-q', 'main');
  g('rm', '-q', '-r', '--cached', '.github/workflows');
  const tree = g('write-tree');
  g('reset', '-q');
  const copy = g('commit-tree', tree, '-m', `Review copy of ${production}, without workflows`);
  assert.equal(copiedFrom(`Review copy of ${production}, without workflows`), production);
  const slice = decls(file).filter((d) => d.label === 'Original.add(uint256)');
  return { dir, g, file, copy, slice };
}

test('review branches on a history-free copy: the fix is transplanted, the base is the head\'s parent line, the head restores the reviewed tree (§3, §5)', () => {
  const { dir, g, file, copy, slice } = historyFreeCopy();
  const unit = { name: 'Original', slices: [{ declarations: slice }] };
  const r = makeReviewBranches({ clone: dir, unit, slice: 0, pinned: copy, fix: 'fix', parse: () => new Map([[file, UNITS[file]]]) });
  assert.deepEqual(r.problems, []);
  g('merge-base', '--is-ancestor', r.base, r.head);
  assert.deepEqual(g('diff', '--name-only', `${r.base}...${r.head}`).split('\n'), [`contracts/${file}`], 'the pull request shows the unit file only');
  assert.match(g('diff', `${r.base}...${r.head}`), /\+\s*function add\(/);
  assert.equal(g('show', `${r.head}:contracts/src/Other.sol`), '// other, fixed', 'the fix is in the reviewed tree');
  assert.throws(() => g('show', `${r.head}:.github/workflows/ci.yml`), 'the stripped paths stay stripped');
  // The head records the slice it was cut for; `open` describes that record.
  const record = readSliceRecord(g('log', '-1', '--format=%B', r.head));
  assert.deepEqual(record.members, [[file, 'Original.add(uint256)']]);
  assert.equal(record.slice, 1);
});

test('open describes the slice the head recorded, not one derived again from a fixed tree (§3.2)', () => {
  const list = decls('src/Original.sol').map((d) => ({ ...d, lineStart: 1, lineEnd: 3 }));
  const byPath = new Map([['src/Original.sol', list]]);
  const record = { unit: 'Original', slice: 1, of: 2, limit: 6, members: [['src/Original.sol', 'Original.add(uint256)']] };
  const u = unitFromRecord(record, { unit: 'Original', slice: 1 }, { byPath });
  assert.equal(u.slices.length, 2);
  assert.deepEqual(u.slices[0].declarations.map((d) => d.label), ['Original.add(uint256)'], 'exactly the recorded members, whatever a fresh partition would give');
  assert.throws(() => unitFromRecord(record, { unit: 'Original', slice: 2 }, { byPath }), /cut for Original slice 1/);
  assert.throws(() => unitFromRecord({ ...record, members: [['src/Original.sol', 'Original.gone()']] }, { unit: 'Original', slice: 1 }, { byPath }), /does not match its sources: .*not found/);
  assert.equal(readSliceRecord('Review head\n\nno record'), undefined);
});

test('the size limit holds on the reviewed tree: a slice the fix makes too long is refused (§3.2)', () => {
  const { dir, file, copy, slice } = historyFreeCopy();
  const unit = { name: 'Original', limit: 1, slices: [{ declarations: slice }] };
  assert.throws(() => makeReviewBranches({ clone: dir, unit, slice: 0, pinned: copy, fix: 'fix', parse: () => new Map([[file, UNITS[file]]]) }), /lines in the reviewed tree, over the 1-line limit/);
});

test('open: the workspace\'s sources are compared with the head, changed, missing and extra files named', () => {
  const { dir, g } = historyFreeCopy();
  const ws = mkdtempSync(join(tmpdir(), 'rc-ws-'));
  mkdirSync(join(ws, 'src'), { recursive: true });
  for (const p of ['src/Original.sol', 'src/Other.sol']) writeFileSync(join(ws, p), execFileSync('git', ['show', `main:contracts/${p}`], { cwd: dir }));
  assert.deepEqual(sourcesDifferFromTree(dir, 'main', ws), []);
  writeFileSync(join(ws, 'src', 'Other.sol'), '// changed\n');
  writeFileSync(join(ws, 'src', 'New.sol'), '// new\n');
  assert.deepEqual(sourcesDifferFromTree(dir, 'main', ws), ['src/New.sol', 'src/Other.sol']);
  assert.deepEqual(sourcesDifferFromTree(dir, 'fix', ws).includes('src/Original.sol'), false);
  void g;
});

test('a re-cut slice replaces its pushed branches, but only over the tips seen now (§3.3 step 4)', () => {
  const { dir, file, copy, slice } = historyFreeCopy();
  const remote = mkdtempSync(join(tmpdir(), 'rc-remote-'));
  execFileSync('git', ['init', '-q', '--bare'], { cwd: remote });
  execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: dir });
  const unit = { name: 'Original', slices: [{ declarations: slice }] };
  const push = (r) => execFileSync('git', ['push', '-q', ...leaseArgs(dir, [r.head, r.base]), 'origin', r.head, r.base], { cwd: dir, stdio: 'pipe' });
  push(makeReviewBranches({ clone: dir, unit, slice: 0, pinned: copy, parse: () => new Map([[file, UNITS[file]]]) }));
  const again = makeReviewBranches({ clone: dir, unit, slice: 0, pinned: copy, fix: 'fix', parse: () => new Map([[file, UNITS[file]]]) });
  assert.doesNotThrow(() => push(again), 'the re-cut branches replace the old ones');
  assert.deepEqual(leaseArgs(dir, ['x'], () => ''), ['--force-with-lease=refs/heads/x:'], 'a branch not yet pushed must not exist');
});

test('file-level declarations go with the first non-interface contract in their file, or make the file a unit of its own', () => {
  const list = [
    { path: 'src/A.sol', kind: 'StructDefinition', contract: null, label: 'S', start: 0 },
    { path: 'src/A.sol', kind: 'ContractDefinition', contract: null, contractKind: 'interface', label: 'IA (header)', start: 10 },
    { path: 'src/A.sol', kind: 'ContractDefinition', contract: null, contractKind: 'library', label: 'LibA (header)', start: 20 },
    { path: 'src/T.sol', kind: 'StructDefinition', contract: null, label: 'T', start: 0 },
  ];
  const decls = { byPath: new Map([['src/A.sol', list.slice(0, 3)], ['src/T.sol', list.slice(3)]]) };
  assert.equal(fileLevelOwner(decls, 'src/A.sol'), 'LibA');
  assert.equal(fileLevelOwner(decls, 'src/T.sol'), undefined);
  assert.deepEqual(fileLevelDeclarations(decls, 'src/A.sol').map((d) => d.label), ['S']);
  const g = graph();
  assert.throws(() => deriveUnit('src/Nope.sol', { ...g, ledger: { entries: {} } }), /no source file/);
});

test('a slice of one declaration over the limit is refused, never reviewed whole (§3.2)', () => {
  const big = { name: 'L', limit: 1000, slices: [{ lines: 5476, oversize: true, declarations: [{ path: 'src/L.sol', label: 'L.Storage', kind: 'StructDefinition' }] }, { lines: 10, oversize: false, declarations: [] }] };
  assert.throws(() => requireReviewableSlice(big, 0), /split it at its fields \(#4008\)/);
  assert.doesNotThrow(() => requireReviewableSlice(big, 1));
  big.slices[0].declarations[0].kind = 'FunctionDefinition';
  assert.throws(() => requireReviewableSlice(big, 0), /split it in the source/);
});
