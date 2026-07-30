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
import {
  chmodSync, closeSync, existsSync, fstatSync, mkdtempSync,
  openSync, readFileSync, statSync, symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import path from 'node:path';

import {
  RestoreError,
  applyOrder,
  convertD1,
  materializeR2,
  invalidLegalDocRefs,
  invalidLegalRowShapes,
  reconcileLegalHolds,
  shQuote,
  sqlLiteral,
  tableToSql,
  uploadR2,
  validateR2Key,
} from './restore-from-archive.mjs';

const HEX64 = 'a'.repeat(64);

function tableFixture(name, columns, rows, pks = {}) {
  return {
    name,
    schema: columns.map((c, i) => ({ cid: i, name: c, type: 'TEXT', notnull: 0, pk: pks[c] ?? 0 })),
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

/** The live column sets (apps/indexer/migrations) — convertD1 rejects
 *  an archived schema that omits any of these (r13), so the baseline
 *  fixture must mirror reality. */
const LIVE_COLUMNS = {
  user_thresholds: [
    'wallet', 'chain_id', 'warn_hf', 'alert_hf', 'critical_hf',
    'tg_chat_id', 'push_channel', 'created_at', 'updated_at',
    'locale', 'notify_maturity_approaching', 'last_test_alert_at',
  ],
  notify_state: ['wallet', 'chain_id', 'loan_id', 'last_band', 'last_hf_milli', 'last_sent_ts'],
  telegram_links: ['code', 'wallet', 'chain_id', 'expires_at'],
  diag_errors: [
    'id', 'recorded_at', 'client_at', 'fingerprint', 'area', 'flow', 'step',
    'error_type', 'error_name', 'error_selector', 'error_message',
    'redacted_wallet', 'chain_id', 'loan_id', 'offer_id',
    'app_locale', 'app_theme', 'viewport', 'app_version', 'wallet_hash',
  ],
  diag_legal_holds: [
    'wallet_hash', 'hold_reason', 'disclosure_allowed', 'disclosure_note',
    'legal_doc_ref', 'legal_doc_sha256', 'created_at', 'updated_at',
  ],
  diag_legal_hold_audit: [
    'id', 'at', 'action', 'wallet_hash', 'admin_wallet',
    'detail', 'legal_doc_ref', 'legal_doc_sha256',
  ],
};

/** A full-schema user_thresholds row; FK tests override the key. */
function utRow(overrides = {}) {
  return {
    wallet: '0xa', chain_id: 8453, warn_hf: 1.5, alert_hf: 1.2, critical_hf: 1.05,
    tg_chat_id: null, push_channel: null, created_at: 1, updated_at: 1,
    locale: 'en', notify_maturity_approaching: 1, last_test_alert_at: 0,
    ...overrides,
  };
}

/** A minimal but BASELINE-COMPLETE d1.archive — every table the backup
 *  emits unconditionally, with live-complete schemas and FK-consistent
 *  rows. Tests override / extend from here; a smaller archive is
 *  (correctly) rejected. */
function baselineArchive() {
  return [
    tableFixture('diag_errors', LIVE_COLUMNS.diag_errors, []),
    tableFixture('diag_legal_holds', LIVE_COLUMNS.diag_legal_holds, []),
    tableFixture('diag_legal_hold_audit', LIVE_COLUMNS.diag_legal_hold_audit, []),
    tableFixture('user_thresholds', LIVE_COLUMNS.user_thresholds, [utRow()]),
    tableFixture(
      'notify_state', LIVE_COLUMNS.notify_state,
      [{ wallet: '0xa', chain_id: 8453, loan_id: 1, last_band: 'healthy', last_hf_milli: 0, last_sent_ts: 0 }],
    ),
    tableFixture('telegram_links', LIVE_COLUMNS.telegram_links, []),
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
  assert.ok(path.isAbsolute(entries[0].file)); // printed commands must survive the cd-subshell
});

test('hold↔audit reconciliation catches snapshot races in both directions', () => {
  const doc = `legal-holds/${'c'.repeat(64)}.pdf`;
  const reason = 'Court order 42/2026';
  const holdsWith = (rows) =>
    tableFixture(
      'diag_legal_holds',
      ['wallet_hash', 'legal_doc_ref', 'hold_reason', 'disclosure_allowed', 'disclosure_note'],
      rows.map((r) => ({ disclosure_allowed: 0, disclosure_note: null, ...r })),
    );
  const auditWith = (rows) =>
    tableFixture(
      'diag_legal_hold_audit',
      ['id', 'at', 'action', 'wallet_hash', 'legal_doc_ref', 'detail'],
      rows,
    );
  const arch = (holds, audit) => ({ d1: { archive: [holds, audit] } });

  // Consistent pair: place then still held, matching document.
  const okPair = arch(
    holdsWith([{ wallet_hash: 'w1', legal_doc_ref: doc, hold_reason: reason }]),
    auditWith([{ id: 1, at: 100, action: 'place', wallet_hash: 'w1', legal_doc_ref: doc, detail: reason }]),
  );
  assert.deepEqual(reconcileLegalHolds(okPair), []);

  // place audit, no hold row → a required erasure block would vanish.
  const placeNoHold = arch(
    holdsWith([]),
    auditWith([{ id: 1, at: 100, action: 'place', wallet_hash: 'w1', legal_doc_ref: doc, detail: reason }]),
  );
  assert.match(reconcileLegalHolds(placeNoHold)[0].problem, /omits/);

  // hold present but the LATEST audit is lift → resurrected hold.
  const liftedButHeld = arch(
    holdsWith([{ wallet_hash: 'w1', legal_doc_ref: doc, hold_reason: reason }]),
    auditWith([
      { id: 1, at: 100, action: 'place', wallet_hash: 'w1', legal_doc_ref: doc, detail: reason },
      { id: 2, at: 200, action: 'lift', wallet_hash: 'w1', legal_doc_ref: null, detail: '' },
    ]),
  );
  assert.match(reconcileLegalHolds(liftedButHeld)[0].problem, /resurrects/);

  // hold document differs from its latest place audit.
  const docDrift = arch(
    holdsWith([{ wallet_hash: 'w1', legal_doc_ref: `legal-holds/${'d'.repeat(64)}.pdf`, hold_reason: reason }]),
    auditWith([{ id: 1, at: 100, action: 'place', wallet_hash: 'w1', legal_doc_ref: doc, detail: reason }]),
  );
  assert.match(reconcileLegalHolds(docDrift)[0].problem, /differs/);

  // hold with no audit history at all — the writer always appends one.
  const orphanHold = arch(
    holdsWith([{ wallet_hash: 'w1', legal_doc_ref: doc, hold_reason: reason }]),
    auditWith([]),
  );
  assert.match(reconcileLegalHolds(orphanHold)[0].problem, /no place\/lift audit/);
});

test('disclosure state replays from the audit, not from the hold row alone', () => {
  const doc = `legal-holds/${'c'.repeat(64)}.pdf`;
  const reason = 'Court order 42/2026';
  const holdsWith = (rows) =>
    tableFixture(
      'diag_legal_holds',
      ['wallet_hash', 'legal_doc_ref', 'hold_reason', 'disclosure_allowed', 'disclosure_note'],
      rows.map((r) => ({ hold_reason: reason, ...r })),
    );
  const auditWith = (rows) =>
    tableFixture(
      'diag_legal_hold_audit',
      ['id', 'at', 'action', 'wallet_hash', 'legal_doc_ref', 'detail'],
      rows,
    );
  const arch = (holds, audit) => ({ d1: { archive: [holds, audit] } });
  // A place audit's detail IS the raw holdReason (the writer binds
  // the same value into hold_reason) — non-empty, since the parser
  // rejects a placement without one.
  const place = (id, at, ref = doc) =>
    ({ id, at, action: 'place', wallet_hash: 'w1', legal_doc_ref: ref, detail: reason });
  const lift = (id, at) =>
    ({ id, at, action: 'lift', wallet_hash: 'w1', legal_doc_ref: null, detail: '' });
  const setDisc = (id, at, detail) =>
    ({ id, at, action: 'set-disclosure', wallet_hash: 'w1', legal_doc_ref: null, detail });

  // Consistent: the hold reflects the latest set-disclosure.
  const consistent = arch(
    holdsWith([{ wallet_hash: 'w1', legal_doc_ref: doc, disclosure_allowed: 1, disclosure_note: 'Retained under subpoena' }]),
    auditWith([place(1, 100), setDisc(2, 200, 'disclosure_allowed=1; note=Retained under subpoena')]),
  );
  assert.deepEqual(reconcileLegalHolds(consistent), []);

  // Revoke landed between the two exports: holds still says 1 but the
  // latest audit turned disclosure off — restoring would surface a
  // gagged hold's note.
  const revokedRace = arch(
    holdsWith([{ wallet_hash: 'w1', legal_doc_ref: doc, disclosure_allowed: 1, disclosure_note: 'Retained under subpoena' }]),
    auditWith([
      place(1, 100),
      setDisc(2, 200, 'disclosure_allowed=1; note=Retained under subpoena'),
      setDisc(3, 300, 'disclosure_allowed=0; note='),
    ]),
  );
  assert.match(reconcileLegalHolds(revokedRace)[0].problem, /disclosure/);

  // Same flag, drifted note — still not one consistent moment.
  const noteDrift = arch(
    holdsWith([{ wallet_hash: 'w1', legal_doc_ref: doc, disclosure_allowed: 1, disclosure_note: 'old wording' }]),
    auditWith([place(1, 100), setDisc(2, 200, 'disclosure_allowed=1; note=new wording')]),
  );
  assert.match(reconcileLegalHolds(noteDrift)[0].problem, /disclosure/);

  // A set-disclosure BEFORE the last lift died with the deleted row:
  // the re-placed hold's fresh 0/NULL default is the expected state.
  const rePlaced = arch(
    holdsWith([{ wallet_hash: 'w1', legal_doc_ref: doc, disclosure_allowed: 0, disclosure_note: null }]),
    auditWith([
      place(1, 100),
      setDisc(2, 150, 'disclosure_allowed=1; note=short-lived'),
      lift(3, 200),
      place(4, 300),
    ]),
  );
  assert.deepEqual(reconcileLegalHolds(rePlaced), []);

  // …and a hold claiming disclosure with NO surviving set-disclosure
  // audit is flagged, whatever pre-lift history exists.
  const armedFromNowhere = arch(
    holdsWith([{ wallet_hash: 'w1', legal_doc_ref: doc, disclosure_allowed: 1, disclosure_note: 'short-lived' }]),
    auditWith([
      place(1, 100),
      setDisc(2, 150, 'disclosure_allowed=1; note=short-lived'),
      lift(3, 200),
      place(4, 300),
    ]),
  );
  assert.match(reconcileLegalHolds(armedFromNowhere)[0].problem, /disclosure/);

  // Off-format detail can't be verified — fail, don't guess.
  const mangledDetail = arch(
    holdsWith([{ wallet_hash: 'w1', legal_doc_ref: doc, disclosure_allowed: 0, disclosure_note: null }]),
    auditWith([place(1, 100), setDisc(2, 200, 'oops not the writer format')]),
  );
  assert.match(reconcileLegalHolds(mangledDetail)[0].problem, /structured format/);

  // A set-disclosure while NO hold existed is impossible in production
  // (the endpoint 404s without appending) — flagged outright, not
  // silently treated as the expected state (r9). Before the first
  // place…
  const discBeforePlace = arch(
    holdsWith([{ wallet_hash: 'w1', legal_doc_ref: doc, disclosure_allowed: 1, disclosure_note: 'planted' }]),
    auditWith([setDisc(1, 50, 'disclosure_allowed=1; note=planted'), place(2, 100)]),
  );
  assert.ok(reconcileLegalHolds(discBeforePlace).some((p) => /no hold existed/.test(p.problem)));

  // …and in the gap between a lift and the fresh re-place.
  const discInGap = arch(
    holdsWith([{ wallet_hash: 'w1', legal_doc_ref: doc, disclosure_allowed: 1, disclosure_note: 'planted' }]),
    auditWith([
      place(1, 100),
      lift(2, 200),
      setDisc(3, 250, 'disclosure_allowed=1; note=planted'),
      place(4, 300),
    ]),
  );
  assert.ok(reconcileLegalHolds(discInGap).some((p) => /no hold existed/.test(p.problem)));
});

test('hold reason replays from the latest placement audit (r9)', () => {
  const doc = `legal-holds/${'c'.repeat(64)}.pdf`;
  const holdsWith = (rows) =>
    tableFixture(
      'diag_legal_holds',
      ['wallet_hash', 'legal_doc_ref', 'hold_reason', 'disclosure_allowed', 'disclosure_note'],
      rows.map((r) => ({ disclosure_allowed: 0, disclosure_note: null, ...r })),
    );
  const auditWith = (rows) =>
    tableFixture(
      'diag_legal_hold_audit',
      ['id', 'at', 'action', 'wallet_hash', 'legal_doc_ref', 'detail'],
      rows,
    );
  const arch = (holds, audit) => ({ d1: { archive: [holds, audit] } });
  const place = (id, at, reason) =>
    ({ id, at, action: 'place', wallet_hash: 'w1', legal_doc_ref: doc, detail: reason });

  // Consistent: the hold cites the same reason its latest placement
  // audited.
  const consistent = arch(
    holdsWith([{ wallet_hash: 'w1', legal_doc_ref: doc, hold_reason: 'Court order 42/2026' }]),
    auditWith([place(1, 100, 'Court order 42/2026')]),
  );
  assert.deepEqual(reconcileLegalHolds(consistent), []);

  // Re-place with a changed reason landed between the two exports:
  // the hold still cites the superseded order.
  const staleReason = arch(
    holdsWith([{ wallet_hash: 'w1', legal_doc_ref: doc, hold_reason: 'Court order 42/2026' }]),
    auditWith([place(1, 100, 'Court order 42/2026'), place(2, 200, 'Court order 77/2026')]),
  );
  assert.match(reconcileLegalHolds(staleReason)[0].problem, /reason/);

  // '' on BOTH sides is NOT a consistent pair: the production parser
  // rejects a placement without a non-empty reason, so a gutted
  // reason+detail is an impossible record, never a match (r10).
  const guttedPair = arch(
    holdsWith([{ wallet_hash: 'w1', legal_doc_ref: doc, hold_reason: '' }]),
    auditWith([place(1, 100, '')]),
  );
  assert.match(reconcileLegalHolds(guttedPair)[0].problem, /impossible/);

  // …and a NULL detail must not be normalized into a comparable ''.
  const nullDetail = arch(
    holdsWith([{ wallet_hash: 'w1', legal_doc_ref: doc, hold_reason: '' }]),
    auditWith([place(1, 100, null)]),
  );
  assert.match(reconcileLegalHolds(nullDetail)[0].problem, /impossible/);
});

test('duplicate archived primary keys are rejected before any batch is emitted (r12)', () => {
  // Single-column key.
  const dup = tableFixture(
    'telegram_links', ['code'],
    [{ code: '111111' }, { code: '111111' }],
  );
  assert.throws(() => tableToSql(dup), /duplicate primary key/);

  // Composite key: same wallet on different chains is legitimate…
  const okComposite = tableFixture(
    'user_thresholds', ['wallet', 'chain_id'],
    [{ wallet: '0xa', chain_id: 1 }, { wallet: '0xa', chain_id: 8453 }],
  );
  assert.match(tableToSql(okComposite), /VALUES/);

  // …the same (wallet, chain_id) tuple twice is not — and the key
  // comes from the TRUSTED per-table map, so clearing the archive's
  // own pk ordinals (no pks passed here at all) cannot empty the
  // check (r15).
  const dupComposite = tableFixture(
    'user_thresholds', ['wallet', 'chain_id'],
    [{ wallet: '0xa', chain_id: 8453 }, { wallet: '0xa', chain_id: 8453 }],
  );
  assert.throws(() => tableToSql(dupComposite), /duplicate primary key/);

  // A known table whose schema lacks its trusted key column cannot be
  // verified at all — fatal, not skipped.
  const noKey = tableFixture('telegram_links', ['wallet'], [{ wallet: '0xa' }]);
  assert.throws(() => tableToSql(noKey), /lacks primary-key/);

  // Unknown tables (re-derivable tier) still use the archived
  // ordinals when present.
  const lzDup = tableFixture(
    'lz_alert_state', ['k'],
    [{ k: 1 }, { k: 1 }],
    { k: 1 },
  );
  assert.throws(() => tableToSql(lzDup), /duplicate primary key/);
});

test('planted symlink staging directories are refused (r15)', () => {
  const dir = outDir();
  const elsewhere = outDir();
  // restore/d1 pre-planted as a symlink to another directory: the
  // batches would land outside the staging tree while every printed
  // path claims otherwise.
  symlinkSync(elsewhere, path.join(dir, 'd1'));
  assert.throws(
    () => convertD1({ version: 1, d1: { archive: baselineArchive() } }, dir),
    /symlink/,
  );
  const dir2 = outDir();
  symlinkSync(elsewhere, path.join(dir2, 'r2'));
  assert.throws(
    () =>
      materializeR2(
        { version: 1, d1: {}, r2: { objects: [r2Fixture(Buffer.from('%PDF-1.4 x'))] } },
        dir2,
      ),
    /symlink/,
  );
});

test('decrypted restore material is staged owner-only (r12)', () => {
  const dir = outDir();
  const mode = (p) => statSync(p).mode & 0o777;
  const entries = convertD1({ version: 1, d1: { archive: baselineArchive() } }, dir);
  assert.equal(mode(entries[0].file), 0o600);
  assert.equal(mode(path.dirname(entries[0].file)), 0o700);
  const written = materializeR2(
    { version: 1, d1: {}, r2: { objects: [r2Fixture(Buffer.from('%PDF-1.4 fixture'))] } },
    dir,
  );
  assert.equal(mode(written[0].local), 0o600);
  assert.equal(mode(path.dirname(written[0].local)), 0o700);

  // A REUSED staging tree must be tightened too: creation-time mode
  // options only apply to new inodes (r13) — and reused FILES must be
  // recreated, not written through, since chmod cannot revoke a
  // descriptor another account already holds on the old inode (r14).
  chmodSync(entries[0].file, 0o644);
  chmodSync(path.dirname(entries[0].file), 0o755);
  chmodSync(written[0].local, 0o644);
  chmodSync(path.dirname(written[0].local), 0o755);
  // Model the attack: another account pre-opened the loose files.
  // Holding the fds pins the old inodes, so a genuine recreation MUST
  // land on different inodes — and the held descriptors never see the
  // new plaintext.
  const staleSqlFd = openSync(entries[0].file, 'r');
  const stalePdfFd = openSync(written[0].local, 'r');
  convertD1({ version: 1, d1: { archive: baselineArchive() } }, dir);
  materializeR2(
    { version: 1, d1: {}, r2: { objects: [r2Fixture(Buffer.from('%PDF-1.4 fixture'))] } },
    dir,
  );
  assert.equal(mode(entries[0].file), 0o600);
  assert.equal(mode(path.dirname(entries[0].file)), 0o700);
  assert.equal(mode(written[0].local), 0o600);
  assert.equal(mode(path.dirname(written[0].local)), 0o700);
  assert.notEqual(statSync(entries[0].file).ino, fstatSync(staleSqlFd).ino);
  assert.notEqual(statSync(written[0].local).ino, fstatSync(stalePdfFd).ino);
  closeSync(staleSqlFd);
  closeSync(stalePdfFd);
});

test('an archived schema that omits a live column is rejected (r13)', () => {
  const dir = outDir();
  const tables = baselineArchive();
  const ut = tables.find((t) => t.name === 'user_thresholds');
  // Drop tg_chat_id from schema AND rows — internally consistent, and
  // without the check it converts to valid SQL that silently NULLs
  // every chat id (no more Telegram alerts).
  ut.schema = ut.schema.filter((c) => c.name !== 'tg_chat_id');
  ut.rows = ut.rows.map(({ tg_chat_id: _drop, ...rest }) => rest);
  assert.throws(
    () => convertD1({ version: 1, d1: { archive: tables } }, dir),
    /omits live column\(s\) tg_chat_id/,
  );

  // Extra archived columns are allowed — a newer-era archive must not
  // be rejected by an older converter (import fails loudly if the
  // live schema truly lacks them).
  const extra = baselineArchive();
  const ut2 = extra.find((t) => t.name === 'user_thresholds');
  ut2.schema = [...ut2.schema, { cid: ut2.schema.length, name: 'future_column', type: 'TEXT', notnull: 0, pk: 0 }];
  ut2.rows = ut2.rows.map((r) => ({ ...r, future_column: null }));
  assert.ok(convertD1({ version: 1, d1: { archive: extra } }, dir).length > 0);
});

test('legal rows must match the writer column shapes exactly (r11)', () => {
  const hash = 'a'.repeat(64);
  const admin = `0x${'b'.repeat(40)}`;
  const doc = `legal-holds/${'c'.repeat(64)}.pdf`;
  const holdsWith = (rows) =>
    tableFixture(
      'diag_legal_holds',
      ['wallet_hash', 'legal_doc_ref', 'hold_reason', 'disclosure_allowed', 'disclosure_note'],
      rows,
    );
  const auditWith = (rows) =>
    tableFixture(
      'diag_legal_hold_audit',
      ['id', 'at', 'action', 'wallet_hash', 'admin_wallet', 'legal_doc_ref', 'detail'],
      rows,
    );
  const arch = (holds, audit) => ({ d1: { archive: [holds, audit] } });
  const goodHold = { wallet_hash: hash, legal_doc_ref: doc, hold_reason: 'Court order', disclosure_allowed: 0, disclosure_note: null };
  const goodPlace = { id: 1, at: 100, action: 'place', wallet_hash: hash, admin_wallet: admin, legal_doc_ref: doc, detail: 'Court order' };

  // Canonical rows pass.
  assert.deepEqual(invalidLegalRowShapes(arch(holdsWith([goodHold]), auditWith([goodPlace]))), []);

  // Malformed wallet_hash on BOTH sides still fails — '' and uppercase
  // are restorable TEXT but production would never find the row.
  for (const bad of ['', 'A'.repeat(64), null]) {
    const problems = invalidLegalRowShapes(
      arch(
        holdsWith([{ ...goodHold, wallet_hash: bad }]),
        auditWith([{ ...goodPlace, wallet_hash: bad }]),
      ),
    );
    assert.equal(problems.length, 2, JSON.stringify(bad));
    assert.match(problems[0].problem, /wallet_hash/);
  }

  // admin_wallet attribution cannot be erased or forged.
  for (const bad of ['', '0x' + 'B'.repeat(40), null, 'not-an-address']) {
    const problems = invalidLegalRowShapes(arch(holdsWith([goodHold]), auditWith([{ ...goodPlace, admin_wallet: bad }])));
    assert.match(problems[0].problem, /admin_wallet/, JSON.stringify(bad));
  }

  // disclosure_allowed must be exactly 0/1 — NULL must not pass as 0.
  const nullFlag = invalidLegalRowShapes(arch(holdsWith([{ ...goodHold, disclosure_allowed: null }]), auditWith([goodPlace])));
  assert.match(nullFlag[0].problem, /disclosure_allowed/);

  // A gutted HISTORICAL placement is caught even when a later,
  // well-formed placement is the latest action.
  const guttedHistory = invalidLegalRowShapes(
    arch(
      holdsWith([goodHold]),
      auditWith([
        { ...goodPlace, id: 1, at: 100, detail: '' },
        { ...goodPlace, id: 2, at: 200, detail: 'Court order' },
      ]),
    ),
  );
  assert.equal(guttedHistory.length, 1);
  assert.match(guttedHistory[0].problem, /legal basis/);

  // hold_reason on the register itself must be non-empty too.
  const guttedReason = invalidLegalRowShapes(arch(holdsWith([{ ...goodHold, hold_reason: '' }]), auditWith([goodPlace])));
  assert.match(guttedReason[0].problem, /hold_reason/);
});

test('re-derivable batches carry the skip-by-default tier, never the apply tier', () => {
  const dir = outDir();
  const entries = convertD1(
    {
      version: 1,
      d1: { archive: [...baselineArchive(), tableFixture('offers', ['id'], [{ id: 1 }])] },
    },
    dir,
  );
  const offers = entries.find((e) => e.name === 'offers');
  assert.equal(offers.tier, 're-derivable');
  assert.ok(entries.filter((e) => e.tier === 'born-off-chain').length >= 6);
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
  ]);
  // null/null is legitimate ONLY for non-`place` audit actions.
  const audit = tableFixture(
    'diag_legal_hold_audit',
    ['id', 'action', 'legal_doc_ref', 'legal_doc_sha256'],
    [{ id: 1, action: 'lift', legal_doc_ref: null, legal_doc_sha256: null }],
  );
  const ok = { d1: { archive: [holds, audit] }, r2: { objects: [doc] } };
  assert.deepEqual(invalidLegalDocRefs(ok), []);

  // …but a current HOLD with neither field, or a `place` audit row
  // with neither, recreates a hold with no authorizing evidence.
  const bareHold = tableFixture('diag_legal_holds', ['id', 'legal_doc_ref', 'legal_doc_sha256'], [
    { id: 9, legal_doc_ref: null, legal_doc_sha256: null },
  ]);
  assert.match(
    invalidLegalDocRefs({ d1: { archive: [bareHold] }, r2: { objects: [] } })[0].problem,
    /no authorizing document/,
  );
  const barePlace = tableFixture(
    'diag_legal_hold_audit',
    ['id', 'action', 'legal_doc_ref', 'legal_doc_sha256'],
    [{ id: 9, action: 'place', legal_doc_ref: null, legal_doc_sha256: null }],
  );
  assert.match(
    invalidLegalDocRefs({ d1: { archive: [barePlace] }, r2: { objects: [] } })[0].problem,
    /'place' with no authorizing document/,
  );

  // The doc-less allowance is an exact-string domain: a relabelled
  // action must not fall through it.
  for (const action of ['PLACE', 'delete', null]) {
    const relabelled = tableFixture(
      'diag_legal_hold_audit',
      ['id', 'action', 'legal_doc_ref', 'legal_doc_sha256'],
      [{ id: 9, action, legal_doc_ref: null, legal_doc_sha256: null }],
    );
    assert.match(
      invalidLegalDocRefs({ d1: { archive: [relabelled] }, r2: { objects: [] } })[0].problem,
      /domain/,
      String(action),
    );
  }

  // Domain enforcement is document-INDEPENDENT (r8): an unknown
  // action carrying a perfectly valid document pair is still an
  // impossible record — the production parser admits three strings.
  const relabelledWithDoc = tableFixture(
    'diag_legal_hold_audit',
    ['id', 'action', 'legal_doc_ref', 'legal_doc_sha256'],
    [{ id: 9, action: 'unhold', legal_doc_ref: doc.key, legal_doc_sha256: docHash }],
  );
  assert.match(
    invalidLegalDocRefs({ d1: { archive: [relabelledWithDoc] }, r2: { objects: [doc] } })[0].problem,
    /domain/,
  );

  const gone = `legal-holds/${'b'.repeat(64)}.pdf`;
  holds.rows.push(
    { id: 3, legal_doc_ref: gone, legal_doc_sha256: null },        // absent from archive
    { id: 4, legal_doc_ref: '', legal_doc_sha256: null },          // empty ref = tampering shape
    { id: 5, legal_doc_ref: doc.key, legal_doc_sha256: 'f'.repeat(64) }, // sha disagrees with key
    { id: 6, legal_doc_ref: doc.key, legal_doc_sha256: null },     // ref without its sha
    { id: 7, legal_doc_ref: null, legal_doc_sha256: docHash },     // sha without its ref
  );
  holds.rowCount = 7;
  const problems = invalidLegalDocRefs({ d1: { archive: [holds] }, r2: { objects: [doc] } });
  assert.equal(problems.length, 5);
  assert.match(problems[0].problem, /absent/);
  assert.match(problems[1].problem, /not a canonical/);
  assert.match(problems[2].problem, /disagrees/);
  assert.match(problems[3].problem, /sha is null/);
  assert.match(problems[4].problem, /ref is null/);
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
