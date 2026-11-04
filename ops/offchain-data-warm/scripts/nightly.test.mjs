/**
 * node:test suite for the nightly itself (#1463): the Worker's
 * `runNightlyBackup`, run against stand-ins for D1, R2 and the B2 S3 API,
 * and its uploads then judged by the real backup watcher.
 *
 * The archives are sealed to the COMMITTED recipients, whose private keys are
 * offline, so nothing here decrypts them. What is pinned is what the Worker
 * can be held to without a private key: every tier is sealed on its own,
 * under its own nonce, to the set in force; each manifest describes its own
 * archive; the run's report names no object; and the watcher, reading the
 * bucket the run left, finds nothing to page on.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { register } from 'node:module';

import { PK_SCHEME, parseArchiveHeader } from '../src/archiveFormat.ts';
import { runWatcher } from './backup-ledger.mjs';
import { fakeB2 } from './test-helpers/fake-b2.mjs';

register('./test-helpers/worker-source-hooks.mjs', import.meta.url);
const { runNightlyBackup } = await import('../src/backup.ts');

const committed = (await import('../backup-recipients/recipients.json', { with: { type: 'json' } })).default;
const sha = (b) => createHash('sha256').update(b).digest('hex');

/** D1 holding one row in each table the nightly asks for, support_tickets included. */
const d1 = {
  prepare(sql) {
    const table = /PRAGMA table_info\((\w+)\)/.exec(sql)?.[1] ?? /FROM (\w+)/.exec(sql)?.[1];
    const pragma = sql.startsWith('PRAGMA');
    return {
      bind: () => this.prepare(sql),
      all: async () => ({ results: pragma ? [{ cid: 0, name: 'id', type: 'TEXT', notnull: 1, pk: 1 }] : [{ id: `${table}-1` }] }),
      first: async () => ({ n: 1 }),
    };
  },
};
const r2 = { list: async () => ({ objects: [], truncated: false }), get: async () => null };

/** Run the nightly at `at`, capturing every PUT it makes. */
async function nightlyAt(at) {
  const puts = [];
  const realFetch = globalThis.fetch;
  const realNow = Date.now;
  globalThis.fetch = async (url, init) => {
    puts.push({ key: decodeURI(new URL(url).pathname.split('/').slice(2).join('/')), body: Buffer.from(init.body) });
    return new Response('', { status: 200 });
  };
  Date.now = () => at;
  try {
    const out = await runNightlyBackup(
      { DB_ARCHIVE: d1, R2_LEGAL_VAULT: r2 },
      { endpoint: 's3.us-west-004.backblazeb2.com', bucket: 'vaipakam-offchain-data-warm', region: 'us-west-004', accessKeyId: 'k', secretAccessKey: 's' },
    );
    return { out, puts };
  } finally {
    globalThis.fetch = realFetch;
    Date.now = realNow;
  }
}

const JAN1 = Date.UTC(2027, 0, 1, 3, 17);

test('on 1 January each tier is sealed on its own, to the set in force, under its own nonce', async () => {
  const { out, puts } = await nightlyAt(JAN1);
  const archives = puts.filter((p) => p.key.endsWith('.bin'));
  assert.deepEqual(archives.map((p) => p.key.split('/').slice(0, 2).join('/')), ['archives/2027-01-01', 'archives-monthly/2027-01', 'archives-yearly/2027']);
  const nonces = archives.map((p) => p.key.split('/')[2]);
  assert.equal(new Set(nonces).size, 3, 'one nonce per archive');
  assert.equal(new Set(archives.map((p) => sha(p.body))).size, 3, 'three unrelated ciphertexts');
  const set = committed.sets.at(-1).recipients.map((r) => r.fingerprint).sort();
  for (const a of archives) {
    const h = parseArchiveHeader(a.body);
    assert.equal(h.ok, true, h.reason);
    assert.equal(h.header.createdAt, new Date(JAN1).toISOString());
    assert.deepEqual(h.header.recipients.map((r) => r.fingerprint).sort(), set);
    const manifest = JSON.parse(puts.find((p) => p.key === a.key.replace('archives', 'manifests').replace('.bin', '.json')).body);
    assert.deepEqual(manifest.archive, { sha256: sha(a.body), byteLength: a.body.length, encryption: PK_SCHEME, recipientSet: committed.sets.at(-1).set });
  }
  // The long tiers leave support tickets out, so their manifests list one table fewer.
  const tables = (k) => JSON.parse(puts.find((p) => p.key.startsWith(k)).body).d1.archive.map((t) => t.table);
  assert.ok(tables('manifests/').includes('support_tickets'));
  assert.ok(!tables('manifests-monthly/').includes('support_tickets'));
  assert.ok(!tables('manifests-yearly/').includes('support_tickets'));
  // The report names tiers, periods, sizes and digests, never an object.
  assert.deepEqual(out.archives.map((a) => [a.tier, a.period]), [['daily', '2027-01-01'], ['monthly', '2027-01'], ['yearly', '2027']]);
  assert.ok(!JSON.stringify(out).includes(nonces[0]));
});

test('an ordinary night writes the daily alone', async () => {
  const { out, puts } = await nightlyAt(Date.UTC(2027, 0, 9, 3, 17));
  assert.deepEqual(puts.map((p) => p.key.split('/')[0]), ['archives', 'manifests']);
  assert.equal(out.archives.length, 1);
});

test('the watcher, reading the bucket a night left, records it in the new format and pages nothing', async () => {
  const at = JAN1;
  const { puts } = await nightlyAt(at);
  const b2 = fakeB2({ now: at + 3_600_000 })
    .bucket('vaipakam-offchain-data-warm')
    .bucket('vaipakam-offchain-backup-ledger', { lock: true })
    .key('reader', { bucket: 'vaipakam-offchain-data-warm', capabilities: ['listBuckets', 'listFiles', 'readFiles'] })
    .key('ledger', { bucket: 'vaipakam-offchain-backup-ledger', capabilities: ['listFiles', 'readFiles', 'writeFiles', 'readFileRetentions', 'writeFileRetentions'] });
  puts.forEach((p, i) => b2.put('vaipakam-offchain-data-warm', p.key, p.body, at + 60_000 + i * 1000));
  const r = await runWatcher({
    env: { B2_ARCHIVE_READ_KEY_ID: 'reader', B2_ARCHIVE_READ_KEY: 's', B2_LEDGER_KEY_ID: 'ledger', B2_LEDGER_KEY: 's' },
    now: at + 3_600_000,
    fetchImpl: b2.fetch,
    sleep: async () => {},
  });
  assert.deepEqual(r.live, []);
  assert.equal(r.written.length, 3);
  for (const e of r.written) {
    assert.equal(e.format, 'pk-rsa-oaep-256-a256gcm');
    assert.equal(e.header, 'ok');
    assert.equal(e.check, 'match');
  }
});
