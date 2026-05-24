#!/usr/bin/env node
/**
 * One-time Backblaze B2 account setup for the off-chain backup
 * pipeline. Runs LOCALLY on the operator's workstation — never in CF
 * or any Worker. Reads the master Application Key from the repo
 * `.env` (BACKBLAZE_KEY_ID + BACKBLAZE_APP_KEY) and performs four
 * idempotent steps:
 *
 *   1. Authorize with B2 native API and discover the account.
 *   2. Create the backup bucket (`vaipakam-offchain-data-archive` by
 *      default; private). Skipped if it already exists.
 *   3. Set lifecycle rules on three prefixes:
 *        archives/         30-day retention (nightly snapshots).
 *        archives-monthly/ 365-day retention (1st-of-month snapshots).
 *        archives-yearly/  indefinite (Jan-1 snapshots for the
 *                          legal-hold audit-trail durability story).
 *   4. Create TWO scoped Application Keys (one write-only for
 *      nightly backup, one read-only for weekly healthcheck), both
 *      bucket-scoped. Capabilities are deliberately tight — see the
 *      key-creation block in main() for the rationale (TL;DR: dropping
 *      `listFiles` from the write key is what makes the immutable-
 *      nonce naming actually protect against discovered/leaked
 *      uploader credentials).
 *
 * Why the master stays offline forever after this script runs:
 *   - The master Application Key has full account control (create /
 *     delete buckets, create / delete other keys, read / write / delete
 *     every file). If a CF compromise exfiltrates it, the attacker
 *     can wipe every backup. The scoped write-only key cannot.
 *   - B2's account-level master is the single load-bearing credential.
 *     Compromising the master is "lose Backblaze entirely". Compromising
 *     the scoped key is "lose the next 7 days of nightly backups but
 *     existing archives are safe".
 *
 * The script is idempotent — safe to re-run. Bucket creation returns
 * the existing bucket if one already exists; lifecycle rules are
 * overwritten with the same content on re-run; the Application Key
 * step is the only one that creates a NEW resource per invocation,
 * so the script aborts if a key with the same name already exists
 * (the operator can pass `--rotate-key` to force-create a new one
 * after first revoking the old).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../..');

// ── Defaults — overridable via env or CLI flags. ────────────────────
const DEFAULTS = {
  bucketName: 'vaipakam-offchain-data-archive',
  // Two scoped Application Keys (PR #248 round-2 follow-up to
  // Codex's healthcheck-can't-GET finding):
  //   write-only — nightly backup uploader.
  //   read-only  — weekly healthcheck verifier.
  // The cleavage keeps the nightly key incapable of leaking archive
  // contents; the healthcheck key gets read access but the
  // ciphertext stays AES-256-GCM-protected against the offline key.
  writeKeyName: 'vaipakam-offchain-data-archive-write-only',
  readKeyName: 'vaipakam-offchain-data-archive-read-only',
};

function parseDotEnv(path) {
  const text = readFileSync(path, 'utf8');
  const out = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[m[1]] = v;
  }
  return out;
}

function log(msg) {
  console.log(`[setup-backblaze] ${msg}`);
}

function fail(msg) {
  console.error(`[setup-backblaze] ERROR: ${msg}`);
  process.exit(1);
}

async function b2Authorize(keyId, appKey) {
  const auth = Buffer.from(`${keyId}:${appKey}`).toString('base64');
  const res = await fetch('https://api.backblazeb2.com/b2api/v3/b2_authorize_account', {
    headers: { authorization: `Basic ${auth}` },
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '<no body>');
    fail(`b2_authorize_account failed: ${res.status} ${txt.slice(0, 300)}`);
  }
  const data = await res.json();
  // v3 response shape — apiUrl + storageApi + s3Api are split.
  // We need the storageApi.apiUrl for native ops + s3Api for the
  // S3-compatible endpoint we'll print at the end.
  return {
    accountId: data.accountId,
    authToken: data.authorizationToken,
    apiUrl: data.apiInfo?.storageApi?.apiUrl ?? data.apiUrl,
    // B2 v3 returns the S3-compatible endpoint as `s3ApiUrl` under
    // `apiInfo.storageApi`. Older v2 responses may have used `.s3Api`
    // (kept as a defensive fallback) but `s3ApiUrl` is the current
    // field name. Returns a full URL ("https://s3.us-west-002…");
    // the Worker's wrangler.jsonc wants the bare host so we strip
    // the scheme at the call site.
    s3Endpoint:
      data.apiInfo?.storageApi?.s3ApiUrl ??
      data.apiInfo?.storageApi?.s3Api ??
      null,
    // Master-key cap check — abort hard if the configured key isn't
    // actually the master. A scoped key here would be a misconfig.
    allowedCapabilities: data.apiInfo?.storageApi?.capabilities ?? data.allowed?.capabilities ?? [],
    bucketId: data.apiInfo?.storageApi?.bucketId ?? data.allowed?.bucketId ?? null,
  };
}

// lgtm[js/file-data-in-outbound-network-request]
// codeql[js/file-data-in-outbound-network-request]
//
// CodeQL flags this because `apiUrl` traces back to B2's authorize
// response and `body` carries operator-controlled values from the
// repo `.env` (BACKBLAZE_KEY_ID + BACKBLAZE_APP_KEY) and the script's
// DEFAULTS at the top of the file. THIS IS THE INTENDED TRUST
// BOUNDARY:
//   - apiUrl comes from a Basic-authed response to
//     `b2_authorize_account` — if an attacker could MITM the
//     B2 auth response, they could already do worse things directly
//     with the master key they would have intercepted.
//   - body values (accountId, bucket name, key name) are
//     operator-controlled by design: the script's PURPOSE is to
//     turn operator-provided strings into B2 setup calls.
// A future reviewer should NOT "fix" this warning by stripping the
// dynamic URL composition — that would defeat the script's purpose.
// The dual suppression comments (lgtm + codeql) cover both the
// pre-2023 LGTM-style scanner and the current CodeQL scanner.
async function b2Post(apiUrl, authToken, path, body) {
  const res = await fetch(`${apiUrl}${path}`, {
    method: 'POST',
    headers: { authorization: authToken, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const txt = await res.text();
  let json;
  try { json = JSON.parse(txt); } catch { json = { raw: txt }; }
  return { ok: res.ok, status: res.status, json };
}

async function findBucketByName(apiUrl, authToken, accountId, bucketName) {
  const { ok, status, json } = await b2Post(apiUrl, authToken, '/b2api/v3/b2_list_buckets', {
    accountId,
    bucketName,
  });
  if (!ok) fail(`b2_list_buckets failed: ${status} ${JSON.stringify(json)}`);
  return (json.buckets ?? [])[0] ?? null;
}

async function createBucket(apiUrl, authToken, accountId, bucketName) {
  // Lifecycle rules applied via update-bucket below (separate step
  // so the same code path can re-set rules on an existing bucket).
  const { ok, status, json } = await b2Post(apiUrl, authToken, '/b2api/v3/b2_create_bucket', {
    accountId,
    bucketName,
    bucketType: 'allPrivate',
  });
  if (!ok) fail(`b2_create_bucket failed: ${status} ${JSON.stringify(json)}`);
  return json;
}

async function setLifecycleRules(apiUrl, authToken, accountId, bucketId) {
  // Tiered retention — see docs/DesignsAndPlans/OffChainDataResilience.md §3.4.
  //   archives/         — daily snapshots, 30-day retention.
  //   archives-monthly/ — 1st-of-month snapshots, 365-day retention.
  //   archives-yearly/  — Jan-1 snapshots, no rule (indefinite).
  // Manifests follow the matching prefix so a healthcheck can read
  // them at the same path that produced the archive.
  const rules = [
    {
      fileNamePrefix: 'archives/',
      daysFromUploadingToHiding: 30,
      daysFromHidingToDeleting: 1,
    },
    {
      fileNamePrefix: 'manifests/',
      daysFromUploadingToHiding: 30,
      daysFromHidingToDeleting: 1,
    },
    {
      fileNamePrefix: 'archives-monthly/',
      daysFromUploadingToHiding: 365,
      daysFromHidingToDeleting: 1,
    },
    {
      fileNamePrefix: 'manifests-monthly/',
      daysFromUploadingToHiding: 365,
      daysFromHidingToDeleting: 1,
    },
    // archives-yearly/ and manifests-yearly/ intentionally omitted —
    // no rule = indefinite retention.
  ];
  const { ok, status, json } = await b2Post(apiUrl, authToken, '/b2api/v3/b2_update_bucket', {
    accountId,
    bucketId,
    lifecycleRules: rules,
  });
  if (!ok) fail(`b2_update_bucket failed: ${status} ${JSON.stringify(json)}`);
  return json;
}

async function createScopedKey(apiUrl, authToken, accountId, bucketId, keyName, capabilities) {
  const { ok, status, json } = await b2Post(apiUrl, authToken, '/b2api/v3/b2_create_key', {
    accountId,
    capabilities,
    keyName,
    bucketId,
  });
  if (!ok) {
    if (json?.code === 'duplicate_key_name') {
      // Idempotency note: a duplicate-name failure is the script's
      // signal to abort cleanly rather than blow away the existing
      // key (B2 won't show the existing Application Key string a
      // second time, so a force-recreate would orphan the original
      // secret in CF). The operator handles rotation explicitly.
      fail(
        `Application Key named "${keyName}" already exists. To rotate, ` +
        `revoke the existing one in the B2 dashboard (or via ` +
        `b2_delete_key) and re-run. The original Application Key ` +
        `string cannot be retrieved from B2 after creation.`,
      );
    }
    fail(`b2_create_key failed: ${status} ${JSON.stringify(json)}`);
  }
  return json;
}

/**
 * Page through `b2_list_keys` until exhausted, then filter by name.
 * B2 returns up to 10,000 keys per page; the previous single-page
 * shape would miss matching keys on accounts with more total keys
 * than that and cause the idempotent flow to attempt creation +
 * abort with `duplicate_key_name`.
 */
