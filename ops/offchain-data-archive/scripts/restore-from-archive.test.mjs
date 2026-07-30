/**
 * node:test suite for restore-from-archive.mjs (#1477).
 *
 * The fixture archive deliberately carries the hostile shapes the
 * runbook's requirements name: values with embedded single quotes,
 * NULLs, keys with `../` segments, keys with shell metacharacters,
 * SHA mismatches, unknown value types, malformed identifiers — each
 * must be either handled exactly or fatal, never guessed at.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import path from 'node:path';

import {
  RestoreError,
  applyOrder,
  convertD1,
  materializeR2,
  invalidLegalDocRefs,
  shQuote,
  sqlLiteral,
  tableToSql,
  uploadR2,
  validateR2Key,
} from './restore-from-archive.mjs';

const HEX64 = 'a'.repeat(64);

function tableFixture(name, columns, rows) {
  return {
    name,
    schema: columns.map((c, i) => ({ cid: i, name: c, type: 'TEXT', notnull: 0, pk: 0 })),
    rowCount: rows.length,
    rows,
  };
}

/** Content-addressed fixture: the vault key IS the byte hash, so a
 *  valid object's key is derived from its content (as diagLegalDoc.ts
 *  mints them). Pass an explicit key only to model a hostile one. */
function r2Fixture(bytes, key) {
  const digest = createHash('sha256').update(bytes).digest('hex');
  return {
    key: key ?? `legal-holds/${digest}.pdf`,
    size: bytes.length,
    sha256: digest,
    base64Body: Buffer.from(bytes).toString('base64'),
  };
}

function outDir() {
  return mkdtempSync(path.join(tmpdir(), 'restore-test-'));
}

/** A minimal but BASELINE-COMPLETE d1.archive — every table the backup
 *  emits unconditionally, with FK-consistent rows. Tests override /
 *  extend from here; a smaller archive is (correctly) rejected. */
function baselineArchive() {
  return [
    tableFixture('diag_errors', ['id'], []),
    tableFixture('diag_legal_holds', ['id', 'legal_doc_ref'], []),
    tableFixture('diag_legal_hold_audit', ['id', 'legal_doc_ref'], []),
    tableFixture('user_thresholds', ['wallet', 'chain_id'], [{ wallet: '0xa', chain_id: 8453 }]),
    tableFixture('notify_state', ['wallet', 'chain_id'], [{ wallet: '0xa', chain_id: 8453 }]),
    tableFixture('telegram_links', ['wallet'], []),
  ];
}

// ── sqlLiteral ────────────────────────────────────────────────────────

test('quotes strings by doubling single quotes', () => {
  assert.equal(sqlLiteral("O'Brien's $var `cmd`", 't'), "'O''Brien''s $var `cmd`'");
});

test('emits NULL, bare finite numbers; rejects the rest', () => {
  assert.equal(sqlLiteral(null, 't'), 'NULL');
  assert.equal(sqlLiteral(42.5, 't'), '42.5');
  assert.throws(() => sqlLiteral(Infinity, 't'), RestoreError);
  assert.throws(() => sqlLiteral(true, 't'), RestoreError);
  assert.throws(() => sqlLiteral({ a: 1 }, 't'), RestoreError);
  assert.throws(() => sqlLiteral(undefined, 't'), RestoreError);
  assert.throws(() => sqlLiteral('nul\u0000byte', 't'), RestoreError);
});

// ── tableToSql ────────────────────────────────────────────────────────

test('batch begins with DELETE FROM and inserts every row', () => {
  const sql = tableToSql(
    tableFixture('user_thresholds', ['wallet', 'chain_id', 'note'], [
      { wallet: '0xabc', chain_id: 8453, note: "it's fine" },
      { wallet: '0xdef', chain_id: 84532, note: null },
    ]),
  );
  const statements = sql.split('\n').filter((l) => l && !l.startsWith('--'));
  assert.equal(statements[0], 'DELETE FROM "user_thresholds";');
  assert.equal(statements.length, 3);
  assert.match(statements[1], /VALUES \('0xabc', 8453, 'it''s fine'\);$/);
  assert.match(statements[2], /VALUES \('0xdef', 84532, NULL\);$/);
});

test('rejects hostile identifiers and self-inconsistent archives', () => {
  const bad = (t) => assert.throws(() => tableToSql(t), RestoreError);
  bad(tableFixture('users; DROP TABLE loans', ['a'], []));
  bad(tableFixture('users', ['a"b'], []));
  // header/rows disagreement = archive is lying about itself
  const t = tableFixture('users', ['a'], [{ a: 1 }]);
  t.rowCount = 2;
  bad(t);
  // row keyed off-schema = drift inside one archive
  bad(tableFixture('users', ['a'], [{ b: 1 }]));
});

// ── ordering ──────────────────────────────────────────────────────────

test('parents come first regardless of archive order', () => {
  const order = applyOrder([
    tableFixture('notify_state', ['a'], []),
    tableFixture('pre_grace_notify_state', ['a'], []),
    tableFixture('user_thresholds', ['a'], []),
  ]).map((t) => t.name);
  assert.deepEqual(order, ['user_thresholds', 'notify_state', 'pre_grace_notify_state']);
});

