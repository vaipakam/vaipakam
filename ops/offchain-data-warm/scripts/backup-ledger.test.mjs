/**
 * node:test suite for the backup watcher (#1469, #1473).
 *
 * Two layers. The rules in `lib/ledger-rules.mjs` are pinned one by one, each
 * problem the watcher pages on with a case that raises it and a case that
 * must not. Then whole runs of `runWatcher` go against an in-memory B2 that
 * keeps versions, hide markers, file info and compliance retention the way
 * the real one does, so the run's own writes are read back through the same
 * listing a later run would see.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { isBackblazeHost, requireScope } from './lib/b2-native.mjs';
import {
  ENTRY_RETENTION_DAYS,
  LEGACY_FORMAT,
  MANIFEST_GRACE_MS,
  YEARLY_RETENTION_DAYS,
  entryName,
  isLegacyJanuaryPair,
  judge,
  manifestCheck,
  parseAcknowledged,
  parseArchiveName,
  parseEntryName,
  parseManifestName,
  readArchiveBucket,
  readLedger,
  renewalsDue,
  retentionFor,
  safeKey,
} from './lib/ledger-rules.mjs';
import { ARCHIVE_KEY_SCOPE, LEDGER_KEY_SCOPE, runWatcher } from './backup-ledger.mjs';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 28, 4, 17); // 2026-10-28 04:17 UTC
const N1 = 'a'.repeat(32);
const N2 = 'b'.repeat(32);
const N3 = 'c'.repeat(32);
const sha = (s) => createHash('sha256').update(s).digest('hex');
const LIFECYCLE = {
  bucket: 'vaipakam-offchain-data-warm',
  rules: [
    { fileNamePrefix: 'archives/', daysFromUploadingToHiding: 20, daysFromHidingToDeleting: 9 },
    { fileNamePrefix: 'archives-monthly/', daysFromUploadingToHiding: 334, daysFromHidingToDeleting: 31 },
  ],
};

// ── Names ───────────────────────────────────────────────────────────────

test('archive and manifest names parse into their pair, and nothing else does', () => {
  const a = parseArchiveName(`archives-monthly/2026-01/${N1}.bin`);
  assert.equal(a.tier, 'monthly');
  assert.equal(a.period, '2026-01');
  assert.equal(a.manifestName, `manifests-monthly/2026-01/${N1}.json`);
  assert.equal(parseManifestName(a.manifestName).archiveName, `archives-monthly/2026-01/${N1}.bin`);
  assert.equal(parseArchiveName(`archives/2026-10-27/${N1}.bin`).tier, 'daily');
  assert.equal(parseArchiveName(`archives-yearly/2026/${N1}.bin`).tier, 'yearly');
  for (const bad of [
    `archives/2026-02-30/${N1}.bin`, // no such day
    `archives/2026-10-27/${N1.slice(1)}.bin`, // short nonce
    `archives/2026-10-27/${N1}.json`,
    `archives/2026-10-27/x/${N1}.bin`,
    `other/2026-10-27/${N1}.bin`,
  ]) {
    assert.equal(parseArchiveName(bad), null, bad);
  }
});

test('entry names round-trip, and a name the watcher never writes does not parse', () => {
  const name = entryName('daily', '2026-10-27', '4_zabc_f1');
  assert.equal(name, 'entries/daily/2026-10-27/4_zabc_f1.json');
  assert.deepEqual(parseEntryName(name), { tier: 'daily', period: '2026-10-27', fileId: '4_zabc_f1' });
  assert.equal(parseEntryName('entries/weekly/2026-10-27/x.json'), null);
  assert.equal(parseEntryName('entries/daily/2026-13-01/x.json'), null);
  assert.equal(parseEntryName('notes.txt'), null);
});

// ── Manifest check ──────────────────────────────────────────────────────

test('the manifest check compares the computed digest, never trusts the manifest', () => {
  const bytes = Buffer.from('ciphertext');
  const archive = { sha256: sha(bytes), length: bytes.length };
  const manifest = (a) => ({ bytes: Buffer.from(JSON.stringify({ archive: a })) });
  const good = { sha256: archive.sha256, byteLength: archive.length, encryption: 'AES-256-GCM' };
  assert.deepEqual(manifestCheck(archive, [manifest(good)]), { check: 'match', format: LEGACY_FORMAT, declared: good });
  assert.equal(manifestCheck(archive, [manifest({ ...good, sha256: sha('other') })]).check, 'sha-mismatch');
  assert.equal(manifestCheck(archive, [manifest({ ...good, byteLength: 3 })]).check, 'length-mismatch');
  assert.equal(manifestCheck(archive, []).check, 'no-manifest');
  assert.equal(manifestCheck(archive, [{ bytes: Buffer.from('{') }]).check, 'bad-manifest');
  assert.equal(manifestCheck(archive, [manifest({ sha256: archive.sha256 })]).check, 'bad-manifest');
  assert.equal(manifestCheck(archive, [manifest(good), manifest(good)]).check, 'ambiguous-manifest');
  assert.equal(manifestCheck(archive, [manifest({ ...good, encryption: 'other' })]).format, 'unknown');
});

// ── Ledger reading ──────────────────────────────────────────────────────

let seq = 0;
function entryVersion({ tier = 'daily', period = '2026-10-27', fileId = 'F1', uploaded = NOW - DAY, sha256 = sha('x'), nonce = N1, check = 'match', format = LEGACY_FORMAT, at = NOW - DAY + 3_600_000, retention } = {}) {
  return {
    action: 'upload',
    fileName: entryName(tier, period, fileId),
    fileId: `E${++seq}`,
    uploadTimestamp: at,
    fileInfo: { tier, period, nonce, sha256, length: '10', uploaded: String(uploaded), check, format, manifests: 'M1' },
    fileRetention: retention ?? { isClientAuthorizedToRead: true, value: { mode: 'compliance', retainUntilTimestamp: retentionFor(tier, at) } },
  };
}

test('a clean entry is recorded under the archive file id', () => {
  const { recorded, tampered } = readLedger([entryVersion()]);
  assert.deepEqual(tampered, []);
  assert.equal(recorded.get('F1').sha256, sha('x'));
  assert.equal(recorded.get('F1').uploaded, NOW - DAY);
});

test('every way to add to the ledger is read as tampering, and the oldest version stays the record', () => {
  const first = entryVersion({ sha256: sha('genuine'), at: NOW - 2 * DAY });
  const second = { ...entryVersion({ sha256: sha('forged'), at: NOW - DAY }), fileName: first.fileName };
  const two = readLedger([second, first]);
  assert.match(two.tampered[0].why, /2 versions/);
  assert.equal(two.recorded.get('F1').sha256, sha('genuine'));

  const hidden = readLedger([first, { action: 'hide', fileName: first.fileName, fileId: 'H', uploadTimestamp: NOW }]);
  assert.match(hidden.tampered[0].why, /hide marker/);

  const governance = readLedger([entryVersion({ retention: { isClientAuthorizedToRead: true, value: { mode: 'governance', retainUntilTimestamp: NOW + 500 * DAY } } })]);
  assert.match(governance.tampered[0].why, /retention governance/);

  const short = readLedger([entryVersion({ retention: { isClientAuthorizedToRead: true, value: { mode: 'compliance', retainUntilTimestamp: NOW + 30 * DAY } } })]);
  assert.match(short.tampered[0].why, /retention compliance/);

  const foreign = readLedger([{ ...entryVersion(), fileName: 'entries/notes.txt' }]);
  assert.match(foreign.tampered[0].why, /never writes/);

  const badInfo = readLedger([{ ...entryVersion(), fileInfo: { tier: 'daily' } }]);
  assert.match(badInfo.tampered[0].why, /file info/);
});

test('a ledger key that cannot read retentions stops the run rather than passing it', () => {
  assert.throws(() => readLedger([entryVersion({ retention: { isClientAuthorizedToRead: false } })]), /readFileRetentions/);
});

// ── Judging ─────────────────────────────────────────────────────────────

function archive(tier, period, nonce, fileId, uploadTimestamp) {
  const spec = { daily: ['archives/', 'manifests/'], monthly: ['archives-monthly/', 'manifests-monthly/'], yearly: ['archives-yearly/', 'manifests-yearly/'] }[tier];
  return [
    { action: 'upload', fileName: `${spec[0]}${period}/${nonce}.bin`, fileId, uploadTimestamp },
    { action: 'upload', fileName: `${spec[1]}${period}/${nonce}.json`, fileId: `${fileId}m`, uploadTimestamp: uploadTimestamp + 1000 },
  ];
}

function rec(fileId, over = {}) {
  return { tier: 'daily', period: '2026-10-27', nonce: N1, sha256: sha(fileId), length: 10, uploaded: NOW - DAY, check: 'match', format: LEGACY_FORMAT, fileId, manifests: `${fileId}m`, retainUntil: NOW + 399 * DAY, ...over };
}

// The monthly the October cut wrote, present in every scene that is not about
// the monthly tier: without it the monthly tier is missing, as it should be.
const OCTOBER = archive('monthly', '2026-10', N3, 'M10', Date.UTC(2026, 9, 1, 3));

function scene({ archives = [], recorded = [], tampered = [], baseline = {}, monthly = [OCTOBER], ...rest } = {}) {
  const bucket = readArchiveBucket([...archives, ...monthly].flat());
  const ledger = { recorded: new Map(recorded.map((r) => [r.fileId, r])), tampered };
  return { result: judge({ now: NOW, ledger, bucket, lifecycle: LIFECYCLE, baseline, ...rest }), bucket, ledger };
}

const keysOf = (r) => r.problems.flatMap((p) => p.keys).sort();

test('a healthy daily tier with every archive recorded raises nothing', () => {
  const { result } = scene({ archives: [archive('daily', '2026-10-27', N1, 'A1', NOW - DAY)], recorded: [rec('A1')] });
  assert.deepEqual(keysOf(result), []);
});

test('missing: a daily outage is one lasting condition; a missing month is its own key', () => {
  const daily = scene({ archives: [archive('daily', '2026-10-20', N1, 'A1', NOW - 8 * DAY)] }).result;
  assert.deepEqual(keysOf(daily), ['missing:daily']);

  const monthly = scene({
    archives: [archive('daily', '2026-10-27', N1, 'A1', NOW - DAY)],
    monthly: [archive('monthly', '2026-08', N2, 'M8', NOW - 80 * DAY), OCTOBER],
  }).result;
  assert.deepEqual(keysOf(monthly), ['missing:monthly:2026-09']);
});

test('ambiguous: two archives in one period page, whoever recorded them', () => {
  const { result } = scene({ archives: [archive('daily', '2026-10-27', N1, 'A1', NOW - DAY), archive('daily', '2026-10-27', N2, 'A2', NOW - DAY)] });
  assert.deepEqual(keysOf(result), ['ambiguous:daily:2026-10-27']);
});

test('replay: equal bytes in another period page, except the legacy January pair', () => {
  const copied = scene({
    archives: [archive('daily', '2026-10-26', N1, 'A1', NOW - 2 * DAY), archive('daily', '2026-10-27', N2, 'A2', NOW - DAY)],
    recorded: [rec('A1', { period: '2026-10-26', uploaded: NOW - 2 * DAY, sha256: sha('same') }), rec('A2', { nonce: N2, sha256: sha('same') })],
  }).result;
  assert.deepEqual(keysOf(copied), ['replay:A2']);

  const jan = { tier: 'monthly', period: '2026-01', nonce: N1, format: LEGACY_FORMAT };
  const year = { tier: 'yearly', period: '2026', nonce: N1, format: LEGACY_FORMAT };
  assert.equal(isLegacyJanuaryPair(jan, year), true);
  assert.equal(isLegacyJanuaryPair(year, jan), true);
  assert.equal(isLegacyJanuaryPair({ ...jan, period: '2026-02' }, year), false);
  assert.equal(isLegacyJanuaryPair({ ...jan, nonce: N2 }, year), false);
  assert.equal(isLegacyJanuaryPair({ ...jan, format: 'unknown' }, year), false);
});

test('mismatch: a recorded archive whose bytes disagree with its manifest pages', () => {
  const { result } = scene({ archives: [archive('daily', '2026-10-27', N1, 'A1', NOW - DAY)], recorded: [rec('A1', { check: 'sha-mismatch' })] });
  assert.deepEqual(keysOf(result), ['mismatch:A1']);
});

test('deleted early: gone before its lifecycle pages; gone after does not; a yearly never ages out', () => {
  const live = archive('daily', '2026-10-27', N1, 'A1', NOW - DAY);
  const early = scene({ archives: [live], recorded: [rec('A1'), rec('G1', { period: '2026-10-23', uploaded: NOW - 5 * DAY })] }).result;
  assert.deepEqual(keysOf(early), ['deleted-early:G1']);
  const aged = scene({ archives: [live], recorded: [rec('A1'), rec('G2', { period: '2026-09-01', uploaded: NOW - 40 * DAY })] }).result;
  assert.deepEqual(keysOf(aged), []);
  const yearly = scene({ archives: [live], recorded: [rec('A1'), rec('Y1', { tier: 'yearly', period: '2024', uploaded: NOW - 700 * DAY })] }).result;
  assert.ok(keysOf(yearly).includes('deleted-early:Y1'));
});

test('deleted early counts the second lifecycle term from a supersession, which itself pages', () => {
  const live = archive('daily', '2026-10-27', N1, 'A1', NOW - DAY);
  const name = `archives/2026-10-17/${N2}.bin`;
  const overwrite = { action: 'upload', fileName: name, fileId: 'O1', uploadTimestamp: NOW - 10 * DAY };
  // Uploaded 11 days ago, superseded a day later, gone now: the lifecycle
  // deletes a superseded version 9 days after, so this is not early.
  const superseded = scene({ archives: [live, [overwrite]], recorded: [rec('A1'), rec('G1', { period: '2026-10-17', nonce: N2, uploaded: NOW - 11 * DAY })] }).result;
  assert.ok(!keysOf(superseded).includes('deleted-early:G1'), keysOf(superseded).join());
  // The same archive gone with no sign it was ever superseded is early.
  const plain = scene({ archives: [live], recorded: [rec('A1'), rec('G1', { period: '2026-10-17', nonce: N2, uploaded: NOW - 11 * DAY })] }).result;
  assert.ok(keysOf(plain).includes('deleted-early:G1'));
});

test('hidden early: a hide marker before the age rule pages; the lifecycle\'s own hide does not', () => {
  const name = `archives/2026-10-20/${N2}.bin`;
  const a = archive('daily', '2026-10-20', N2, 'A2', NOW - 8 * DAY);
  const hide = (t) => [{ action: 'hide', fileName: name, fileId: 'H1', uploadTimestamp: t }];
  const early = scene({ archives: [archive('daily', '2026-10-27', N1, 'A1', NOW - DAY), a, hide(NOW - 2 * DAY)] }).result;
  assert.ok(keysOf(early).includes('hidden-early:A2'), keysOf(early).join());
  const old = archive('daily', '2026-09-30', N3, 'A3', NOW - 28 * DAY);
  const aged = scene({ archives: [archive('daily', '2026-10-27', N1, 'A1', NOW - DAY), old, [{ action: 'hide', fileName: `archives/2026-09-30/${N3}.bin`, fileId: 'H2', uploadTimestamp: NOW - 7 * DAY }]] }).result;
  assert.ok(!keysOf(aged).some((k) => k.startsWith('hidden-early')), keysOf(aged).join());
});

test('a manifest re-check overrides the recorded verdict', () => {
  const { result } = scene({ archives: [archive('daily', '2026-10-27', N1, 'A1', NOW - DAY)], recorded: [rec('A1')], manifestRechecks: new Map([['A1', 'sha-mismatch']]) });
  assert.deepEqual(keysOf(result), ['mismatch:A1']);
  assert.match(result.problems[0].text, /manifest changed/);
});

test('renewal: a yearly entry still short of a year is due and, once overdue, pages', () => {
  const archives = [archive('daily', '2026-10-27', N1, 'A1', NOW - DAY), archive('yearly', '2026', N2, 'Y1', NOW - 300 * DAY)];
  const yearly = rec('Y1', { tier: 'yearly', period: '2026', nonce: N2, uploaded: NOW - 300 * DAY, retainUntil: NOW + 100 * DAY });
  const { result, bucket, ledger } = scene({ archives, recorded: [rec('A1'), yearly], baseline: { yearly: '2026' } });
  assert.deepEqual(keysOf(result), ['renewal-failed:Y1']);
  assert.deepEqual(renewalsDue({ now: NOW, ledger, bucket }).map((r) => r.fileId), ['Y1']);

  const fresh = scene({ archives, recorded: [rec('A1'), { ...yearly, retainUntil: NOW + YEARLY_RETENTION_DAYS * DAY }], baseline: { yearly: '2026' } });
  assert.deepEqual(keysOf(fresh.result), []);
  assert.deepEqual(renewalsDue({ now: NOW, ledger: fresh.ledger, bucket: fresh.bucket }), []);

  const refused = scene({ archives, recorded: [rec('A1'), { ...yearly, retainUntil: NOW + 364.5 * DAY }], baseline: { yearly: '2026' }, renewalFailures: [{ fileId: 'Y1', period: '2026', error: 'b2 said no' }] });
  assert.deepEqual(keysOf(refused.result), ['renewal-failed:Y1']);
});

test('ledger tampering and an invalid baseline each page under their own key', () => {
  const { result } = scene({
    archives: [archive('daily', '2026-10-27', N1, 'A1', NOW - DAY)],
    recorded: [rec('A1')],
    tampered: [{ name: 'entries/daily/2026-10-27/A1.json', why: '2 versions' }],
    baselineErrors: { monthly: 'ARCHIVE_FIRST_MONTHLY="2026-13" is not a valid monthly period' },
  });
  assert.deepEqual(keysOf(result), ['baseline:monthly', 'ledger-tampered:entries/daily/2026-10-27/A1.json']);
});

test('an entry that does not describe the archive it names is tampering', () => {
  const live = archive('daily', '2026-10-27', N1, 'A1', NOW - DAY);
  for (const wrong of [{ period: '2026-10-26' }, { nonce: N2 }, { uploaded: NOW - 2 * DAY }]) {
    const { result } = scene({ archives: [live], recorded: [rec('A1', wrong)] });
    assert.ok(keysOf(result).some((k) => k.startsWith('ledger-tampered:')), JSON.stringify(wrong));
  }
});

test('a key carries only the characters the alert issue can record', () => {
  assert.equal(safeKey('ledger-tampered:entries/x y,-->z'), 'ledger-tampered:entries/x?y?--?z');
  assert.deepEqual([...parseAcknowledged(' a , ,b')], ['a', 'b']);
});

// ── Key scope ───────────────────────────────────────────────────────────

test('a key with more authority than the job, or less, or a wider scope, is refused', () => {
  const ok = { capabilities: ['listFiles', 'readFiles'], bucketId: 'B', bucketName: 'warm', namePrefix: null };
  assert.equal(requireScope(ok, { ...ARCHIVE_KEY_SCOPE, bucket: 'warm' }), 'B');
  assert.throws(() => requireScope({ ...ok, capabilities: [...ok.capabilities, 'deleteFiles'] }, { ...ARCHIVE_KEY_SCOPE, bucket: 'warm' }), /must not have: deleteFiles/);
  assert.throws(() => requireScope({ ...ok, capabilities: ['listFiles'] }, { ...ARCHIVE_KEY_SCOPE, bucket: 'warm' }), /missing required/);
  assert.throws(() => requireScope({ ...ok, bucketId: null }, { ...ARCHIVE_KEY_SCOPE, bucket: 'warm' }), /not confined/);
  assert.throws(() => requireScope(ok, { ...ARCHIVE_KEY_SCOPE, bucket: 'other' }), /scoped to warm/);
  assert.throws(() => requireScope({ ...ok, namePrefix: 'archives/' }, { ...ARCHIVE_KEY_SCOPE, bucket: 'warm' }), /name prefix/);
  const ledger = { ...ok, capabilities: [...LEDGER_KEY_SCOPE.required, 'bypassGovernance'] };
  assert.throws(() => requireScope(ledger, { ...LEDGER_KEY_SCOPE, bucket: 'warm' }), /bypassGovernance/);
});

test('only Backblaze hosts over https are called', () => {
  assert.equal(isBackblazeHost('https://api005.backblazeb2.com'), true);
  assert.equal(isBackblazeHost('https://f005.backblazeb2.com/file'), true);
  assert.equal(isBackblazeHost('https://pod-000-1005-03.backblaze.com/b2api/v3/b2_upload_file/x'), true);
  assert.equal(isBackblazeHost('https://evilbackblaze.com'), false);
  assert.equal(isBackblazeHost('https://pod.backblaze.com:8443'), false);
  assert.equal(isBackblazeHost('http://api005.backblazeb2.com'), false);
  assert.equal(isBackblazeHost('https://backblazeb2.com.evil.example'), false);
  assert.equal(isBackblazeHost('not a url'), false);
});

// ── Whole runs, against an in-memory B2 ─────────────────────────────────

/**
 * Enough of B2's native API for the watcher: authorize, versioned listing
 * with (name, id) paging, download by id, upload with file info and a
 * compliance retention (refused on a bucket without Object Lock), and a
 * retention update that may only lengthen.
 */
