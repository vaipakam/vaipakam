#!/usr/bin/env node
/**
 * One-time setup for the backup watcher and its ledger (#1469, #1473; design:
 * docs/DesignsAndPlans/BackupSecurityDesign.md §5 and §9).
 *
 * Runs LOCALLY, on the owner's workstation, with the account master key from
 * the repo `.env` (BACKBLAZE_MASTER_KEY_ID + BACKBLAZE_MASTER_APP_KEY), and
 * with `gh` signed in as an account that can set this repository's secrets.
 * Idempotent; each step says what it found:
 *
 *   1. Checks `gh` can set secrets here, BEFORE anything is created: B2 shows
 *      a new key's secret exactly once, so a key created when its secret
 *      cannot then be stored would have to be revoked and made again.
 *   2. Creates the ledger bucket, private, with Object Lock enabled. B2 allows
 *      Object Lock only at creation, so an existing bucket without it is
 *      refused, never reused.
 *   3. Creates two keys, each confined to one bucket:
 *        - the watcher's own archive read key (listBuckets, listFiles,
 *          readFiles on the archive bucket), apart from the Worker's;
 *        - the ledger key (listBuckets, listFiles, readFiles, writeFiles,
 *          readFileRetentions, writeFileRetentions on the ledger bucket), with
 *          no deleteFiles and no bypassGovernance.
 *   4. Stores both straight into the repository's Actions secrets through
 *      `gh secret set`, reading each value from stdin. Nothing is printed, so
 *      no key reaches a terminal scrollback or a shell history.
 *
 * A key that already exists is checked against the capabilities above and
 * reused, and its secret is NOT re-stored, because B2 cannot show it again. To
 * rotate one, revoke it in the B2 console and run this again.
 *
 *   node scripts/setup-backup-ledger.mjs [--repo owner/name]
 */

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { authorize, call } from './lib/b2-native.mjs';
import { ARCHIVE_KEY_SCOPE, LEDGER_KEY_SCOPE } from './backup-ledger.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../..');

const ARCHIVE_BUCKET = process.env.ARCHIVE_BUCKET || 'vaipakam-offchain-data-warm';
const LEDGER_BUCKET = process.env.LEDGER_BUCKET || 'vaipakam-offchain-backup-ledger';
const ARCHIVE_KEY_NAME = 'vaipakam-backup-watcher-archive-read';
const LEDGER_KEY_NAME = 'vaipakam-backup-watcher-ledger';

/** Each key gets exactly its allowlist; the watcher refuses anything wider. */
const KEYS = [
  { name: ARCHIVE_KEY_NAME, bucket: ARCHIVE_BUCKET, caps: ARCHIVE_KEY_SCOPE.allowed, idSecret: 'B2_ARCHIVE_READ_KEY_ID', keySecret: 'B2_ARCHIVE_READ_KEY' },
  { name: LEDGER_KEY_NAME, bucket: LEDGER_BUCKET, caps: LEDGER_KEY_SCOPE.allowed, idSecret: 'B2_LEDGER_KEY_ID', keySecret: 'B2_LEDGER_KEY' },
];

function log(msg) {
  console.log(`[setup-backup-ledger] ${msg}`);
}

function fail(msg) {
  console.error(`[setup-backup-ledger] ERROR: ${msg}`);
  process.exit(1);
}

