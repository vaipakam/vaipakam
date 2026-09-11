// storage-layout-provenance.test.mjs — the append-only property the calibrated
// storage read rests on (#1566, design §7), on synthetic sources and a real
// throwaway git repository.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { extractDeclarations, isPrefix, walkProvenance, stripComments, inlineStructsBefore, layoutFingerprint, layoutShapeFingerprint, storagePositionOf, unacknowledgedViolations, isLayoutViolation, changeEventKey } from './storage-layout-provenance.mjs';

const SRC = (extra = '', rowExtra = '') => `
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;
library LibVaipakam {
    /// @dev a row
    struct Row { bytes32 orderHash; uint64 deadline; ${rowExtra} }
    struct Storage {
        uint256 nextLoanId; // ids
        /* block
           comment { with braces } */
        mapping(uint256 => Row) intentCommits;
        ${extra}
    }
}
`;

test('extractDeclarations: comments stripped, whitespace normalised, order kept', () => {
  assert.deepEqual(extractDeclarations(SRC(), 'Storage'), ['uint256 nextLoanId', 'mapping(uint256 => Row) intentCommits']);
  assert.deepEqual(extractDeclarations(SRC(), 'Row'), ['bytes32 orderHash', 'uint64 deadline']);
  assert.throws(() => extractDeclarations(SRC(), 'Nope'), /not found/);
  assert.equal(stripComments('a /* { */ b // }\nc').replace(/\s+/g, ' ').trim(), 'a b c');
  // a block-comment opener INSIDE a line comment must not open a block comment
  assert.equal(stripComments('x; // see /* legacy\ny; } /* real */ z').replace(/\s+/g, ' ').trim(), 'x; y; } z');
  assert.equal(stripComments('s = "//not a comment"; t').trim(), 's = "//not a comment"; t');
});

test('isPrefix: appended fields are fine; an insertion, a retype or a removal is a violation', () => {
  const today = ['uint256 a', 'uint256 b', 'uint256 c'];
  assert.equal(isPrefix(['uint256 a', 'uint256 b'], today).ok, true);
  assert.equal(isPrefix(today, today).ok, true);
  // an inserted same-typed field: b MOVED from 1 to 2 — a violation, not a rename
  const moved = isPrefix(['uint256 a', 'uint256 x', 'uint256 b'], today);
  assert.equal(moved.ok, false);
  assert.match(moved.reason, /"uint256 b" is at index 1 today and was at index 2 then/);
  // a mapping's VALUE type may change without moving anything (one slot either way)
  assert.equal(isPrefix(['mapping(address => uint8) k', 'uint256 b'], ['mapping(address => uint16) k', 'uint256 b', 'uint256 c']).ok, true);
  assert.equal(isPrefix(['uint8[] arr', 'uint256 b'], ['uint16[] arr', 'uint256 b']).ok, true);
  // but a fixed array or an inline value type that changes size is a violation
  assert.equal(isPrefix(['uint8[2] arr', 'uint256 b'], ['uint8[3] arr', 'uint256 b']).ok, false);
  assert.match(isPrefix(['uint128 a', 'uint256 b'], today).reason, /"uint128 a" was at index 0/);
  // a pure rename keeps the slot: not a violation, reported as a note
  const renamed = isPrefix(['uint256 aOld', 'uint256 b'], today);
  assert.equal(renamed.ok, true);
  assert.deepEqual(renamed.renames, [{ index: 0, was: 'aOld', now: 'a' }]);
  assert.match(isPrefix(['uint256 a', 'uint256 b', 'uint256 c', 'uint256 d'], today).reason, /removed/);
});

