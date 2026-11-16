/**
 * #3688 — the backup of published collection-offer list files: the nightly's
 * copy step, the watcher's presence check, and the restore that keeps only a
 * copy whose bytes hash to its name.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { register } from 'node:module';

import { keccak256 } from './lib/keccak256.mjs';
import { copiedHashes, judgeListCopies, LIST_COPY_GRACE_MS, readListIndex } from './lib/collection-list-rules.mjs';
import { copiesByHash, main as restoreMain, pickGoodCopies } from './restore-collection-lists.mjs';
import { runWatcher } from './backup-ledger.mjs';
import { authorize } from './lib/b2-native.mjs';
import { fakeB2 } from './test-helpers/fake-b2.mjs';

register('./test-helpers/worker-source-hooks.mjs', import.meta.url);
const { mirrorCollectionLists, MIRROR_WINDOW_HOURS } = await import('../src/collectionLists.ts');

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 10, 16, 4);
const FILE = '["3","7","42","1000"]';
// keccak256 of FILE, as viem computes it (and as the indexer stores it).
const HASH = '0x0254d6c9ae70834ace43acd9322c59a96c8a7ae3b929c3a9a3a7d934ba9b908b';
const OTHER = `0x${'12'.repeat(32)}`;
const nonce = (c) => c.repeat(32);
const BUCKET = 'vaipakam-offchain-data-warm';

test('keccak256 matches the standard vectors and the hash the indexer gives a list file', () => {
  assert.equal(keccak256(Buffer.from('')), '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
  assert.equal(keccak256(Buffer.from('abc')), '0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45');
  assert.equal(keccak256(Buffer.from(FILE)), HASH);
  // Across a block boundary (the rate is 136 bytes).
  assert.equal(keccak256(Buffer.alloc(136, 0x61)), '0x' + 'a6c4d403279fe3e0af03729caada8374b5ca54d8065329a3ebcaeb4b60aa386e');
});

test('the watcher counts only uploads with the nightly name shape as copies', () => {
  const got = copiedHashes([
    { action: 'upload', fileName: `collection-lists/${HASH}/${nonce('a')}.json` },
    { action: 'hide', fileName: `collection-lists/${OTHER}/${nonce('a')}.json` },
    { action: 'upload', fileName: `collection-lists/${OTHER}/short.json` },
  ]);
  assert.deepEqual([...got], [HASH]);
});

test('a published list past the grace period with no copy is a problem; a new one waits', () => {
  const stored = (msAgo) => Math.floor((NOW - msAgo) / 1000);
  const { problems, notes } = judgeListCopies({
    now: NOW,
    published: [
      { listHash: HASH, storedAt: stored(100 * HOUR) },
      { listHash: OTHER.toUpperCase().replace('0X', '0x'), storedAt: stored(100 * HOUR) },
      { listHash: `0x${'c'.repeat(64)}`, storedAt: stored(LIST_COPY_GRACE_MS - HOUR) },
    ],
    versions: [{ action: 'upload', fileName: `collection-lists/${HASH}/${nonce('a')}.json` }],
  });
  assert.deepEqual(problems.map((p) => p.keys[0]), [`collection-list-uncopied:${OTHER}`]);
  assert.match(notes[0], /3 published, 1 copied, 1 within the copy window, 1 missing/);
  // The problem names the hash and never a copy's object name.
  assert.doesNotMatch(problems[0].text, /\.json/);
});

test('the index is read across its pages, and a bad answer throws', async () => {
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(url);
    const after = new URL(url).searchParams.get('after');
    return Response.json(after ? { lists: [{ listHash: OTHER, storedAt: 2 }], nextAfter: null } : { lists: [{ listHash: HASH, storedAt: 1 }], nextAfter: HASH });
  };
  const all = await readListIndex('https://indexer.example/', { fetchImpl });
  assert.deepEqual(all.map((l) => l.listHash), [HASH, OTHER]);
  assert.equal(seen[1], `https://indexer.example/collection-lists?limit=1000&after=${HASH}`);
  await assert.rejects(readListIndex('https://x', { fetchImpl: async () => new Response('', { status: 500 }) }), /answered 500/);
  await assert.rejects(readListIndex('https://x', { fetchImpl: async () => Response.json({}) }), /expected shape/);
});

/** An archive bucket with a reader and a writer key, holding `copies`. */
function bucketWith(copies) {
  const b2 = fakeB2({ now: NOW })
    .bucket(BUCKET)
    .bucket('vaipakam-offchain-backup-ledger', { lock: true })
    .key('reader', { bucket: BUCKET, capabilities: ['listBuckets', 'listFiles', 'readFiles'] })
    .key('ledger', { bucket: 'vaipakam-offchain-backup-ledger', capabilities: ['listFiles', 'readFiles', 'writeFiles', 'readFileRetentions', 'writeFileRetentions'] });
  for (const [name, body, at] of copies) b2.put(BUCKET, name, body, at);
  return b2;
}

