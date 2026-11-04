/**
 * node:test suite for the offline decrypt step (#1463, #1473; design:
 * docs/DesignsAndPlans/BackupSecurityDesign.md §6).
 *
 * The ledger is written by the real watcher (`runWatcher`) against an
 * in-memory B2, then read by the decrypt tool through a read-only ledger key,
 * so every refusal is exercised against entries shaped exactly as production
 * writes them. The archives are sealed to keys generated here: the committed
 * recipients' private keys are offline and never in a test.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PK_SCHEME, sealArchive } from '../src/archiveFormat.ts';
import { runWatcher } from './backup-ledger.mjs';
import { Refusal, chooseEntry, parseCommandLine, runDecrypt } from './decrypt-archive.mjs';
import { fakeB2 } from './test-helpers/fake-b2.mjs';
import { recipientsFile, testRecipient } from './test-helpers/keys.mjs';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 11, 10, 4, 17); // 2026-12-10 04:17 UTC
const AT = NOW - DAY; // the 2026-12-09 nightly's upload
const CREATED = new Date(AT - 60_000).toISOString();
const N1 = 'a'.repeat(32);
const N2 = 'b'.repeat(32);
const ARCHIVES = 'vaipakam-offchain-data-warm';
const LEDGER = 'vaipakam-offchain-backup-ledger';
const sha = (b) => createHash('sha256').update(b).digest('hex');

const A = testRecipient('a');
const B = testRecipient('b');
const SET = { set: 1, effectiveFrom: '2026-11-04T00:00:00.000Z', recipients: [A.recipient] };
const LEGACY_KEY = 'ab'.repeat(32);

const dir = mkdtempSync(join(tmpdir(), 'decrypt-archive-'));
let files = 0;
const file = (name, bytes) => {
  const p = join(dir, `${++files}-${name}`);
  if (bytes !== undefined) writeFileSync(p, bytes);
  return p;
};
const RECIPIENTS = file('recipients.json', JSON.stringify(recipientsFile([{ effectiveFrom: SET.effectiveFrom, recipients: SET.recipients }])));
const KEY_A = file('a.pem', A.privateKey.export({ type: 'pkcs8', format: 'pem' }));
const KEY_B = file('b.pem', B.privateKey.export({ type: 'pkcs8', format: 'pem' }));
const LEGACY = file('legacy.hex', `${LEGACY_KEY}\n`);

const plaintext = (createdAt = CREATED) => new TextEncoder().encode(JSON.stringify({ version: 1, createdAt, d1: { archive: [] }, r2: { objects: [] } }));

function world() {
  return fakeB2({ now: NOW })
    .bucket(ARCHIVES)
    .bucket(LEDGER, { lock: true })
    .key('reader', { bucket: ARCHIVES, capabilities: ['listBuckets', 'listFiles', 'readFiles'] })
    .key('ledger', { bucket: LEDGER, capabilities: ['listFiles', 'readFiles', 'writeFiles', 'readFileRetentions', 'writeFileRetentions'] })
    .key('ledger-reader', { bucket: LEDGER, capabilities: ['listFiles', 'readFiles', 'readFileRetentions'] })
    .key('ledger-writer', { bucket: LEDGER, capabilities: ['listFiles', 'readFiles', 'writeFiles', 'readFileRetentions'] });
}

/** Put one archive and its manifest in the archive bucket. */
function put(b2, period, nonce, bytes, at, encryption) {
  const fileId = b2.put(ARCHIVES, `archives/${period}/${nonce}.bin`, Buffer.from(bytes), at);
  b2.put(ARCHIVES, `manifests/${period}/${nonce}.json`, JSON.stringify({ archive: { sha256: sha(bytes), byteLength: bytes.length, encryption } }), at + 1000);
  return fileId;
}

const sealed = (over = {}) => sealArchive({ set: SET, plaintext: plaintext(), tier: 'daily', period: '2026-12-09', createdAt: CREATED, ...over });

