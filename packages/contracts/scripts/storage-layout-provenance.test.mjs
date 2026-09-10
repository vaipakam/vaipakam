// storage-layout-provenance.test.mjs — the append-only property the calibrated
// storage read rests on (#1566, design §7), on synthetic sources and a real
// throwaway git repository.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { extractDeclarations, isPrefix, walkProvenance, stripComments, inlineStructsBefore, layoutFingerprint, storagePositionOf } from './storage-layout-provenance.mjs';

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
  assert.deepEqual(w.inlineStructs, { local: ['Config'], external: [] });
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
