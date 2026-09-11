// storage-layout-eras.test.mjs — the era table's per-era bytecode catalogue
// and the rule for when the main checkout's dependencies may stand in for an
// era's (#1566 §7a, Codex #2095 round 9).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keccak256 } from 'viem';
import { execFileSync } from 'node:child_process';
import { bytecodeCatalogueFrom, depsFromMainAreIdentical, parseLsTree, deployedAtIso, commitsAround, deploymentBuildCandidates, interpolateTimestamp, contentDigestOf, tableIdentityOf, verifyTableContents, layoutDigestOf } from './storage-layout-eras.mjs';

test('bytecodeCatalogueFrom hashes every src/ contract\'s runtime bytecode and nothing else (#2095 r9 P1)', () => {
  const out = mkdtempSync(join(tmpdir(), 'era-out-'));
  const art = (target, code) => JSON.stringify({ metadata: { settings: { compilationTarget: target } }, deployedBytecode: { object: code } });
  mkdirSync(join(out, 'A.sol')); writeFileSync(join(out, 'A.sol', 'A.json'), art({ 'src/facets/A.sol': 'A' }, '0x6001'));
  mkdirSync(join(out, 'T.sol')); writeFileSync(join(out, 'T.sol', 'T.json'), art({ 'test/T.t.sol': 'T' }, '0x6002'));
  mkdirSync(join(out, 'I.sol')); writeFileSync(join(out, 'I.sol', 'I.json'), art({ 'src/interfaces/I.sol': 'I' }, '0x'));
  mkdirSync(join(out, 'L.sol')); writeFileSync(join(out, 'L.sol', 'L.json'), art({ 'lib/x/L.sol': 'L' }, '0x6003'));
  writeFileSync(join(out, 'junk.json'), '{not json');
  const { catalogue, count } = bytecodeCatalogueFrom(out);
  assert.equal(count, 1, 'a test contract, a lib contract, an interface with no runtime code and unparseable junk are not catalogued');
  assert.deepEqual(catalogue, { [keccak256('0x6001')]: 'A' });
});

test('the main checkout\'s lib may stand in only for an identical era lib tree with every submodule at its gitlink (#2095 r9 P2)', () => {
  const T = '040000 tree ' + 'a'.repeat(40) + '\tcontracts/lib/forge-std\n160000 commit ' + 'b'.repeat(40) + '\tcontracts/lib/dep\n';
  assert.deepEqual(Object.keys(parseLsTree(T)), ['contracts/lib/forge-std', 'contracts/lib/dep']);
  assert.deepEqual(depsFromMainAreIdentical({ eraTree: T, headTree: T, submoduleHeads: { 'contracts/lib/dep': 'b'.repeat(40) } }), { identical: true, differences: [] });
  const vendoredMoved = T.replace('a'.repeat(40), 'c'.repeat(40));
  assert.equal(depsFromMainAreIdentical({ eraTree: T, headTree: vendoredMoved, submoduleHeads: { 'contracts/lib/dep': 'b'.repeat(40) } }).identical, false, 'a vendored tree that moved');
  assert.equal(depsFromMainAreIdentical({ eraTree: T, headTree: T, submoduleHeads: { 'contracts/lib/dep': 'd'.repeat(40) } }).identical, false, 'a submodule checkout not at the gitlink');
  assert.equal(depsFromMainAreIdentical({ eraTree: T, headTree: T, submoduleHeads: {} }).identical, false, 'an unknown submodule state is not identical');
  const extra = T + '040000 tree ' + 'e'.repeat(40) + '\tcontracts/lib/new\n';
  assert.equal(depsFromMainAreIdentical({ eraTree: T, headTree: extra, submoduleHeads: { 'contracts/lib/dep': 'b'.repeat(40) } }).identical, false, 'an entry present on one side only');
});

