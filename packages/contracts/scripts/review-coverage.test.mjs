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