async function legacySealed(createdAt = CREATED) {
  const key = await crypto.subtle.importKey('raw', Buffer.from(LEGACY_KEY, 'hex'), 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext(createdAt)));
  return new Uint8Array([...iv, ...ct]);
}

const noSleep = async () => {};
const record = (b2) =>
  runWatcher({ env: { B2_ARCHIVE_READ_KEY_ID: 'reader', B2_ARCHIVE_READ_KEY: 's', B2_LEDGER_KEY_ID: 'ledger', B2_LEDGER_KEY: 's' }, now: NOW, fetchImpl: b2.fetch, sleep: noSleep });

function decrypt(b2, args, { env = {}, askPassphrase } = {}) {
  const out = file('out.json');
  const lines = [];
  const p = runDecrypt({
    argv: ['--tier', 'daily', '--period', '2026-12-09', '--out', out, ...args],
    env: { B2_LEDGER_READ_KEY_ID: 'ledger-reader', B2_LEDGER_READ_KEY: 's', ...env },
    fetchImpl: b2.fetch,
    sleep: noSleep,
    log: (l) => lines.push(l),
    recipientsPath: RECIPIENTS,
    ...(askPassphrase ? { askPassphrase } : {}),
  });
  return { p, out, lines };
}

async function refusal(promise, pattern) {
  await assert.rejects(promise, (e) => {
    assert.ok(e instanceof Refusal, `expected a refusal, got ${e?.message}`);
    assert.match(e.lines.join('\n'), pattern);
    return true;
  });
}

// ── The happy paths ─────────────────────────────────────────────────────

test('a public-key archive the ledger recorded decrypts with a recipient key', async () => {
  const b2 = world();
  const bytes = await sealed();
  const id = put(b2, '2026-12-09', N1, bytes, AT, PK_SCHEME);
  await record(b2);
  const { p, out, lines } = decrypt(b2, ['--archive', file('a.bin', bytes), '--file-id', id, '--key', KEY_A]);
  const r = await p;
  assert.equal(r.format, 'pk');
  assert.equal(r.createdAt, CREATED);
  assert.deepEqual([...readFileSync(out)], [...plaintext()]);
  assert.equal(statSync(out).mode & 0o777, 0o600);
  assert.ok(lines.some((l) => l.startsWith('ledger: daily 2026-12-09')), lines.join('\n'));
});

test('an old-format archive the ledger recorded decrypts with the old AES key', async () => {
  const b2 = world();
  const bytes = await legacySealed();
  const id = put(b2, '2026-12-09', N1, bytes, AT, 'AES-256-GCM');
  await record(b2);
  const r = await decrypt(b2, ['--archive', file('a.bin', bytes), '--file-id', id, '--legacy-key', LEGACY]).p;
  assert.equal(r.format, 'legacy');
});

test('a passphrase-protected key is read with the passphrase it is asked for', async () => {
  const b2 = world();
  const bytes = await sealed();
  const id = put(b2, '2026-12-09', N1, bytes, AT, PK_SCHEME);
  await record(b2);
  const locked = file('locked.pem', A.privateKey.export({ type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: 'correct horse' }));
  let asked = 0;
  const askPassphrase = async () => (++asked, 'correct horse');
  await decrypt(b2, ['--archive', file('a.bin', bytes), '--file-id', id, '--key', locked], { askPassphrase }).p;
  assert.equal(asked, 1);
  await assert.rejects(decrypt(b2, ['--archive', file('a.bin', bytes), '--file-id', id, '--key', locked], { askPassphrase: async () => 'wrong' }).p, /could not be read/);
});

// ── The refusals (design §6) ────────────────────────────────────────────