test('walkProvenance over a real repository: append-only history passes, an insertion is named by commit', () => {
  const repo = mkdtempSync(join(tmpdir(), 'prov-'));
  const lib = 'contracts/src/libraries/LibVaipakam.sol';
  mkdirSync(join(repo, 'contracts/src/libraries'), { recursive: true });
  const g = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  g('init', '-q'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
  const commit = (src, msg, date) => { writeFileSync(join(repo, lib), src); g('add', lib); execFileSync('git', ['commit', '-q', '-m', msg, '--date', date], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date } }); };
  commit(SRC(), 'v1', '2026-05-02T00:00:00Z');
  commit(SRC('uint256 totalLoansEverCreated;'), 'v2 append', '2026-06-01T00:00:00Z');
  commit(SRC('uint256 totalLoansEverCreated; uint256 intentLiveCommitCount;'), 'v3 append', '2026-07-01T00:00:00Z');
  const ok = walkProvenance({ repo, libPath: lib, since: '2026-05-01', structs: ['Storage', 'Row'], fields: ['intentCommits', 'totalLoansEverCreated'] });
  assert.equal(ok.ok, true, JSON.stringify(ok.violations));
  assert.equal(ok.commitsWalked, 3);
  assert.equal(ok.fields.intentCommits.todayIndex, 1);
  assert.equal(ok.fields.totalLoansEverCreated.introducedAt.date.slice(0, 10), '2026-06-01');
  // now an INSERTION before intentCommits at HEAD: every earlier sequence stops being a prefix
  commit(SRC().replace('uint256 nextLoanId; // ids', 'uint256 nextLoanId; uint256 inserted;') , 'v4 insert', '2026-08-01T00:00:00Z');
  const bad = walkProvenance({ repo, libPath: lib, since: '2026-05-01', structs: ['Storage', 'Row'], fields: ['intentCommits'] });
  assert.equal(bad.ok, false);
  assert.ok(bad.violations.length >= 2, 'the v2 and v3 sequences no longer prefix today');
  assert.match(bad.violations[0].reason, /intentCommits/);
  // a retyped ROW member is a violation too (packing changes)
  commit(SRC('', '').replace('uint64 deadline', 'uint128 deadline'), 'v5 retype row', '2026-09-01T00:00:00Z');
  const row = walkProvenance({ repo, libPath: lib, since: '2026-05-01', structs: ['Row'], fields: [] });
  assert.equal(row.ok, false);
  assert.equal(row.violations[0].struct, 'Row');
});

test('inline structs before a target are layout-bearing: a member added to one is a change event (#2095 r1 P1)', () => {
  const src = (cfg) => `
library LibVaipakam {
    struct Config { uint16 a; ${cfg} }
    struct Row { bytes32 orderHash; }
    enum Mode { A, B }
    struct Storage {
        uint256 nextLoanId;
        Config cfg;
        Mode mode;
        mapping(uint256 => Row) intentCommits;
        Config after;
    }
}`;
  // discovery: Config precedes intentCommits (the trailing one does not add a new name); an enum is not a struct
  assert.deepEqual(inlineStructsBefore(src(''), ['intentCommits']), { local: ['Config'], external: [] });
  assert.deepEqual(inlineStructsBefore('library L { struct Storage { EnumerableSet.AddressSet s; uint256 nextLoanId; } }', ['nextLoanId']).external, ['EnumerableSet.AddressSet']);
  // walk: a member appended to Config shifts intentCommits without any Storage declaration changing
  const repo = mkdtempSync(join(tmpdir(), 'prov-inline-'));
  const lib = 'contracts/src/libraries/LibVaipakam.sol';
  mkdirSync(join(repo, 'contracts/src/libraries'), { recursive: true });
  const g = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  g('init', '-q'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
  const commit = (s, msg, date) => { writeFileSync(join(repo, lib), s); g('add', lib); execFileSync('git', ['commit', '-q', '-m', msg, '--date', date], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date } }); };
  commit(src(''), 'v1', '2026-05-02T00:00:00Z');
  commit(src('uint256 b;'), 'v2 config grows', '2026-06-01T00:00:00Z');
  const w = walkProvenance({ repo, libPath: lib, since: '2026-05-01', structs: ['Storage', 'Row'], fields: ['intentCommits'] });
  assert.deepEqual(w.inlineStructs, { local: ['Config'], external: [], historical: [] });
  assert.equal(w.changeEvents.length, 1);
  assert.equal(w.changeEvents[0].struct, 'Config');
  assert.equal(w.changeEvents[0].kind, 'append', 'an append inside an inline struct grows its footprint');
});