function fakeB2({ pageSize = 2 } = {}) {
  const buckets = new Map();
  const keys = new Map();
  let ids = 0;
  let clock = NOW - 10 * DAY;
  const api = 'https://api005.backblazeb2.com';
  const dl = 'https://f005.backblazeb2.com';
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const keyOf = (auth) => keys.get(auth);

  const b2 = {
    bucket(name, { lock = false } = {}) {
      buckets.set(name, { id: `bkt-${name}`, name, lock, versions: [], bytes: new Map() });
      return b2;
    },
    key(id, { bucket, capabilities, namePrefix = null }) {
      keys.set(id, { id, bucket, capabilities, namePrefix });
      return b2;
    },
    put(bucketName, fileName, body, at) {
      const b = buckets.get(bucketName);
      const fileId = `4_z${b.id}_f${++ids}`;
      b.versions.push({ action: 'upload', fileName, fileId, uploadTimestamp: at ?? (clock += 1000), fileInfo: {}, fileRetention: null });
      b.bytes.set(fileId, Buffer.from(body));
      return fileId;
    },
    hide(bucketName, fileName) {
      buckets.get(bucketName).versions.push({ action: 'hide', fileName, fileId: `4_zh${++ids}`, uploadTimestamp: (clock += 1000), fileInfo: {} });
    },
    remove(bucketName, match) {
      const b = buckets.get(bucketName);
      b.versions = b.versions.filter((v) => !match(v));
    },
    versions(bucketName) {
      return buckets.get(bucketName).versions;
    },
    async fetch(url, init = {}) {
      const u = new URL(url);
      if (u.pathname.endsWith('/b2_authorize_account')) {
        const [id] = Buffer.from(init.headers.Authorization.slice(6), 'base64').toString().split(':');
        const k = keys.get(id);
        if (!k) return json({ message: 'bad key' }, 401);
        const b = buckets.get(k.bucket);
        return json({
          accountId: 'acct',
          authorizationToken: id,
          apiInfo: { storageApi: { apiUrl: api, downloadUrl: dl, capabilities: k.capabilities, bucketId: b.id, bucketName: b.name, namePrefix: k.namePrefix } },
        });
      }
      const k = keyOf(init.headers?.Authorization) ?? null;
      const b = k && buckets.get(k.bucket);
      if (u.pathname.endsWith('/b2_list_file_versions')) {
        const body = JSON.parse(init.body);
        const sorted = b.versions
          .filter((v) => v.fileName.startsWith(body.prefix))
          .sort((x, y) => (x.fileName < y.fileName ? -1 : x.fileName > y.fileName ? 1 : y.uploadTimestamp - x.uploadTimestamp));
        let start = 0;
        if (body.startFileName) start = sorted.findIndex((v) => v.fileName === body.startFileName && (!body.startFileId || v.fileId === body.startFileId));
        const page = sorted.slice(start, start + pageSize);
        const next = sorted[start + pageSize];
        const canRead = k.capabilities.includes('readFileRetentions');
        return json({
          files: page.map((v) => ({ ...v, fileRetention: { isClientAuthorizedToRead: canRead, value: canRead ? v.fileRetention : null } })),
          nextFileName: next?.fileName ?? null,
          nextFileId: next?.fileId ?? null,
        });
      }
      if (u.pathname.endsWith('/b2_download_file_by_id')) {
        const bytes = b.bytes.get(u.searchParams.get('fileId'));
        return bytes ? new Response(bytes) : json({ message: 'not found' }, 404);
      }
      if (u.pathname.endsWith('/b2_get_upload_url')) {
        // B2 hands out upload URLs on its pod hosts, under backblaze.com.
        return json({ uploadUrl: `https://pod-000-1005-03.backblaze.com/upload/${b.name}`, authorizationToken: k.id });
      }
      if (u.pathname.startsWith('/upload/')) {
        if (!k.capabilities.includes('writeFiles')) return json({ message: 'unauthorized' }, 401);
        if (init.headers['X-Bz-File-Retention-Mode'] && !b.lock) return json({ message: 'file lock is not enabled' }, 400);
        const fileInfo = {};
        for (const [h, v] of Object.entries(init.headers)) if (h.startsWith('X-Bz-Info-')) fileInfo[h.slice(10)] = decodeURIComponent(v);
        const fileId = `4_z${b.id}_f${++ids}`;
        b.versions.push({
          action: 'upload',
          fileName: decodeURIComponent(init.headers['X-Bz-File-Name']),
          fileId,
          uploadTimestamp: NOW,
          fileInfo,
          fileRetention: { mode: init.headers['X-Bz-File-Retention-Mode'], retainUntilTimestamp: Number(init.headers['X-Bz-File-Retention-Retain-Until-Timestamp']) },
        });
        b.bytes.set(fileId, Buffer.from(init.body));
        return json({ fileId });
      }
      if (u.pathname.endsWith('/b2_update_file_retention')) {
        const body = JSON.parse(init.body);
        const v = b.versions.find((x) => x.fileId === body.fileId);
        if (body.fileRetention.retainUntilTimestamp < v.fileRetention.retainUntilTimestamp) return json({ message: 'cannot shorten' }, 403);
        v.fileRetention = { ...body.fileRetention };
        return json({ fileId: v.fileId });
      }
      return json({ message: `unhandled ${u.pathname}` }, 500);
    },
  };
  return b2;
}