test('convertD1 writes files in apply order and routes lzAlerts separately', () => {
  const dir = outDir();
  const entries = convertD1(
    {
      version: 1,
      d1: {
        archive: baselineArchive(),
        lzAlerts: [tableFixture('lz_alert_state', ['a'], [{ a: 3 }])],
      },
    },
    dir,
    { lzDatabase: 'my-recreated-lz-db' },
  );
  assert.equal(entries[0].name, 'user_thresholds'); // parent first
  const notifyIdx = entries.findIndex((e) => e.name === 'notify_state');
  assert.ok(notifyIdx > 0);
  const lz = entries.at(-1);
  assert.deepEqual([lz.name, lz.database], ['lz_alert_state', 'my-recreated-lz-db']);
  const sql = readFileSync(entries[0].file, 'utf8');
  assert.match(sql, /^DELETE FROM "user_thresholds";$/m);
});

test('an empty or baseline-incomplete d1.archive is truncated, not small', () => {
  const dir = outDir();
  assert.throws(() => convertD1({ version: 1, d1: { archive: [] } }, dir), /baseline/);
  const missingNotify = baselineArchive().filter((t) => t.name !== 'notify_state');
  assert.throws(() => convertD1({ version: 1, d1: { archive: missingNotify } }, dir), /baseline/);
});

test('duplicate table entries are rejected, not last-writer-wins', () => {
  const dir = outDir();
  const dup = [...baselineArchive(), tableFixture('telegram_links', ['wallet'], [{ wallet: '0xb' }])];
  assert.throws(() => convertD1({ version: 1, d1: { archive: dup } }, dir), /exactly once/);
});

test('a child row whose FK key is absent from the archived parent is fatal', () => {
  const dir = outDir();
  const tables = baselineArchive();
  tables
    .find((t) => t.name === 'notify_state')
    .rows.push({ wallet: '0xORPHAN', chain_id: 1 });
  tables.find((t) => t.name === 'notify_state').rowCount = 2;
  assert.throws(() => convertD1({ version: 1, d1: { archive: tables } }, dir), /inconsistent/);
});

// ── R2 key validation ─────────────────────────────────────────────────

test('accepts exactly the canonical vault shape', () => {
  assert.equal(validateR2Key(`legal-holds/${HEX64}.pdf`), `legal-holds/${HEX64}.pdf`);
});

test('rejects traversal, absolute, metacharacter, off-shape keys', () => {
  const bad = (k) => assert.throws(() => validateR2Key(k), RestoreError, k);
  bad(`../../.ssh/authorized_keys`);
  bad(`legal-holds/../${HEX64}.pdf`);
  bad(`/etc/passwd`);
  bad(`legal-holds//${HEX64}.pdf`);
  bad(`legal-holds\\${HEX64}.pdf`);
  bad(`legal-holds/$(rm -rf)'\`.pdf`);
  bad(`legal-holds/${HEX64}.exe`);
  bad(`legal-holds/2026-05/notice-42.pdf`);
  bad('');
});

// ── R2 materialization ────────────────────────────────────────────────

test('writes objects under outdir/r2 and verifies the SHA', () => {
  const dir = outDir();
  const bytes = Buffer.from('%PDF-1.4 fixture');
  const written = materializeR2({ version: 1, r2: { objects: [r2Fixture(bytes)] } }, dir);
  assert.equal(written.length, 1);
  assert.ok(written[0].local.startsWith(path.resolve(dir, 'r2') + path.sep));
  assert.deepEqual(readFileSync(written[0].local), bytes);
});

test('a SHA mismatch is fatal, and nothing is written for a bad key', () => {
  const dir = outDir();
  const obj = r2Fixture(Buffer.from('real'));
  obj.sha256 = 'f'.repeat(64);
  assert.throws(() => materializeR2({ version: 1, r2: { objects: [obj] } }, dir), RestoreError);

  const evil = r2Fixture(Buffer.from('x'), '../escape.pdf');
  assert.throws(() => materializeR2({ version: 1, r2: { objects: [evil] } }, dir), RestoreError);
  assert.ok(!existsSync(path.resolve(dir, '..', 'escape.pdf')));
});

test('content addressing: bytes whose hash differs from the KEY hex are tampering', () => {
  const dir = outDir();
  // Internally consistent (sha256 matches the bytes) but stored under
  // a DIFFERENT document's key — the exact shape a pre-backup
  // replacement produces.
  const obj = r2Fixture(Buffer.from('attacker document'), `legal-holds/${HEX64}.pdf`);
  assert.throws(() => materializeR2({ version: 1, r2: { objects: [obj] } }, dir), /content-addressed/);
});

test('missing required archive sections are fatal, not empty successes', () => {
  const dir = outDir();
  assert.throws(() => convertD1({ version: 1, d1: {}, r2: {} }, dir), /d1\.archive/);
  assert.throws(() => materializeR2({ version: 1, d1: {}, r2: {} }, dir), /r2\.objects/);
});