function parseDotEnv(path) {
  const out = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

function gh(args, input) {
  const r = spawnSync('gh', args, { input, encoding: 'utf8', stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
  if (r.error) fail(`could not run gh: ${r.error.message}`);
  return r;
}

async function listKeysByName(auth, keyName) {
  const found = [];
  let start;
  for (let page = 0; page < 1000; page++) {
    const data = await call(auth, 'b2_list_keys', { accountId: auth.accountId, maxKeyCount: 10000, ...(start ? { startApplicationKeyId: start } : {}) });
    found.push(...(data.keys ?? []).filter((k) => k.keyName === keyName));
    start = data.nextApplicationKeyId;
    if (!start) return found;
  }
  fail(`b2_list_keys did not finish while looking for ${keyName}`);
}

async function bucketByName(auth, bucketName) {
  const data = await call(auth, 'b2_list_buckets', { accountId: auth.accountId, bucketName });
  return (data.buckets ?? [])[0] ?? null;
}

async function main() {
  const repoArg = process.argv.indexOf('--repo');
  const repo = repoArg > 0 ? process.argv[repoArg + 1] : 'vaipakam/vaipakam';

  // 1. gh first, so no key is created that cannot be stored.
  const probe = gh(['secret', 'list', '--repo', repo]);
  if (probe.status !== 0) {
    fail(`gh cannot list the Actions secrets of ${repo} (${probe.stderr.trim().slice(0, 200)}). Sign in with an account that administers the repository, then run this again.`);
  }

  const env = parseDotEnv(resolve(REPO_ROOT, '.env'));
  if (!env.BACKBLAZE_MASTER_KEY_ID || !env.BACKBLAZE_MASTER_APP_KEY) {
    fail('BACKBLAZE_MASTER_KEY_ID and BACKBLAZE_MASTER_APP_KEY must both be set in the repo .env; creating a bucket and keys needs the master key.');
  }
  const auth = await authorize(env.BACKBLAZE_MASTER_KEY_ID, env.BACKBLAZE_MASTER_APP_KEY);
  if (!auth.capabilities.includes('writeKeys') || auth.bucketId) {
    fail('the key in BACKBLAZE_MASTER_* is not the account master key (it lacks writeKeys or is confined to a bucket).');
  }

  const archive = await bucketByName(auth, ARCHIVE_BUCKET);
  if (!archive) fail(`the archive bucket ${ARCHIVE_BUCKET} does not exist`);

  // 2. The ledger bucket, locked from birth.
  let ledger = await bucketByName(auth, LEDGER_BUCKET);
  if (ledger) {
    const lock = ledger.fileLockConfiguration;
    if (!lock?.isClientAuthorizedToRead || lock.value?.isFileLockEnabled !== true) {
      fail(`${LEDGER_BUCKET} exists without Object Lock. B2 enables it only at creation, so this bucket cannot be the ledger; delete it or choose another name (LEDGER_BUCKET, and the same name in .github/workflows/backup-ledger.yml).`);
    }
    if (ledger.bucketType !== 'allPrivate') fail(`${LEDGER_BUCKET} is ${ledger.bucketType}, not allPrivate`);
    log(`ledger bucket ${LEDGER_BUCKET} exists, private, with Object Lock. Reusing.`);
  } else {
    ledger = await call(auth, 'b2_create_bucket', { accountId: auth.accountId, bucketName: LEDGER_BUCKET, bucketType: 'allPrivate', fileLockEnabled: true });
    log(`created ledger bucket ${LEDGER_BUCKET}, private, with Object Lock.`);
  }
  const bucketIds = { [ARCHIVE_BUCKET]: archive.bucketId, [LEDGER_BUCKET]: ledger.bucketId };

  // 3 and 4. The keys, each stored as it is made.
  for (const k of KEYS) {
    const existing = await listKeysByName(auth, k.name);
    if (existing.length > 0) {
      const live = existing[0];
      const caps = [...(live.capabilities ?? [])].sort().join(',');
      if (live.bucketId !== bucketIds[k.bucket] || caps !== [...k.caps].sort().join(',') || live.namePrefix) {
        fail(`key ${k.name} exists with a different scope (bucket ${live.bucketId}, capabilities ${caps}). Revoke it in the B2 console and run this again.`);
      }
      log(`key ${k.name} exists with the expected scope. Its secret cannot be shown again, so ${k.idSecret} / ${k.keySecret} are left as they are.`);
      continue;
    }
    const made = await call(auth, 'b2_create_key', { accountId: auth.accountId, keyName: k.name, capabilities: k.caps, bucketId: bucketIds[k.bucket] });
    for (const [name, value] of [[k.idSecret, made.applicationKeyId], [k.keySecret, made.applicationKey]]) {
      const set = gh(['secret', 'set', name, '--repo', repo], value);
      if (set.status !== 0) {
        fail(`created key ${k.name} but could not store ${name} (${set.stderr.trim().slice(0, 200)}). Revoke ${k.name} in the B2 console and run this again.`);
      }
    }
    log(`created key ${k.name} and stored ${k.idSecret} and ${k.keySecret} in ${repo}.`);
  }

  log('done. Run the "Backup ledger" workflow once by hand (Actions, Run workflow) to record the archives that exist today.');
}

main().catch((e) => fail(e?.message ?? String(e)));