test('deployment build candidates: recorded commits, the main commits around each deployedAt, and the census\'s candidates file (#2095 r9 P1)', () => {
  const repo = mkdtempSync(join(tmpdir(), 'cand-repo-'));
  const g = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
  const commit = (msg, date) => { writeFileSync(join(repo, 'f.txt'), msg); g('add', 'f.txt'); execFileSync('git', ['commit', '-q', '-m', msg, '--date', date], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date } }); return g('rev-parse', 'HEAD').trim(); };
  const c1 = commit('one', '2026-05-01T00:00:00Z');
  const c2 = commit('two', '2026-05-02T00:00:00Z');
  const c3 = commit('three', '2026-05-03T00:00:00Z');
  assert.equal(deployedAtIso('1777680000-unix'), '2026-05-02T00:00:00Z');
  assert.equal(deployedAtIso('2026-05-02T05:30:00+05:30'), '2026-05-02T00:00:00Z');
  assert.equal(deployedAtIso('garbage'), null);
  // a moment between two and three: the last main commit at or before, and the first after
  assert.deepEqual(commitsAround('2026-05-02T12:00:00Z', { repo, ref: 'HEAD', branches: false }).map((c) => [c.commit, c.relation]), [[c2, 'last main commit at or before'], [c3, 'first main commit after']]);
  // a branch active around the moment contributes its last commit at or before it — but only refs every checkout
  // shares (origin's branches, tags), never a local head (#2095 r10); main's own tip is not repeated
  g('checkout', '-q', '-b', 'feat/x', c2);
  const bx = commit('branch work', '2026-05-02T06:00:00Z');
  g('checkout', '-q', 'main');
  const subject = (c) => g('log', '-1', '--format=%s', c).trim();
  assert.deepEqual(commitsAround('2026-05-02T12:00:00Z', { repo, ref: 'main' }).map((c) => subject(c.commit)), ['two', 'three'], 'a local head alone contributes nothing');
  g('update-ref', 'refs/remotes/origin/feat/x', bx);
  g('update-ref', 'refs/remotes/origin/feat/x-copy', bx); // the same tip under two refs is one candidate
  const withBranch = commitsAround('2026-05-02T12:00:00Z', { repo, ref: 'main' });
  assert.deepEqual(withBranch.map((c) => `${subject(c.commit)} | ${c.relation}`), ['two | last main commit at or before', 'three | first main commit after', 'branch work | last commit at or before, on origin/feat/x'], 'main before, main after, then the branch tip at or before the moment');
  // records: a live artifact deployed at that moment with a recorded (dirty) commit, and a candidates file from the census
  const dep = mkdtempSync(join(tmpdir(), 'cand-dep-'));
  mkdirSync(join(dep, 'x-chain'));
  writeFileSync(join(dep, 'x-chain', 'addresses.json'), JSON.stringify({ diamond: '0x1', deployedAt: '1777723200-unix' })); // 2026-05-02T12:00:00Z
  writeFileSync(join(dep, 'x-chain', 'deployment_source.json'), JSON.stringify({ monorepoCommit: c1 + ' (dirty)' }));
  const cf = join(dep, 'facet-build-candidates.json');
  writeFileSync(cf, JSON.stringify({ candidates: [{ commit: c3, reasons: ['last main commit at or before y-chain (live)\'s cut at block 5'] }] }));
  const out = deploymentBuildCandidates({ deploymentsDir: dep, candidatesFile: cf, repo, ref: 'HEAD' });
  assert.deepEqual(out.map((c) => c.commit).sort(), [c1, c2, c3, bx].sort(), 'the recorded commit, main around the deploy moment, the branch active then, and the census\'s candidate');
  const byCommit = Object.fromEntries(out.map((c) => [c.commit, c.reasons]));
  assert.deepEqual(byCommit[c1], ['recorded by x-chain/live']);
  assert.deepEqual(byCommit[c2], ['last main commit at or before x-chain/live\'s deployedAt 2026-05-02T12:00:00Z']);
  assert.deepEqual(byCommit[c3].sort(), ['first main commit after x-chain/live\'s deployedAt 2026-05-02T12:00:00Z', 'last main commit at or before y-chain (live)\'s cut at block 5']);
  assert.deepEqual(byCommit[bx], ['last commit at or before, on origin/feat/x x-chain/live\'s deployedAt 2026-05-02T12:00:00Z']);
  assert.deepEqual(out.filter((c) => c.required).map((c) => c.commit).sort(), [c1, c3].sort(), 'the recorded commit and the census\'s candidate are required; ref-derived ones are advisory');
  // a malformed candidates file is a failure, never an empty set (#2095 r16 P2)
  writeFileSync(cf, '{nope');
  assert.throws(() => deploymentBuildCandidates({ deploymentsDir: dep, candidatesFile: cf, repo, ref: 'HEAD' }), /unreadable or malformed/);
  writeFileSync(cf, JSON.stringify({ purpose: 'x' }));
  assert.throws(() => deploymentBuildCandidates({ deploymentsDir: dep, candidatesFile: cf, repo, ref: 'HEAD' }), /carries no candidates/);
});