const ENV = {
  B2_ARCHIVE_READ_KEY_ID: 'reader',
  B2_ARCHIVE_READ_KEY: 'secret',
  B2_LEDGER_KEY_ID: 'ledger',
  B2_LEDGER_KEY: 'secret',
};

function world({ lock = true } = {}) {
  const b2 = fakeB2()
    .bucket('vaipakam-offchain-data-warm')
    .bucket('vaipakam-offchain-backup-ledger', { lock })
    .key('reader', { bucket: 'vaipakam-offchain-data-warm', capabilities: ['listBuckets', 'listFiles', 'readFiles'] })
    .key('ledger', { bucket: 'vaipakam-offchain-backup-ledger', capabilities: ['listFiles', 'readFiles', 'writeFiles', 'readFileRetentions', 'writeFileRetentions'] });
  // The October monthly cut, so only the tier a test is about can be missing.
  nightly(b2, 'monthly', '2026-10', 'f'.repeat(32), 'october', Date.UTC(2026, 9, 1, 3));
  return b2;
}

const dailyEntries = (b2) => b2.versions('vaipakam-offchain-backup-ledger').filter((v) => v.fileName.startsWith('entries/daily/'));

function nightly(b2, tier, period, nonce, body, at, { manifest = true, declared } = {}) {
  const [ap, mp] = { daily: ['archives/', 'manifests/'], monthly: ['archives-monthly/', 'manifests-monthly/'], yearly: ['archives-yearly/', 'manifests-yearly/'] }[tier];
  const fileId = b2.put('vaipakam-offchain-data-warm', `${ap}${period}/${nonce}.bin`, body, at);
  if (manifest) {
    const archiveFacts = declared ?? { sha256: sha(body), byteLength: Buffer.byteLength(body), encryption: 'AES-256-GCM' };
    b2.put('vaipakam-offchain-data-warm', `${mp}${period}/${nonce}.json`, JSON.stringify({ archive: archiveFacts }), at + 1000);
  }
  return fileId;
}