async function listKeysByName(apiUrl, authToken, accountId, keyName) {
  const matches = [];
  let startApplicationKeyId = undefined;
  for (let page = 0; page < 1000; page++) {
    const body = { accountId, maxKeyCount: 10000 };
    if (startApplicationKeyId) body.startApplicationKeyId = startApplicationKeyId;
    const { ok, status, json } = await b2Post(apiUrl, authToken, '/b2api/v3/b2_list_keys', body);
    if (!ok) fail(`b2_list_keys (page ${page}) failed: ${status} ${JSON.stringify(json)}`);
    for (const k of json.keys ?? []) {
      if (k.keyName === keyName) matches.push(k);
    }
    startApplicationKeyId = json.nextApplicationKeyId;
    if (!startApplicationKeyId) return matches;
  }
  fail(
    `b2_list_keys exceeded 1000 pages while searching for "${keyName}". ` +
    `Account has > 10M application keys — investigate before re-running.`,
  );
}

/**
 * Verify a reused scoped key still matches the bucket + capabilities
 * we'd create it with. If the live key has drifted (different bucket,
 * different caps), the idempotent flow's "skip creation" path would
 * leave operators with credentials that fail later at runtime. Fail
 * loud here so the operator either revokes the drifted key (forcing
 * the script to re-create on the next run) or accepts the drift
 * explicitly.
 */