test('a pruned cut block gets an estimated timestamp between two anchors (#2095 r9)', () => {
  assert.equal(interpolateTimestamp({ block: 150, b0: 100, t0: '2026-07-01T00:00:00Z', b1: 200, t1: '2026-07-01T00:03:20Z' }), '2026-07-01T00:01:40Z');
  assert.equal(interpolateTimestamp({ block: 100, b0: 100, t0: '2026-07-01T00:00:00Z', b1: 200, t1: '2026-07-01T00:03:20Z' }), '2026-07-01T00:00:00Z');
  assert.equal(interpolateTimestamp({ block: 150, b0: 200, t0: '2026-07-01T00:00:00Z', b1: 100, t1: '2026-07-01T00:03:20Z' }), null, 'anchors out of order');
  assert.equal(interpolateTimestamp({ block: 150, b0: 100, t0: 'x', b1: 200, t1: '2026-07-01T00:03:20Z' }), null);
});

test('an era edited after generation fails the content check even with its fingerprint intact (#2095 r22 P1)', () => {
  const index = [['0x11', 'RiskFacet'], ['0x22', 'ClaimFacet']];
  const era = { commit: 'a'.repeat(40), date: 'd', fingerprint: 'fp', storagePosition: '0x00', fields: { nextLoanId: { slot: '0x01', relative: 1, offset: 0, type: 't_uint256' } }, rows: { BorrowerLifRebate: { vpfiHeld: { slot: 0, offset: 0, type: 't_uint256' } } }, bytecodeIds: [0, 1] };
  era.contentDigest = contentDigestOf(era, index);
  const table = { head: era.commit, eras: [era], deploymentBuilds: [], bytecodeIndex: index };
  table.tableIdentity = tableIdentityOf(table);
  assert.deepEqual(verifyTableContents(table), []);
  // a moved slot, a swapped bytecode id, a deleted row member: each is caught; the fingerprint says nothing
  const moved = JSON.parse(JSON.stringify(table)); moved.eras[0].fields.nextLoanId.slot = '0x02';
  assert.match(verifyTableContents(moved)[0].reason, /edited after generation/);
  const swapped = JSON.parse(JSON.stringify(table)); swapped.bytecodeIndex[0] = ['0x33', 'RiskFacet'];
  assert.match(verifyTableContents(swapped)[0].reason, /edited after generation/);
  const noDigest = JSON.parse(JSON.stringify(table)); delete noDigest.eras[0].contentDigest;
  assert.match(verifyTableContents(noDigest)[0].reason, /no content digest/);
  // the digest ignores commit, date, event and reasons: a HEAD era rebuilt at a new commit with the same layout and code keeps its identity
  assert.equal(contentDigestOf({ ...era, commit: 'b'.repeat(40), date: 'x', event: 'HEAD', reasons: ['r'] }, index), era.contentDigest);
  assert.equal(tableIdentityOf({ ...table, eras: [{ ...era, commit: 'b'.repeat(40) }] }), table.tableIdentity);
});

test('the layout digest ignores the bytecode catalogue and per-build struct ids, and sees a moved slot (#2095 r23 P1)', () => {
  const e = { storagePosition: '0x00', fields: { nextLoanId: { slot: '0x01', relative: 1, offset: 0, type: 't_uint256' }, intentCommits: { slot: '0x02', relative: 2, offset: 0, type: 't_mapping(t_uint256,t_struct(SwapToRepayIntentCommit)123_storage)' } }, rows: { R: { a: { slot: 0, offset: 0, type: 't_uint256' } } }, bytecode: { '0x11': 'A' } };
  assert.equal(layoutDigestOf(e), layoutDigestOf({ ...e, bytecode: { '0x22': 'B' } }), 'bytecode is not part of the layout');
  assert.equal(layoutDigestOf(e), layoutDigestOf({ ...e, fields: { ...e.fields, intentCommits: { ...e.fields.intentCommits, type: 't_mapping(t_uint256,t_struct(SwapToRepayIntentCommit)999_storage)' } } }), 'struct ids are normalized');
  assert.notEqual(layoutDigestOf(e), layoutDigestOf({ ...e, fields: { ...e.fields, nextLoanId: { ...e.fields.nextLoanId, slot: '0x09' } } }));
});