const run = (b2, over = {}) => runWatcher({ env: { ...ENV, ...over.env }, now: over.now ?? NOW, fetchImpl: b2.fetch, dryRun: over.dryRun ?? false });

test('a run records every archive once, locked in compliance mode, and a second run writes nothing', async () => {
  const b2 = world();
  const id = nightly(b2, 'daily', '2026-10-27', N1, 'night', NOW - DAY);
  const first = await run(b2);
  assert.deepEqual(first.live, []);
  assert.equal(first.written.length, 2);

  const entries = dailyEntries(b2);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].fileName, `entries/daily/2026-10-27/${id}.json`);
  assert.equal(entries[0].fileRetention.mode, 'compliance');
  assert.equal(entries[0].fileRetention.retainUntilTimestamp, NOW + ENTRY_RETENTION_DAYS * DAY);
  assert.equal(entries[0].fileInfo.sha256, sha('night'));
  assert.equal(entries[0].fileInfo.check, 'match');
  const body = JSON.parse(Buffer.from(await (await b2.fetch(`https://f005.backblazeb2.com/b2api/v3/b2_download_file_by_id?fileId=${entries[0].fileId}`, { headers: { Authorization: 'ledger' } })).arrayBuffer()).toString());
  assert.equal(body.discovery, 'before-ledger');
  assert.equal(body.archive.sha256, sha('night'));

  const second = await run(b2);
  assert.deepEqual(second.live, []);
  assert.equal(second.written.length, 0);
  assert.equal(b2.versions('vaipakam-offchain-backup-ledger').length, 2);
});