test('tables the backup never exports are rejected before any batch is emitted', () => {
  const dir = outDir();
  const hostile = {
    version: 1,
    d1: { archive: [tableFixture('d1_migrations', ['name'], [{ name: 'x' }])] },
  };
  assert.throws(() => convertD1(hostile, dir), /never exports/);
  assert.ok(!existsSync(path.join(dir, 'd1', 'd1_migrations.sql')));
});

test('a parent without its archived cascade child is dependency-incomplete', () => {
  const dir = outDir();
  // notify_state is ALSO baseline, so its absence trips the baseline
  // check first — either message is a correct refusal; the cascade
  // fatal stays as defense in depth should the baseline set change.
  const incomplete = {
    version: 1,
    d1: { archive: [tableFixture('user_thresholds', ['a'], [{ a: 1 }])] },
  };
  assert.throws(() => convertD1(incomplete, dir), /baseline|notify_state/);
});

test('shQuote yields one shell argument for hostile paths', () => {
  assert.equal(shQuote(`out dir/it's`), `'out dir/it'\\''s'`);
});

// ── upload ────────────────────────────────────────────────────────────

test('uploads via argv array, restoring content-type; non-zero exit is fatal', () => {
  const calls = [];
  const okSpawn = (cmd, args) => (calls.push([cmd, args]), { status: 0 });
  uploadR2([{ key: `legal-holds/${HEX64}.pdf`, local: '/tmp/x' }], { spawn: okSpawn });
  assert.deepEqual(calls[0][0], 'wrangler');
  assert.deepEqual(calls[0][1], [
    'r2', 'object', 'put', `vaipakam-legal-vault/legal-holds/${HEX64}.pdf`,
    '--file', '/tmp/x', '--content-type', 'application/pdf', '--remote',
  ]);

  const badSpawn = () => ({ status: 1 });
  assert.throws(
    () => uploadR2([{ key: `legal-holds/${HEX64}.pdf`, local: '/tmp/x' }], { spawn: badSpawn }),
    RestoreError,
  );
});

test('legal-hold reference PAIR invariants: missing, malformed, and sha-mismatched refs', () => {
  const doc = r2Fixture(Buffer.from('%PDF doc'));
  const docHash = doc.key.slice('legal-holds/'.length, -'.pdf'.length);
  const holds = tableFixture('diag_legal_holds', ['id', 'legal_doc_ref', 'legal_doc_sha256'], [
    { id: 1, legal_doc_ref: doc.key, legal_doc_sha256: docHash },
    { id: 2, legal_doc_ref: null, legal_doc_sha256: null },
  ]);
  const ok = { d1: { archive: [holds] }, r2: { objects: [doc] } };
  assert.deepEqual(invalidLegalDocRefs(ok), []);

  const gone = `legal-holds/${'b'.repeat(64)}.pdf`;
  holds.rows.push(
    { id: 3, legal_doc_ref: gone, legal_doc_sha256: null },        // absent from archive
    { id: 4, legal_doc_ref: '', legal_doc_sha256: null },          // empty ref = tampering shape
    { id: 5, legal_doc_ref: doc.key, legal_doc_sha256: 'f'.repeat(64) }, // sha disagrees with key
  );
  holds.rowCount = 5;
  const problems = invalidLegalDocRefs({ d1: { archive: [holds] }, r2: { objects: [doc] } });
  assert.equal(problems.length, 3);
  assert.match(problems[0].problem, /absent/);
  assert.match(problems[1].problem, /not a canonical/);
  assert.match(problems[2].problem, /disagrees/);
});

test('non-version-1 archives are rejected before any output', () => {
  const dir = outDir();
  assert.throws(() => convertD1({ version: 999, d1: { archive: baselineArchive() } }, dir), /version/);
  assert.throws(() => materializeR2({ d1: {}, r2: { objects: [] } }, dir), /version/);
});

test('content-addressed but non-PDF bytes are rejected (ingestion parity)', () => {
  const dir = outDir();
  const notPdf = r2Fixture(Buffer.from('MZ definitely-not-a-pdf'));
  assert.throws(
    () => materializeR2({ version: 1, r2: { objects: [notPdf] } }, dir),
    /PDF magic/,
  );
});

test('FK preflight uses collision-free tuple encoding', () => {
  const dir = outDir();
  const tables = baselineArchive();
  // Codex #1484 r3's example: with naive concatenation these two
  // tuples collide; the orphan must still be detected.
  tables.find((t) => t.name === 'user_thresholds').rows = [
    { wallet: 'a\u001f1', chain_id: 2 },
  ];
  tables.find((t) => t.name === 'user_thresholds').rowCount = 1;
  tables.find((t) => t.name === 'notify_state').rows = [
    { wallet: 'a', chain_id: '1\u001f2' },
  ];
  tables.find((t) => t.name === 'notify_state').rowCount = 1;
  assert.throws(() => convertD1({ version: 1, d1: { archive: tables } }, dir), /inconsistent/);
});