test('an archive whose bytes are not the recorded ones is refused, whatever its manifest says', async () => {
  const b2 = world();
  const bytes = await sealed();
  const id = put(b2, '2026-12-09', N1, bytes, AT, PK_SCHEME);
  await record(b2);
  const other = await sealed();
  await refusal(decrypt(b2, ['--archive', file('x.bin', other), '--file-id', id, '--key', KEY_A]).p, /not the ones the ledger recorded/);
  await refusal(decrypt(b2, ['--archive', file('x.bin', bytes), '--file-id', '4_zother', '--key', KEY_A]).p, /No ledger entry .* names the archive/);
});

test('a period with more than one entry is refused until the operator names one', async () => {
  const b2 = world();
  const first = await sealed();
  const second = await sealed();
  const id1 = put(b2, '2026-12-09', N1, first, AT, PK_SCHEME);
  const id2 = put(b2, '2026-12-09', N2, second, AT + 600_000, PK_SCHEME);
  await record(b2);
  const archive = file('a.bin', first);
  await refusal(decrypt(b2, ['--archive', archive, '--file-id', id1, '--key', KEY_A]).p, new RegExp(`2 entries[\\s\\S]*${id1}[\\s\\S]*${id2}`));
  await refusal(decrypt(b2, ['--archive', archive, '--file-id', id1, '--entry', id2, '--key', KEY_A]).p, /--entry names/);
  assert.equal((await decrypt(b2, ['--archive', archive, '--file-id', id1, '--entry', id1, '--key', KEY_A]).p).entry.fileId, id1);
});

test('a tampered ledger is refused, printing every version, until the operator names the one to trust', async () => {
  const b2 = world();
  const bytes = await sealed();
  const id = put(b2, '2026-12-09', N1, bytes, AT, PK_SCHEME);
  await record(b2);
  const genuine = b2.versions(LEDGER).find((v) => v.fileName.endsWith(`/${id}.json`));
  // A second version at the entry's name, as a stolen ledger key could add.
  b2.versions(LEDGER).push({ ...genuine, fileId: '4_zforged', uploadTimestamp: NOW + 1000, fileInfo: { ...genuine.fileInfo, sha256: sha('forged') } });
  const archive = file('a.bin', bytes);
  await refusal(decrypt(b2, ['--archive', archive, '--file-id', id, '--key', KEY_A]).p, /shows tampering[\s\S]*2 versions[\s\S]*4_zforged/);
  await refusal(decrypt(b2, ['--archive', archive, '--file-id', id, '--key', KEY_A, '--ledger-version', '4_zforged']).p, /not the ones the ledger recorded/);
  const r = decrypt(b2, ['--archive', archive, '--file-id', id, '--key', KEY_A, '--ledger-version', genuine.fileId]);
  await r.p;
  assert.ok(r.lines.some((l) => /trusting ledger version/.test(l)));
});

test('an archive the ledger never saw is refused; --pre-ledger-archive admits only the old format, and says nothing vouches', async () => {
  const b2 = world();
  const legacy = await legacySealed();
  await refusal(decrypt(b2, ['--archive', file('a.bin', legacy), '--file-id', '4_zunseen', '--legacy-key', LEGACY]).p, /no entry[\s\S]*--pre-ledger-archive/);
  const r = decrypt(b2, ['--archive', file('a.bin', legacy), '--pre-ledger-archive', '--legacy-key', LEGACY]);
  await r.p;
  assert.match(r.lines[0], /NOTHING VOUCHES/);
  await refusal(decrypt(b2, ['--archive', file('a.bin', await sealed()), '--pre-ledger-archive', '--key', KEY_A]).p, /old format/);
});