test('the watcher pages for a published list with no copy, and not once a copy exists', async () => {
  const index = { lists: [{ listHash: HASH, storedAt: Math.floor((NOW - 100 * HOUR) / 1000) }], nextAfter: null };
  const run = (b2, env = {}) =>
    runWatcher({
      env: { B2_ARCHIVE_READ_KEY_ID: 'reader', B2_ARCHIVE_READ_KEY: 's', B2_LEDGER_KEY_ID: 'ledger', B2_LEDGER_KEY: 's', INDEXER_ORIGIN: 'https://indexer.example', ...env },
      now: NOW,
      dryRun: true,
      sleep: async () => {},
      fetchImpl: (url, init) => (String(url).startsWith('https://indexer.example/') ? Promise.resolve(Response.json(index)) : b2.fetch(url, init)),
    });
  const keys = (r) => r.live.flatMap((p) => p.keys).filter((k) => k.startsWith('collection-list'));

  assert.deepEqual(keys(await run(bucketWith([]))), [`collection-list-uncopied:${HASH}`]);
  const copied = bucketWith([[`collection-lists/${HASH}/${nonce('a')}.json`, FILE]]);
  assert.deepEqual(keys(await run(copied)), []);
  // No origin: a note, not a page.
  const unset = await run(bucketWith([]), { INDEXER_ORIGIN: '' });
  assert.deepEqual(keys(unset), []);
  assert.ok(unset.notes.some((n) => /INDEXER_ORIGIN is not set/.test(n)));
  // An unreachable index is a page of its own.
  const down = await runWatcher({
    env: { B2_ARCHIVE_READ_KEY_ID: 'reader', B2_ARCHIVE_READ_KEY: 's', B2_LEDGER_KEY_ID: 'ledger', B2_LEDGER_KEY: 's', INDEXER_ORIGIN: 'https://indexer.example' },
    now: NOW,
    dryRun: true,
    sleep: async () => {},
    fetchImpl: (url, init) => (String(url).startsWith('https://indexer.example/') ? Promise.resolve(new Response('', { status: 503 })) : copied.fetch(url, init)),
  });
  assert.deepEqual(keys(down), ['collection-list-index-unreadable']);
});

test('the nightly copies each file stored in the window under its own nonce, and skips cleanly', async () => {
  const asked = [];
  const db = {
    prepare(sql) {
      return {
        bind: (since) => ({
          all: async () => {
            asked.push({ sql, since });
            return { results: [{ list_hash: HASH }, { list_hash: OTHER }, { list_hash: 'not-a-hash' }] };
          },
        }),
      };
    },
  };
  const store = { get: async (key) => (key === `lists/${HASH}` ? { arrayBuffer: async () => new TextEncoder().encode(FILE).buffer } : null) };
  const puts = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    puts.push({ key: decodeURI(new URL(url).pathname.split('/').slice(2).join('/')), body: Buffer.from(init.body).toString() });
    return new Response('', { status: 200 });
  };
  const cfg = { endpoint: 's3.us-west-004.backblazeb2.com', bucket: BUCKET, region: 'us-west-004', accessKeyId: 'k', secretAccessKey: 's' };
  try {
    const out = await mirrorCollectionLists(db, store, cfg, NOW, () => nonce('d'));
    assert.deepEqual(out, { copied: 1, bytes: FILE.length, missingFromStore: 1, skipped: null });
    assert.equal(asked[0].since, Math.floor(NOW / 1000) - MIRROR_WINDOW_HOURS * 3600);
    assert.deepEqual(puts, [{ key: `collection-lists/${HASH}/${nonce('d')}.json`, body: FILE }]);

    assert.equal((await mirrorCollectionLists(db, undefined, cfg, NOW, () => nonce('d'))).skipped, 'no COLLECTION_LISTS binding');
    const unmigrated = { prepare: () => ({ bind: () => ({ all: async () => { throw new Error('D1_ERROR: no such table: collection_offer_set'); } }) }) };
    assert.equal((await mirrorCollectionLists(unmigrated, store, cfg, NOW, () => nonce('d'))).skipped, 'collection_offer_set not migrated yet');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('a restore takes a copy whose bytes hash to its name, ignores forged ones, and names a hash with none', async () => {
  const b2 = bucketWith([
    [`collection-lists/${HASH}/${nonce('a')}.json`, FILE, NOW - 3 * HOUR],
    // A newer forged copy under the same hash: tried first, refused.
    [`collection-lists/${HASH}/${nonce('b')}.json`, '["1"]', NOW - HOUR],
    [`collection-lists/${OTHER}/${nonce('c')}.json`, FILE, NOW - HOUR],
    [`collection-lists/${OTHER}/stray.txt`, FILE, NOW - HOUR],
  ]);
  assert.equal(copiesByHash(b2.versions(BUCKET)).get(HASH)[0].fileName.endsWith(`${nonce('b')}.json`), true);

  const auth = await authorize('reader', 's', { fetchImpl: b2.fetch });
  const picked = await pickGoodCopies({ auth, bucketId: auth.bucketId, io: { fetchImpl: b2.fetch } });
  assert.deepEqual(picked.good.map((g) => [g.hash, g.bytes.toString()]), [[HASH, FILE]]);
  assert.deepEqual(picked.noGoodCopy, [OTHER]);
  assert.equal(picked.refused, 2);

  const outdir = mkdtempSync(path.join(tmpdir(), 'lists-'));
  const lines = [];
  const spawned = [];
  const code = await restoreMain(['node', 'x', '--outdir', outdir, '--upload'], {
    env: { B2_ARCHIVE_READ_KEY_ID: 'reader', B2_ARCHIVE_READ_KEY: 's' },
    fetchImpl: b2.fetch,
    spawn: (cmd, args) => {
      spawned.push([cmd, ...args]);
      return { status: 0 };
    },
    log: (l) => lines.push(l),
  });
  assert.equal(code, 1);
  assert.equal(readFileSync(path.join(outdir, 'lists', HASH), 'utf8'), FILE);
  assert.deepEqual(spawned, [['wrangler', 'r2', 'object', 'put', `vaipakam-collection-lists/lists/${HASH}`, '--file', path.join(outdir, 'lists', HASH), '--content-type', 'application/json', '--remote']]);
  assert.ok(lines.some((l) => l.includes(`NO GOOD COPY: ${OTHER}`)));
  // No copy's object name (its nonce) is ever printed.
  for (const c of ['a', 'b', 'c']) assert.ok(lines.every((l) => !l.includes(nonce(c))));
});