test('the summary never names an archive', async () => {
  const b2 = world();
  nightly(b2, 'daily', '2026-10-27', N1, 'night', NOW - DAY);
  nightly(b2, 'daily', '2026-10-26', N2, 'night', NOW - 2 * DAY); // a replay, so problems print too
  const r = await run(b2);
  assert.ok(r.live.length > 0);
  const printed = r.summary + r.live.map((p) => p.text + p.keys.join(',')).join('');
  assert.ok(!printed.includes(N1) && !printed.includes(N2), printed);
});

test('a forged archive is caught: a second archive in a period, a copy in a new one, a mismatch', async () => {
  const b2 = world();
  nightly(b2, 'daily', '2026-10-26', N1, 'genuine-26', NOW - 2 * DAY);
  await run(b2);
  nightly(b2, 'daily', '2026-10-26', N2, 'forged-26', NOW - DAY);
  const copy = nightly(b2, 'daily', '2026-10-27', N3, 'genuine-26', NOW - DAY + 5000);
  const r = await run(b2);
  const keys = r.live.flatMap((p) => p.keys);
  assert.ok(keys.includes('ambiguous:daily:2026-10-26'), keys.join());
  assert.ok(keys.includes(`replay:${copy}`), keys.join());

  const b3 = world();
  const bad = nightly(b3, 'daily', '2026-10-27', N1, 'night', NOW - DAY, { declared: { sha256: sha('other'), byteLength: 5, encryption: 'AES-256-GCM' } });
  assert.deepEqual((await run(b3)).live.flatMap((p) => p.keys), [`mismatch:${bad}`]);
});