test('a payload whose own time disagrees with its header or its period is refused after decryption', async () => {
  const b2 = world();
  const bytes = await sealArchive({ set: SET, plaintext: plaintext('2026-12-09T01:00:00.000Z'), tier: 'daily', period: '2026-12-09', createdAt: CREATED });
  const id = put(b2, '2026-12-09', N1, bytes, AT, PK_SCHEME);
  const legacy = await legacySealed('2026-12-08T03:17:00.000Z');
  const id2 = put(b2, '2026-12-09', N2, legacy, AT + 600_000, 'AES-256-GCM');
  await record(b2);
  await refusal(decrypt(b2, ['--archive', file('a.bin', bytes), '--file-id', id, '--entry', id, '--key', KEY_A]).p, /header says .* and its payload/);
  await refusal(decrypt(b2, ['--archive', file('b.bin', legacy), '--file-id', id2, '--entry', id2, '--legacy-key', LEGACY]).p, /not in daily 2026-12-09/);
});

test('a key that is not a recipient is refused; the wrong kind of key is a usage error', async () => {
  const b2 = world();
  const bytes = await sealed();
  const id = put(b2, '2026-12-09', N1, bytes, AT, PK_SCHEME);
  await record(b2);
  const archive = file('a.bin', bytes);
  await refusal(decrypt(b2, ['--archive', archive, '--file-id', id, '--key', KEY_B]).p, /not a recipient/);
  await assert.rejects(decrypt(b2, ['--archive', archive, '--file-id', id, '--legacy-key', LEGACY]).p, /decrypt it with --key/);
});

test('an earlier decrypt is never overwritten', async () => {
  const b2 = world();
  const bytes = await sealed();
  const id = put(b2, '2026-12-09', N1, bytes, AT, PK_SCHEME);
  await record(b2);
  const out = file('existing.json', 'keep me');
  await assert.rejects(
    runDecrypt({
      argv: ['--tier', 'daily', '--period', '2026-12-09', '--out', out, '--archive', file('a.bin', bytes), '--file-id', id, '--key', KEY_A],
      env: { B2_LEDGER_READ_KEY_ID: 'ledger-reader', B2_LEDGER_READ_KEY: 's' },
      fetchImpl: b2.fetch,
      sleep: noSleep,
      recipientsPath: RECIPIENTS,
    }),
    /EEXIST/,
  );
  assert.equal(readFileSync(out, 'utf8'), 'keep me');
});

test('a ledger key that can write is refused before anything is read', async () => {
  const b2 = world();
  await assert.rejects(
    decrypt(b2, ['--archive', file('a.bin', await sealed()), '--file-id', 'x', '--key', KEY_A], { env: { B2_LEDGER_READ_KEY_ID: 'ledger-writer' } }).p,
    /capabilities this job must not have: writeFiles/,
  );
});

test('the command line refuses what it cannot act on', () => {
  const base = ['--archive', 'a', '--tier', 'daily', '--period', '2026-12-09', '--out', 'o'];
  assert.throws(() => parseCommandLine([...base, '--key', 'k']), /--file-id is required/);
  assert.throws(() => parseCommandLine([...base, '--file-id', 'f']), /exactly one of --key/);
  assert.throws(() => parseCommandLine([...base, '--file-id', 'f', '--key', 'k', '--legacy-key', 'l']), /exactly one/);
  assert.throws(() => parseCommandLine(['--archive', 'a', '--tier', 'daily', '--period', '2026-02-30', '--out', 'o', '--key', 'k', '--file-id', 'f']), /not a daily period/);
  assert.throws(() => parseCommandLine([...base, '--pre-ledger-archive', '--entry', 'e', '--key', 'k']), /skips the ledger/);
  assert.throws(() => parseCommandLine([...base, '--file-id', 'f', '--key', 'k', '--passphrase', 'x']), /Unknown option/);
  assert.equal(parseCommandLine([...base, '--file-id', 'f', '--key', 'k'])['file-id'], 'f');
});

test('the entry choice needs no network: an empty period is refused from the listing alone', () => {
  assert.throws(() => chooseEntry({ versions: [], tier: 'daily', period: '2026-12-09', fileId: 'f', sha256: sha('x'), length: 1 }), Refusal);
});