test('a storage-position change is an era for every field, and the fingerprint is content, not a SHA (#2095 r2)', () => {
  const src = (pos) => `library LibVaipakam {\n  bytes32 internal constant VANGKI_STORAGE_POSITION = ${pos};\n  struct Row { bytes32 orderHash; }\n  struct Storage { uint256 nextLoanId; mapping(uint256 => Row) intentCommits; }\n}`;
  const A = '0x' + 'aa'.repeat(32); const B = '0x' + 'bb'.repeat(32);
  const repo = mkdtempSync(join(tmpdir(), 'prov-ns-'));
  const lib = 'contracts/src/libraries/LibVaipakam.sol';
  mkdirSync(join(repo, 'contracts/src/libraries'), { recursive: true });
  const g = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  g('init', '-q'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
  const commit = (s, msg, date) => { writeFileSync(join(repo, lib), s); g('add', lib); execFileSync('git', ['commit', '-q', '-m', msg, '--date', date], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date } }); };
  commit(src(A), 'v1', '2026-05-02T00:00:00Z');
  commit(src(B), 'v2 namespace moved', '2026-06-01T00:00:00Z');
  const w = walkProvenance({ repo, libPath: lib, since: '2026-05-01', structs: ['Storage', 'Row'], fields: ['intentCommits'] });
  assert.equal(w.changeEvents.length, 1);
  assert.equal(w.changeEvents[0].kind, 'namespace-change');
  assert.equal(w.positionEras.length, 2);
  assert.equal(w.violations.length, 0, 'the declaration sequences never changed');
  // fingerprint: identical content → identical fingerprint whatever the commit; a position or declaration change → different
  assert.equal(layoutFingerprint(src(B), ['Storage', 'Row'], ['intentCommits']), w.headFingerprint);
  assert.notEqual(layoutFingerprint(src(A), ['Storage', 'Row'], ['intentCommits']), w.headFingerprint);
  assert.equal(storagePositionOf(src(B)).position, B);
});

test('an inline struct that preceded a target at an earlier revision is tracked while it lived, even when HEAD no longer embeds it (#2095 r5 P1)', () => {
  const src = (oldMembers, embedOld) => `
library LibVaipakam {
    struct Old { uint256 x; ${oldMembers} }
    struct Row { bytes32 orderHash; }
    struct Storage {
        uint256 nextLoanId;
        ${embedOld ? 'Old old;' : ''}
        mapping(uint256 => Row) intentCommits;
    }
}`;
  const repo = mkdtempSync(join(tmpdir(), 'prov-hist-inline-'));
  const lib = 'contracts/src/libraries/LibVaipakam.sol';
  mkdirSync(join(repo, 'contracts/src/libraries'), { recursive: true });
  const g = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  g('init', '-q'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
  const commit = (s, msg, date) => { writeFileSync(join(repo, lib), s); g('add', lib); execFileSync('git', ['commit', '-q', '-m', msg, '--date', date], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date } }); };
  commit(src('', true), 'v1 Old precedes the target', '2026-05-02T00:00:00Z');
  commit(src('uint256 y;', true), 'v2 Old grows — shifts intentCommits', '2026-06-01T00:00:00Z');
  commit(src('uint256 y;', false), 'v3 Old removed from Storage', '2026-07-01T00:00:00Z');
  const w = walkProvenance({ repo, libPath: lib, since: '2026-05-01', structs: ['Storage', 'Row'], fields: ['intentCommits'] });
  assert.deepEqual(w.inlineStructs.local, [], 'HEAD embeds no inline struct before the target');
  assert.deepEqual(w.inlineStructs.historical, ['Old'], 'but an earlier revision did');
  const kinds = w.changeEvents.map((e) => `${e.struct} ${e.kind}`);
  assert.ok(kinds.includes('Old append'), `the growth of Old while it lived is an era: ${kinds.join(' | ')}`);
  assert.ok(kinds.includes('Storage removal'), `its removal from Storage is Storage's own era: ${kinds.join(' | ')}`);
  assert.deepEqual(w.violations.map((v) => v.struct), ['Storage', 'Storage'], 'the two revisions that embedded Old are Storage prefix violations; Old itself is not compared against a HEAD that lacks it');
});

