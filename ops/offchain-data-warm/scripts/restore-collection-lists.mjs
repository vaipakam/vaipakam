#!/usr/bin/env node
/**
 * restore-collection-lists.mjs — #3688: put the published collection-offer
 * list files back into the indexer's store from their backup copies.
 *
 * The nightly copies each list file to
 * `collection-lists/<listHash>/<nonce>.json` in the archive bucket, unencrypted
 * (the files are public by design) and with a fresh nonce every time, so a
 * hash can hold several copies. A leaked write key could add a copy whose
 * bytes are not the list; it cannot overwrite one. So this restore trusts no
 * copy by its name: per hash it takes the newest copy whose bytes hash
 * (Keccak-256) to that hash, and ignores the rest. A hash with no such copy is
 * reported by name (list hashes are public: they are on-chain); a copy's
 * object name, whose nonce is what keeps it from being overwritten, is never
 * printed.
 *
 * Each good file is written to `<outdir>/lists/<listHash>`. With `--upload`,
 * each is then put into the `vaipakam-collection-lists` R2 bucket under
 * `lists/<listHash>` with wrangler, spawned with an argv array. Restore the
 * files BEFORE the indexer replays the chain: an offer whose list is missing
 * stays out of the default book until its file is posted again.
 *
 * Usage (the archive read key the backup watcher uses):
 *   B2_ARCHIVE_READ_KEY_ID=… B2_ARCHIVE_READ_KEY=… \
 *     node scripts/restore-collection-lists.mjs [--outdir restore] [--upload] [--remote|--local]
 *
 * Exit status: 0 when every hash found has a good copy, 1 when some hash has
 * none (the good ones are still written), 2 when the run could not finish.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { authorize, bytesById, listAllVersions, requireScope } from './lib/b2-native.mjs';
import { COLLECTION_LIST_PREFIX } from './lib/collection-list-rules.mjs';
import { keccak256 } from './lib/keccak256.mjs';
import { ARCHIVE_KEY_SCOPE } from './backup-ledger.mjs';

/** The R2 bucket the indexer serves list files from. */
export const LIST_STORE_BUCKET = 'vaipakam-collection-lists';

/** The largest list file the indexer accepts (apps/indexer MAX_LIST_FILE_BYTES). */
export const MAX_LIST_FILE_BYTES = 8 * 1024 * 1024;

const COPY_NAME = /^collection-lists\/(0x[0-9a-f]{64})\/[0-9a-f]{32}\.json$/;

/**
 * Per hash, the copies to try, newest first. Hide markers and names of any
 * other shape are left out: nothing the nightly writes looks like them.
 */
export function copiesByHash(versions) {
  const out = new Map();
  for (const v of versions) {
    if (v.action !== 'upload') continue;
    const m = COPY_NAME.exec(v.fileName ?? '');
    if (!m) continue;
    if (!out.has(m[1])) out.set(m[1], []);
    out.get(m[1]).push(v);
  }
  for (const list of out.values()) list.sort((a, b) => (b.uploadTimestamp ?? 0) - (a.uploadTimestamp ?? 0));
  return out;
}

/**
 * Read every copy group and pick, per hash, the first copy whose bytes hash
 * to it. Returns the good files and the hashes with none, plus how many
 * copies were refused (a count only).
 */
export async function pickGoodCopies({ auth, bucketId, io = {} }) {
  const versions = await listAllVersions(auth, bucketId, COLLECTION_LIST_PREFIX, io);
  const groups = copiesByHash(versions);
  const good = [];
  const noGoodCopy = [];
  let refused = 0;
  for (const [hash, copies] of [...groups].sort(([a], [b]) => (a < b ? -1 : 1))) {
    let found = null;
    for (const c of copies) {
      const bytes = await bytesById(auth, c.fileId, { ...io, maxBytes: MAX_LIST_FILE_BYTES });
      if (bytes && keccak256(bytes) === hash) {
        found = bytes;
        break;
      }
      refused++;
    }
    if (found) good.push({ hash, bytes: found });
    else noGoodCopy.push(hash);
  }
  return { good, noGoodCopy, refused, hashes: groups.size };
}

/** Write each good file to `<outdir>/lists/<hash>`; returns the paths. */
export function writeLists(good, outdir) {
  const dir = path.join(outdir, 'lists');
  mkdirSync(dir, { recursive: true });
  return good.map(({ hash, bytes }) => {
    const file = path.join(dir, hash);
    writeFileSync(file, bytes);
    return { hash, file };
  });
}

/** Put each written file into the list store with wrangler. */
export function uploadLists(written, { remote = true, spawn = spawnSync } = {}) {
  for (const { hash, file } of written) {
    const args = ['r2', 'object', 'put', `${LIST_STORE_BUCKET}/lists/${hash}`, '--file', file, '--content-type', 'application/json'];
    args.push(remote ? '--remote' : '--local');
    const r = spawn('wrangler', args, { stdio: 'inherit' });
    if (r.status !== 0) throw new Error(`wrangler r2 object put for list ${hash} failed (status ${r.status})`);
  }
}

function parseArgs(argv) {
  const opts = { outdir: 'restore', upload: false, remote: true };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--outdir') opts.outdir = argv[++i];
    else if (a === '--upload') opts.upload = true;
    else if (a === '--remote') opts.remote = true;
    else if (a === '--local') opts.remote = false;
    else throw new Error(`unknown argument ${a}; usage: [--outdir restore] [--upload] [--remote|--local]`);
  }
  if (!opts.outdir) throw new Error('--outdir needs a directory');
  return opts;
}

export async function main(argv, { env = process.env, fetchImpl = fetch, spawn = spawnSync, log = (l) => process.stdout.write(`${l}\n`) } = {}) {
  const opts = parseArgs(argv);
  const bucket = env.ARCHIVE_BUCKET || 'vaipakam-offchain-data-warm';
  for (const k of ['B2_ARCHIVE_READ_KEY_ID', 'B2_ARCHIVE_READ_KEY']) if (!env[k]) throw new Error(`${k} is not set`);
  const io = { fetchImpl };
  const auth = await authorize(env.B2_ARCHIVE_READ_KEY_ID, env.B2_ARCHIVE_READ_KEY, io);
  const bucketId = requireScope(auth, { ...ARCHIVE_KEY_SCOPE, bucket });
  const { good, noGoodCopy, refused, hashes } = await pickGoodCopies({ auth, bucketId, io });
  const written = writeLists(good, opts.outdir);
  log(`Collection-offer lists: ${hashes} hash(es) in the backup, ${good.length} restored to ${path.join(opts.outdir, 'lists')}, ${refused} copy(ies) refused because their bytes did not match their hash.`);
  for (const h of noGoodCopy) log(`NO GOOD COPY: ${h} — repost this list to the indexer from another source (the offer's lender holds it).`);
  if (opts.upload) {
    uploadLists(written, { remote: opts.remote, spawn });
    log(`Uploaded ${written.length} file(s) to ${LIST_STORE_BUCKET} (${opts.remote ? 'remote' : 'local'}).`);
  }
  return noGoodCopy.length > 0 ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv)
    .then((code) => process.exit(code))
    .catch((e) => {
      process.stderr.write(`restore-collection-lists: ${e?.message ?? e}\n`);
      process.exit(2);
    });
}
