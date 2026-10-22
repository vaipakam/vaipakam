// Tests for contracts/script/check-measured-delivery.mjs (#2440).
//
// The check reads solc's AST, so these cases read a real one:
// fixtures/measured-delivery/ast.json, generated from the .sol files beside it
// by regen.mjs. Each function in fixtures/measured-delivery/src/Raw.sol is one
// way a raw ERC-20 move can be written, or one the check must not count.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ALLOWLIST_FILE,
  moveDeclarations,
  oneJobProblems,
  rawMoveSites,
  readAllowlist,
  verdict,
} from '../../../contracts/script/check-measured-delivery.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, 'fixtures', 'measured-delivery');
const UNITS = Object.values(JSON.parse(readFileSync(join(FIXTURE, 'ast.json'), 'utf8')).units);
const bytes = (p) => readFileSync(join(FIXTURE, p));

function sites() {
  return rawMoveSites(UNITS, moveDeclarations(UNITS), { sourceText: bytes });
}

/** The 1-based line of the first line of `src/Raw.sol` containing `needle`, after `after`. */
function lineOf(needle, after = '') {
  const lines = readFileSync(join(FIXTURE, 'src/Raw.sol'), 'utf8').split('\n');
  const from = after ? lines.findIndex((l) => l.includes(after)) : 0;
  return lines.findIndex((l, i) => i >= from && l.includes(needle)) + 1;
}

test('the move declarations are SafeERC20 transfers and the ERC-20 interface, not ERC-721', () => {
  const labels = [...moveDeclarations(UNITS).values()].sort();
  assert.deepEqual(labels, ['IERC20.transfer', 'IERC20.transferFrom', 'SafeERC20.safeTransfer', 'SafeERC20.safeTransferFrom']);
});

test('every way of writing a raw move is found, keyed by file, contract and function', () => {
  const found = Object.fromEntries([...sites()].map(([k, s]) => [k, s.moves]));
  assert.deepEqual(found, {
    'src/Raw.sol:Raw.viaUsing': 1, // `t.safeTransfer(...)` through `using SafeERC20`
    'src/Raw.sol:Raw.viaLibrary': 1, // `SafeERC20.safeTransferFrom(...)`
    'src/Raw.sol:Raw.direct': 1, // `IERC20(t).transfer(...)`
    'src/Raw.sol:Raw.bySelector': 1, // `IERC20.transfer.selector` handed to a low-level call
    'src/Raw.sol:Raw.twice': 2, // a second move in one function is counted
    'src/Raw.sol:Raw.modifier sweeps': 1, // a move in a modifier
  });
});

test('LibDelivery, ERC-721 moves, approvals and lib/ sources are not counted', () => {
  const keys = [...sites().keys()];
  assert.ok(!keys.some((k) => k.startsWith('src/libraries/LibDelivery.sol')), 'the home library is the rule');
  assert.ok(!keys.includes('src/Raw.sol:Raw.nft'), 'IERC721.transferFrom shares the selector but is not ERC-20');
  assert.ok(!keys.includes('src/Raw.sol:Raw.measured'), 'a call through LibDelivery is measured');
  assert.ok(!keys.includes('src/Raw.sol:Raw.approveOnly'), 'an approval moves nothing');
  assert.ok(!keys.some((k) => k.startsWith('lib/')), 'only src/ is scanned');
});

test('line numbers count bytes, so a non-ASCII character earlier in the file does not shift them', () => {
  const twice = sites().get('src/Raw.sol:Raw.twice');
  const first = lineOf('t.safeTransfer(to, 1);', 'function twice');
  assert.deepEqual(twice.refs.map((r) => r.line), [first, first + 1]);
});

test('a set compiled in one job passes the one-job proof', () => {
  const paths = Object.fromEntries(UNITS.map((u) => [u.src.split(':')[2], u.absolutePath]));
  assert.deepEqual(oneJobProblems(UNITS, [{ id: 'job', source_id_to_path: paths }]), []);
});

test('artifacts from more than one job, or a unit the job does not record, are refused', () => {
  const paths = Object.fromEntries(UNITS.map((u) => [u.src.split(':')[2], u.absolutePath]));
  const twoJobs = oneJobProblems(UNITS, [{ source_id_to_path: paths }, { source_id_to_path: paths }]);
  assert.equal(twoJobs.length, 1);
  assert.match(twoJobs[0], /2 compilation jobs/);
  assert.match(oneJobProblems(UNITS, [])[0], /0 compilation jobs/);

  const raw = UNITS.find((u) => u.absolutePath === 'src/Raw.sol');
  const shifted = { ...paths, [raw.src.split(':')[2]]: 'src/Other.sol' };
  const problems = oneJobProblems(UNITS, [{ source_id_to_path: shifted }]);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /^src\/Raw\.sol was not compiled in the one job/);
});

test('the verdict names unlisted sites, changed counts and stale entries', () => {
  const found = sites();
  const reason = 'a reason long enough to say something';
  const allow = [...found].map(([site, s]) => ({ site, moves: s.moves, reason }));
  assert.deepEqual(verdict(found, allow), []);

  const missing = allow.filter((e) => e.site !== 'src/Raw.sol:Raw.direct');
  const [unlisted] = verdict(found, missing);
  assert.match(unlisted, /^src\/Raw\.sol:Raw\.direct: 1 raw ERC-20 move\(s\) outside LibDelivery \(IERC20\.transfer @\d+\)/);

  const recount = allow.map((e) => (e.site === 'src/Raw.sol:Raw.twice' ? { ...e, moves: 1 } : e));
  assert.match(verdict(found, recount)[0], /^src\/Raw\.sol:Raw\.twice: listed with 1 move\(s\), found 2/);

  const stale = [...allow, { site: 'src/Gone.sol:Gone.f', moves: 1, reason }];
  assert.deepEqual(verdict(found, stale), ['src/Gone.sol:Gone.f: listed, but has no raw move any more — remove the entry']);
});

test('the allowlist is shape-checked', () => {
  const ok = { site: 'src/A.sol:A.f', moves: 1, reason: 'a reason long enough to say something' };
  const read = (sites) => readAllowlist(JSON.stringify({ sites }));
  assert.deepEqual(read([ok]), [ok]);
  assert.throws(() => readAllowlist('{}'), /"sites" array/);
  assert.throws(() => read([{ ...ok, site: 'A.f' }]), /not of the form/);
  assert.throws(() => read([{ ...ok, moves: 0 }]), /positive integer/);
  assert.throws(() => read([{ ...ok, reason: 'short' }]), /needs a "reason"/);
  assert.throws(() => read([ok, ok]), /listed twice/);
});

test('the committed allowlist is well-formed and names only src/ sites', () => {
  const entries = readAllowlist(readFileSync(ALLOWLIST_FILE, 'utf8'));
  assert.ok(entries.length > 0);
  for (const e of entries) assert.ok(e.site.startsWith('src/'), e.site);
  assert.ok(
    !entries.some((e) => e.site.startsWith('src/libraries/LibDelivery.sol')),
    'LibDelivery is the rule, never an entry',
  );
});