test('an archive deleted before its lifecycle is reported, from the ledger alone', async () => {
  const b2 = world();
  nightly(b2, 'daily', '2026-10-27', N1, 'night-27', NOW - DAY);
  const gone = nightly(b2, 'daily', '2026-10-25', N2, 'night-25', NOW - 3 * DAY);
  await run(b2);
  // The archive and its manifest both gone: the tier rule sees nothing
  // missing, because 10-27 still satisfies it; only the ledger knows.
  b2.remove('vaipakam-offchain-data-warm', (v) => v.fileName.includes('/2026-10-25/'));
  const keys = (await run(b2)).live.flatMap((p) => p.keys);
  assert.deepEqual(keys, [`deleted-early:${gone}`]);
});

test('an archive whose manifest has not landed waits, then is recorded as having none', async () => {
  const b2 = world();
  nightly(b2, 'daily', '2026-10-26', N1, 'night-26', NOW - 2 * DAY);
  const id = nightly(b2, 'daily', '2026-10-27', N2, 'night-27', NOW - 600_000, { manifest: false });
  const waiting = await run(b2);
  assert.deepEqual(waiting.live, []);
  assert.deepEqual(waiting.deferred.map((d) => d.fileId), [id]);
  const later = await run(b2, { now: NOW - 600_000 + MANIFEST_GRACE_MS + 1 });
  assert.deepEqual(later.live.flatMap((p) => p.keys), [`mismatch:${id}`]);
});