test('the layout SHAPE ignores names: a rename keeps it, an insertion or a retype changes it (#2095 r9)', () => {
  const a = SRC('uint256 totalLoansEverCreated;');
  const renamed = SRC('uint256 lifetimeLoans;');
  const inserted = SRC('uint256 x; uint256 totalLoansEverCreated;');
  const retyped = SRC('uint128 totalLoansEverCreated;');
  const S = (src) => layoutShapeFingerprint(src, ['Storage', 'Row'], ['intentCommits']);
  assert.equal(S(a), S(renamed), 'a rename is the same shape');
  assert.notEqual(layoutFingerprint(a, ['Storage', 'Row'], ['intentCommits']), layoutFingerprint(renamed, ['Storage', 'Row'], ['intentCommits']), 'but a different content fingerprint');
  // with intentCommits as the only target, everything after it is outside the layout-bearing prefix: the same shape
  assert.equal(S(a), S(inserted), 'a field inserted after the last target');
  assert.equal(S(a), S(retyped), 'a retype after the last target');
  // with totalLoansEverCreated a target too, the same edits are inside the prefix
  const T = (src) => layoutShapeFingerprint(src, ['Storage', 'Row'], ['intentCommits', 'totalLoansEverCreated']);
  assert.notEqual(T(a), T(inserted), 'a field inserted before a target');
  assert.notEqual(T(a), T(retyped), 'a target retyped');
  // fields AFTER the last target move nothing the census reads: the same shape (the walk opens no era for them either)
  const appendedAfter = SRC('uint256 totalLoansEverCreated; uint256 laterField; mapping(address => uint256) laterMap;');
  assert.equal(T(SRC('uint256 totalLoansEverCreated;')), T(appendedAfter), 'an append after the last target keeps the shape');
  assert.notEqual(T(SRC('uint256 totalLoansEverCreated;')), T(SRC('uint256 x; uint256 totalLoansEverCreated;')), 'an insertion before it does not');
});

test('only layout changes the rule forbids and nobody acknowledged fail the walk (#2095 r13 P1)', () => {
  const A = 'a'.repeat(40); const B = 'b'.repeat(40); const C = 'c'.repeat(40);
  const events = [
    { commit: A, struct: 'Storage', kind: 'insertion', firstDifferentIndex: 3, before: 'uint256 a', after: 'uint256 x' },
    { commit: B, struct: 'Storage', kind: 'append', firstDifferentIndex: 300, before: '(end)', after: 'uint256 z' },     // a Storage append is allowed
    { commit: B, struct: 'ProtocolConfig', kind: 'append', firstDifferentIndex: 9, before: '(end)', after: 'bool f' }, // an inline-struct append shifts fields: forbidden
    { commit: C, struct: 'Storage', kind: 'removal', firstDifferentIndex: 56, before: 'uint256 g', after: 'uint256 h' },
  ];
  assert.deepEqual(events.map(isLayoutViolation), [true, false, true, true]);
  // acknowledgements are keyed by the change's CONTENT, so a squash merge (a new commit, the same change) still matches
  const ack = { acknowledged: [{ key: changeEventKey(events[0]), reason: 'historical' }, { key: changeEventKey({ ...events[3], commit: 'd'.repeat(40) }), reason: 'historical' }] };
  const un = unacknowledgedViolations(events, ack);
  assert.deepEqual(un.map((e) => `${e.struct} ${e.kind}`), ['ProtocolConfig append'], 'the inline-struct append at B is the one unacknowledged change');
  assert.equal(unacknowledgedViolations(events, null).length, 3, 'no acknowledgement file: every forbidden change counts');
});