function verifyKeyMatches(key, expectedBucketId, expectedCaps) {
  if (key.bucketId !== expectedBucketId) {
    fail(
      `Existing key "${key.keyName}" (id ${key.applicationKeyId}) is scoped ` +
      `to bucket ${key.bucketId}, expected ${expectedBucketId}. Revoke + ` +
      `re-create or pass a different KEY_NAME env override to bypass.`,
    );
  }
  const live = new Set(key.capabilities ?? []);
  const expected = new Set(expectedCaps);
  const missing = expectedCaps.filter((c) => !live.has(c));
  const extra = [...live].filter((c) => !expected.has(c));
  if (missing.length > 0 || extra.length > 0) {
    fail(
      `Existing key "${key.keyName}" capabilities have drifted. ` +
      `expected: [${expectedCaps.join(', ')}]; got: [${[...live].join(', ')}]. ` +
      `${missing.length > 0 ? `missing: [${missing.join(', ')}]. ` : ''}` +
      `${extra.length > 0 ? `extra: [${extra.join(', ')}]. ` : ''}` +
      `Revoke + re-create the key to realign.`,
    );
  }
}

async function main() {
  const envPath = resolve(REPO_ROOT, '.env');
  let env;
  try {
    env = parseDotEnv(envPath);
  } catch (err) {
    fail(`Could not read ${envPath}: ${err.message}. Create from .env.example first.`);
  }

  const keyId = env.BACKBLAZE_KEY_ID;
  const appKey = env.BACKBLAZE_APP_KEY;
  if (!keyId || !appKey) {
    fail('BACKBLAZE_KEY_ID and BACKBLAZE_APP_KEY must both be set in .env');
  }

  const bucketName = process.env.BUCKET_NAME || DEFAULTS.bucketName;
  const writeKeyName = process.env.WRITE_KEY_NAME || DEFAULTS.writeKeyName;
  const readKeyName = process.env.READ_KEY_NAME || DEFAULTS.readKeyName;

  log('Authorizing with B2 master key...');
  const auth = await b2Authorize(keyId, appKey);

  // Sanity-check that this really IS the master. Scoped keys have a
  // restricted `capabilities` array; the master has every capability
  // including writeKeys / deleteKeys.
  if (!auth.allowedCapabilities.includes('writeKeys')) {
    fail(
      'Authorized key lacks `writeKeys` capability — this is NOT a master key. ' +
      'This setup script must be run with the master Application Key (the one ' +
      'B2 issued when you created the account). Stop and verify .env.',
    );
  }
  if (auth.bucketId) {
    fail(
      'Authorized key is scoped to a single bucket — this is NOT a master key. ' +
      'See above.',
    );
  }

  log(`Authorized. Account ID: ${auth.accountId}`);
  log(`Native API URL:   ${auth.apiUrl}`);
  log(`S3-compatible endpoint (for the Worker): ${auth.s3Endpoint}`);

  log(`Checking bucket "${bucketName}"...`);
  let bucket = await findBucketByName(auth.apiUrl, auth.authToken, auth.accountId, bucketName);
  if (bucket) {
    log(`Bucket already exists: ${bucket.bucketId} (${bucket.bucketType}). Reusing.`);
    if (bucket.bucketType !== 'allPrivate') {
      fail(
        `Existing bucket "${bucketName}" is "${bucket.bucketType}", expected "allPrivate". ` +
        `Delete the bucket manually and re-run.`,
      );
    }
  } else {
    log(`Creating bucket "${bucketName}" (allPrivate)...`);
    bucket = await createBucket(auth.apiUrl, auth.authToken, auth.accountId, bucketName);
    log(`Created bucket: ${bucket.bucketId}`);
  }

  log('Setting lifecycle rules (daily / monthly / indefinite-yearly retention)...');
  await setLifecycleRules(auth.apiUrl, auth.authToken, auth.accountId, bucket.bucketId);
  log('Lifecycle rules applied.');

  // Provision the two scoped Application Keys. The capability sets
  // are deliberately tight:
  //
  //   Write key  — `listBuckets` + `writeFiles` ONLY. NO `listFiles`.
  //     Without `listFiles`, a leaked uploader credential cannot
  //     ListObjectsV2 to enumerate the existing 32-hex-nonce keys
  //     and then PUT over them; their PUTs land at NEW keys with
  //     their own nonces, leaving the original archives untouched.
  //     The healthcheck catches the rogue uploads via SHA divergence.
  //     If we kept `listFiles` here, the immutable-nonce guarantee
  //     would collapse for a discovered/leaked write key.
  //
  //   Read key   — `listBuckets` + `listFiles` + `readFiles`. The
  //     healthcheck needs both list (paginated ListObjectsV2) and
  //     read (download the manifest + archive bytes for SHA check).
  //     A leaked read key yields AES-256-GCM ciphertext only; the
  //     offline encryption key blocks the plaintext.
  //
  // Both reuse paths verify the live key still matches the expected
  // bucket + capabilities — drift on either dimension would leave
  // the operator with credentials that fail later at runtime.
  log(`Checking for existing write-only key "${writeKeyName}"...`);
  const writeCaps = ['listBuckets', 'writeFiles'];
  const writeExisting = await listKeysByName(auth.apiUrl, auth.authToken, auth.accountId, writeKeyName);
  let newWriteKey = null;
  if (writeExisting.length > 0) {
    verifyKeyMatches(writeExisting[0], bucket.bucketId, writeCaps);
    log(`Write-only key "${writeKeyName}" already exists (id: ${writeExisting[0].applicationKeyId}) and matches expected bucket + caps. Skipping creation.`);
  } else {
    log(`Creating write-only key "${writeKeyName}" (scoped to bucket ${bucket.bucketId})...`);
    newWriteKey = await createScopedKey(
      auth.apiUrl,
      auth.authToken,
      auth.accountId,
      bucket.bucketId,
      writeKeyName,
      writeCaps,
    );
  }

  log(`Checking for existing read-only key "${readKeyName}"...`);
  const readCaps = ['listBuckets', 'listFiles', 'readFiles'];
  const readExisting = await listKeysByName(auth.apiUrl, auth.authToken, auth.accountId, readKeyName);
  let newReadKey = null;
  if (readExisting.length > 0) {
    verifyKeyMatches(readExisting[0], bucket.bucketId, readCaps);
    log(`Read-only key "${readKeyName}" already exists (id: ${readExisting[0].applicationKeyId}) and matches expected bucket + caps. Skipping creation.`);
  } else {
    log(`Creating read-only key "${readKeyName}" (scoped to bucket ${bucket.bucketId})...`);
    newReadKey = await createScopedKey(
      auth.apiUrl,
      auth.authToken,
      auth.accountId,
      bucket.bucketId,
      readKeyName,
      readCaps,
    );
  }

  console.log('\n========================================================================');
  console.log('SETUP COMPLETE. Plug the following into the Worker via `wrangler secret put`');
  console.log('and the `--var` flags below. Each Application Key STRING is shown ONCE — B2');
  console.log('never displays it again. Save the values to your offline secret store NOW.');
  console.log('========================================================================');
  console.log();
  if (newWriteKey) {
    console.log('# Write-only key (nightly backup):');
    console.log(`wrangler secret put B2_WRITE_ACCESS_KEY_ID`);
    console.log(`  Paste:  ${newWriteKey.applicationKeyId}`);
    console.log();
    console.log(`wrangler secret put B2_WRITE_SECRET_ACCESS_KEY`);
    console.log(`  Paste:  ${newWriteKey.applicationKey}`);
    console.log();
  } else {
    console.log('# Write-only key already exists; reusing. ' +
                'If you have lost the application-key string, rotate via:');
    console.log(`#   - revoke "${writeKeyName}" in B2 dashboard`);
    console.log('#   - re-run this script');
    console.log();
  }
  if (newReadKey) {
    console.log('# Read-only key (weekly healthcheck):');
    console.log(`wrangler secret put B2_READ_ACCESS_KEY_ID`);
    console.log(`  Paste:  ${newReadKey.applicationKeyId}`);
    console.log();
    console.log(`wrangler secret put B2_READ_SECRET_ACCESS_KEY`);
    console.log(`  Paste:  ${newReadKey.applicationKey}`);
    console.log();
  } else {
    console.log('# Read-only key already exists; reusing. Same rotation note as above.');
    console.log();
  }
  console.log(`# B2 endpoint + bucket — set as secrets too (region varies per account):`);
  console.log(`wrangler secret put B2_ENDPOINT`);
  console.log(`  Paste:  ${auth.s3Endpoint?.replace('https://', '') ?? '<set manually — see s3 endpoint in B2 dashboard>'}`);
  console.log();
  console.log(`wrangler secret put B2_BUCKET`);
  console.log(`  Paste:  ${bucketName}`);
  console.log();
  console.log('# Still to do (operator):');
  console.log("#   1. Generate AES-256 backup encryption key locally: `openssl rand -hex 32`");
  console.log('#      Save to 1Password / pass / paper backup. NEVER commit, NEVER paste in chat.');
  console.log('#   2. wrangler secret put BACKUP_ENCRYPTION_KEY <the 64-hex-char value>');
  console.log('#   3. wrangler secret put TG_OPS_BOT_TOKEN <Telegram bot token>');
  console.log('#   4. wrangler secret put TG_OPS_CHAT_ID <channel id, e.g. -1003903308626>');
  console.log('#   5. wrangler deploy');
  console.log();
  console.log('Setup script complete.');
}

main().catch((err) => fail(err.stack ?? err.message));