test('a manifest replaced after its archive was recorded is checked again', async () => {
  const b2 = world();
  const id = nightly(b2, 'daily', '2026-10-27', N1, 'night', NOW - DAY);
  assert.deepEqual((await run(b2)).live, []);
  // A write key replaces the manifest; the original is then lifecycle-deleted.
  const manifest = `manifests/2026-10-27/${N1}.json`;
  b2.remove('vaipakam-offchain-data-warm', (v) => v.fileName === manifest);
  b2.put('vaipakam-offchain-data-warm', manifest, JSON.stringify({ archive: { sha256: sha('other'), byteLength: 5, encryption: 'AES-256-GCM' } }));
  assert.deepEqual((await run(b2)).live.flatMap((p) => p.keys), [`mismatch:${id}`]);
  // A manifest that lands late, and agrees, raises nothing.
  const b3 = world();
  nightly(b3, 'daily', '2026-10-26', N2, 'night-26', NOW - 2 * DAY);
  const late = nightly(b3, 'daily', '2026-10-27', N1, 'night', NOW - 3 * MANIFEST_GRACE_MS, { manifest: false });
  assert.deepEqual((await run(b3)).live.flatMap((p) => p.keys), [`mismatch:${late}`]);
  b3.put('vaipakam-offchain-data-warm', manifest, JSON.stringify({ archive: { sha256: sha('night'), byteLength: 5, encryption: 'AES-256-GCM' } }));
  assert.deepEqual((await run(b3)).live, []);
});

test('a second version or a hide marker in the ledger pages as tampering', async () => {
  const b2 = world();
  const id = nightly(b2, 'daily', '2026-10-27', N1, 'night', NOW - DAY);
  await run(b2);
  b2.hide('vaipakam-offchain-backup-ledger', `entries/daily/2026-10-27/${id}.json`);
  const keys = (await run(b2)).live.flatMap((p) => p.keys);
  assert.deepEqual(keys, [`ledger-tampered:entries/daily/2026-10-27/${id}.json`]);
});

test('a yearly entry is lengthened while its archive exists', async () => {
  const b2 = world();
  const id = nightly(b2, 'yearly', '2026', N1, 'year', Date.UTC(2026, 0, 1, 3));
  nightly(b2, 'daily', '2026-10-27', N2, 'night', NOW - DAY);
  await run(b2, { env: { ARCHIVE_FIRST_YEARLY: '2026' } });
  const later = NOW + (YEARLY_RETENTION_DAYS - 300) * DAY; // under a year left
  nightly(b2, 'daily', new Date(later - DAY).toISOString().slice(0, 10), N3, 'later', later - DAY);
  nightly(b2, 'yearly', new Date(later).toISOString().slice(0, 4), N2, 'year-later', later - 30 * DAY);
  const r = await run(b2, { now: later, env: { ARCHIVE_FIRST_YEARLY: '2026' } });
  const entry = b2.versions('vaipakam-offchain-backup-ledger').find((v) => v.fileName.endsWith(`/${id}.json`));
  assert.equal(entry.fileRetention.retainUntilTimestamp, later + YEARLY_RETENTION_DAYS * DAY);
  assert.ok(!r.live.some((p) => p.keys.some((k) => k.startsWith('renewal-failed'))), JSON.stringify(r.live));
});

test('an acknowledged key stops paging; an unacknowledged one in the same run still pages', async () => {
  const b2 = world();
  nightly(b2, 'daily', '2026-10-26', N1, 'same', NOW - 2 * DAY);
  const copy = nightly(b2, 'daily', '2026-10-27', N2, 'same', NOW - DAY);
  assert.deepEqual((await run(b2)).live.flatMap((p) => p.keys), [`replay:${copy}`]);
  const r = await run(b2, { env: { BACKUP_ACKNOWLEDGED: `replay:${copy}` } });
  assert.deepEqual(r.live, []);
  assert.equal(r.quieted, 1);
});

test('a dry run judges what it would record and writes nothing', async () => {
  const b2 = world();
  nightly(b2, 'daily', '2026-10-27', N1, 'night', NOW - DAY);
  const r = await run(b2, { dryRun: true });
  assert.equal(r.written.length, 2);
  assert.deepEqual(r.live, []);
  assert.equal(b2.versions('vaipakam-offchain-backup-ledger').length, 0);
});

test('no verdict without the right keys and a locked ledger bucket', async () => {
  const b2 = world({ lock: false });
  nightly(b2, 'daily', '2026-10-27', N1, 'night', NOW - DAY);
  await assert.rejects(run(b2), /file lock is not enabled/);
  await assert.rejects(runWatcher({ env: {}, now: NOW, fetchImpl: b2.fetch }), /B2_ARCHIVE_READ_KEY_ID is not set/);
  const wide = world().key('ledger', { bucket: 'vaipakam-offchain-backup-ledger', capabilities: [...LEDGER_KEY_SCOPE.required, 'deleteFiles'] });
  await assert.rejects(run(wide), /must not have: deleteFiles/);
  await assert.rejects(run(world(), { env: { LEDGER_BUCKET: 'vaipakam-offchain-data-warm' } }), /scoped to vaipakam-offchain-backup-ledger/);
});
