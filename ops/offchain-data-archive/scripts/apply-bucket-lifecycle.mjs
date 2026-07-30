#!/usr/bin/env node
/**
 * Declare, verify and apply the B2 archive bucket's lifecycle rules.
 *
 * WHY THIS EXISTS. The bucket's retention behaviour was live state that
 * existed nowhere in the repo. Nobody could review it, nothing detected drift
 * in it, and it took an ad-hoc API query to discover that superseded versions
 * were being deleted after ONE day — which is what made a forged archive
 * unrecoverable rather than merely detectable (#1469). Configuration that
 * only exists in a provider console is configuration nobody can be
 * accountable for.
 *
 * (An earlier draft of this comment claimed `OffChainRestore.md` §1 recreates
 * the bucket without lifecycle rules, making this a restore gap. That is
 * FALSE — B2 is the SURVIVING side of a Cloudflare-loss restore and is
 * correctly not recreated. The claim was corrected in the commit message and
 * left standing here, which is its own small instance of the two-copies
 * problem this file exists to fix.)
 *
 * The real second consequence is narrower and concerns SETUP, not restore:
 * `setup-backblaze.mjs` used to hardcode its own copy of these rules, so
 * rerunning the documented setup flow would silently revert a change applied
 * here. It now reads this declaration.
 *
 * WHAT THE NUMBERS MEAN, since `daysFromHidingToDeleting` is easy to
 * misread. It governs a version that is no longer current — either hidden by
 * the `daysFromUploadingToHiding` rule, or SUPERSEDED by a newer upload at
 * the same key. It was 1, and that is the value that matters for the threat
 * model in #1469: the archive Worker's WRITE key has `writeFiles` but NOT
 * `deleteFiles` (verified), so a compromised Worker can only OVERWRITE an
 * archive, never delete one. The genuine version therefore survives as a
 * hidden older version — until our own lifecycle rule removes it. At 1 day
 * that was effectively immediately, which is what made a detectable forgery an
 * unrecoverable one.
 *
 * (Two corrections to earlier revisions of this header, kept because both were
 * wrong in ways worth not repeating: it said raising the value "to 30" made
 * the archive "recoverable for a month" — the privacy-promise ceiling later
 * ruled 30 out, so no figure belongs in this file at all. And the sentence
 * "Note the same setting also extends how long ordinary hidden versions live,"
 * was left dangling mid-clause by the edit that removed its continuation.)
 *
 * Retention numbers and the promises that bound them live in
 * `lifecycle-policy.mjs` — deliberately NOT restated here, because the
 * previous copy of that explanation went stale in three places at once.
 *
 * USAGE
 *   node scripts/apply-bucket-lifecycle.mjs --check    # read-only, no writes
 *   node scripts/apply-bucket-lifecycle.mjs --print-live
 *   node scripts/apply-bucket-lifecycle.mjs --apply
 *
 * CREDENTIALS. Reads `BACKBLAZE_KEY_ID` / `BACKBLAZE_APP_KEY` from the
 * environment.
 *
 *   --check / --print-live need only `listBuckets`, so the ordinary
 *   bucket-scoped READ-ONLY key works. That is deliberate: drift must be
 *   observable without holding anything dangerous.
 *
 *   --apply needs `writeBuckets`, which NEITHER of the
 *   pipeline's two keys has, on purpose — the write key exists to push
 *   objects, not to reconfigure the bucket. Use a temporary key scoped to
 *   this bucket with `listBuckets` + `writeBuckets`, and delete it
 *   afterwards. `readBucketLifecycleRules` / `writeBucketLifecycleRules` are
 *   NOT B2 capabilities — asking for them makes the key creation fail, which
 *   is how the documented procedure came to be unfollowable. Do NOT reach for
 *   the master key: it also carries `deleteBuckets`, `deleteFiles` and
 *   `bypassGovernance`, none of which this task needs.
 */

import { readFileSync } from 'node:fs';
import { assertPolicyCeilings } from './lifecycle-policy.mjs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DECL = join(HERE, '..', 'bucket-lifecycle.json');

// CONFLICTING MODE FLAGS ARE REFUSED (#1471 r10). The precedence below is
// `--apply` first, so `--check --apply` (an operator appending a diagnostic to
// a retried command, say) silently WROTE production lifecycle state while
// reading like a dry run. Ranking modes is the wrong shape for flags whose
// blast radii differ this much.
{
  const picked = ['--apply', '--check', '--print-live'].filter((f) =>
    process.argv.includes(f),
  );
  if (picked.length > 1) {
    console.error(
      `Refusing to run: mutually exclusive modes given (${picked.join(' ')}). ` +
        'Pass exactly one of --print-live, --check, --apply. ' +
        '(--apply WRITES; the other two only read.)',
    );
    process.exit(2);
  }
}

const mode = process.argv.includes('--apply')
  ? 'apply'
  : process.argv.includes('--print-live')
    ? 'print'
    : 'check';

const keyId = process.env.BACKBLAZE_KEY_ID;
const appKey = process.env.BACKBLAZE_APP_KEY;
if (!keyId || !appKey) {
  console.error('Set BACKBLAZE_KEY_ID and BACKBLAZE_APP_KEY.');
  process.exit(2);
}

/** The four fields B2 round-trips, in a stable order, for comparison. */
function normalise(rules) {
  return [...rules]
    .map((r) => ({
      fileNamePrefix: r.fileNamePrefix,
      daysFromUploadingToHiding: r.daysFromUploadingToHiding ?? null,
      daysFromHidingToDeleting: r.daysFromHidingToDeleting ?? null,
      daysFromStartingToCancelingUnfinishedLargeFiles:
        r.daysFromStartingToCancelingUnfinishedLargeFiles ?? null,
    }))
    .sort((a, b) => a.fileNamePrefix.localeCompare(b.fileNamePrefix));
}

const fmt = (rules) =>
  normalise(rules)
    .map(
      // EVERY normalised field (#1471 r1). Omitting the
      // unfinished-large-file field meant a drift confined to it printed two
      // identical-looking blocks, leaving the operator unable to see what
      // `--apply` would change. A diff that does not show the difference is
      // worse than no diff.
      (r) =>
        `    ${r.fileNamePrefix.padEnd(22)} hide@${r.daysFromUploadingToHiding}d  ` +
        `delete@+${r.daysFromHidingToDeleting}d  ` +
        `cancelUnfinished@${r.daysFromStartingToCancelingUnfinishedLargeFiles ?? 'none'}`,
    )
    .join('\n');

async function b2(url, init = {}) {
  const res = await fetch(url, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    // B2's own message is safe to surface — it never echoes the app key.
    throw new Error(`${init.method ?? 'GET'} ${new URL(url).pathname}: ${body.code ?? res.status} ${body.message ?? ''}`.trim());
  }
  return body;
}

async function main() {
  // PARSING IS ALSO DEFERRED FOR print MODE (#1471 r10). An UNPARSEABLE
  // declaration is the most likely state while repairing one, and it broke
  // `--print-live` with a raw JSON syntax error — the same defect as the
  // malformed-`rules` case, one step earlier in the pipeline. Fixing only the
  // reported step would have left the class open.
  let declared;
  try {
    declared = JSON.parse(readFileSync(DECL, 'utf8'));
  } catch (err) {
    if (mode === 'print') {
      console.warn(
        `(bucket-lifecycle.json is unreadable: ${err.message} — printing live ` +
          `state anyway, which needs nothing from it.)`,
      );
      // Keep a bucket IDENTITY even here (#1471 r11). The documented print
      // command exports only the key pair, so `BACKBLAZE_BUCKET` is usually
      // unset — and an undefined `declared.bucket` made the later name
      // comparison reject the very bucket a scoped key had just listed. So
      // print mode resolves its target in order: the env var if set, else the
      // key's own scope (a bucket-scoped key can only see one bucket, which is
      // unambiguous), and it only insists on the env var for an account-wide
      // key, where the target genuinely is ambiguous.
      declared = { bucket: process.env.BACKBLAZE_BUCKET || null, rules: [] };
    } else {
      console.error(`bucket-lifecycle.json could not be parsed: ${err.message}`);
      process.exit(1);
    }
  }
  // `setup-backblaze.mjs` supports a `BUCKET_NAME` override — the README tells
  // forks to pick a unique name, since B2 bucket names are globally unique — so
  // setup can legitimately be operating on a bucket this declaration does not
  // name (#1471 r4). Without honouring it here, every print/check/apply on a
  // fork looks for the production bucket, a bucket-scoped key cannot see it,
  // and the failure reads as a permissions problem rather than a name mismatch.
  if (process.env.BUCKET_NAME) declared.bucket = process.env.BUCKET_NAME;

  const auth = await b2('https://api.backblazeb2.com/b2api/v3/b2_authorize_account', {
    headers: {
      Authorization: `Basic ${Buffer.from(`${keyId}:${appKey}`).toString('base64')}`,
    },
  });
  const api = auth.apiInfo.storageApi;
  const token = auth.authorizationToken;

  // REFUSE THE MASTER KEY (#1471 r9). The README spends a page justifying which
  // key each mode needs, and nothing enforced it — the sibling setup script
  // asserts the key IS the master, and this one accepted whatever was in the
  // environment. Since `.env` holds the master under the SAME two variable
  // names, one careless `set -a; . .env` ran bucket reconfiguration with
  // `deleteFiles`, `deleteBuckets` and `bypassGovernance` in hand. A document
  // cannot prevent that; this can.
  //
  // `writeKeys` is the master-only capability the setup script keys off, and an
  // account-wide key (no `bucketId`) is the other half of that signature.
  const caps = api.capabilities || [];
  if (caps.includes('writeKeys') || caps.includes('deleteBuckets')) {
    console.error(
      'Refusing to run: the supplied key looks like the MASTER key ' +
        `(capabilities include ${caps.includes('writeKeys') ? 'writeKeys' : 'deleteBuckets'}).\n` +
        'This task needs listBuckets for --print-live/--check, plus writeBuckets ' +
        'for --apply, and nothing else. The master key also carries deleteFiles, ' +
        'deleteBuckets, deleteKeys and bypassGovernance, which turn a mistyped ' +
        'lifecycle edit into potential data loss.\n' +
        'Do not source the repo `.env` for this — that is the master key\'s home. ' +
        'Export the read-only key for print/check, or a temporary ' +
        'listBuckets+writeBuckets key for apply.',
    );
    process.exit(2);
  }

  // A bucket-restricted key MUST scope b2_list_buckets, or B2 returns a bare
  // `unauthorized` that reads like a bad credential rather than a bad call.
  const bucketId = api.bucketId;
  const qs = new URLSearchParams({ accountId: auth.accountId });
  if (bucketId) qs.set('bucketId', bucketId);
  else if (declared.bucket) qs.set('bucketName', declared.bucket);
  else {
    console.error(
      'No bucket to inspect: the declaration is unreadable, BACKBLAZE_BUCKET is ' +
        'unset, and this key is account-wide so its scope does not identify one. ' +
        'Export BACKBLAZE_BUCKET, or use the bucket-scoped read-only key.',
    );
    process.exit(2);
  }

  const listed = await b2(`${api.apiUrl}/b2api/v3/b2_list_buckets?${qs}`, {
    headers: { Authorization: token },
  });
  // With a scoped key and an unreadable declaration there is exactly one
  // bucket in the response and no name to compare against; take it.
  const bucket = declared.bucket
    ? listed.buckets.find((b) => b.bucketName === declared.bucket)
    : listed.buckets[0];
  if (!bucket) {
    console.error(`Bucket ${declared.bucket} not found (key sees: ${listed.buckets.map((b) => b.bucketName).join(', ') || 'none'}).`);
    process.exit(1);
  }

  // An ABSENT `lifecycleRules` is not the same as "no rules" (#1471 r1).
  // B2 can omit the field for an under-permissioned key, and
  // treating that as an empty set would report permanent false drift on a
  // correctly configured bucket — then, under `--apply`, present a diff whose
  // "from" side is fiction.
  //
  // NOTE the review premise was narrower than stated: the pipeline read-only
  // key (`listBuckets, listFiles, readFiles`) DOES surface the field — checked
  // against the live bucket, which is how the drift in this PR was observed at
  // all. But "it happens to work with today's key" is not a reason to infer
  // from silence, so absence is now an explicit failure rather than a guess.
  if (bucket.lifecycleRules == null) {
    console.error(
      `${declared.bucket}: B2 returned no \`lifecycleRules\` field. That means the ` +
        'key cannot read them, NOT that none are set — this key needs ' +
        '`listBuckets` on a key permitted ' +
        'to see them). Refusing to report drift against an unknown live state.',
    );
    process.exit(2);
  }
  // SHAPE FIRST (#1471 r10). `assertPolicyCeilings` iterates `decl.rules`, so a
  // missing or malformed member surfaced as a raw TypeError ("Cannot read
  // properties of undefined") rather than as advice. Caught by running the
  // case rather than by reading the diff: my first attempt at this guard sat
  // below the ceiling check and never fired.
  if (mode !== 'print' && !Array.isArray(declared.rules)) {
    console.error(
      `bucket-lifecycle.json: \`rules\` is ${declared.rules === undefined ? 'missing' : 'not an array'}. ` +
        'Fix the declaration — `--print-live` still works and needs nothing from it.',
    );
    process.exit(1);
  }

  // Ceilings live in ONE module both writers import — see lifecycle-policy.mjs
  // for the promises, the arithmetic, and why each bound is what it is. The
  // first version of this check lived only here, which left the setup script
  // free to push a violating declaration to production (#1471 r5).
  // NOT for `--print-live` (#1471 r6). That mode reports what B2 currently
  // has and does not consult the declaration at all, so refusing to run it
  // because the declaration is invalid removes the one diagnostic an operator
  // needs WHILE fixing an invalid declaration — and while live may itself be
  // the thing out of policy. A read-only report must never be gated on the
  // validity of something it does not read.
  // The mode VALUE is 'print' — '--print-live' is the flag. Guarding on the
  // flag name here would have been a no-op that read as a fix.
  if (mode !== 'print') {
    assertPolicyCeilings(declared, (msg) => {
      console.error(msg);
      process.exit(1);
    });
  }

  const live = normalise(bucket.lifecycleRules);

  // PRINT BEFORE TOUCHING THE DECLARATION (#1471 r10). `--print-live` reports
  // live state and does not consult the declaration, so normalising it first
  // meant a missing or malformed `rules` member threw before the print branch
  // was reached — defeating r6's whole point, which was that the one
  // diagnostic an operator needs while REPAIRING a broken declaration must not
  // depend on that declaration being valid. r6 skipped the ceiling check for
  // this mode and left the parse in the shared path; same intent, one line
  // further down.
  if (mode === 'print') {
    console.log(`live rules on ${bucket.bucketName}:`);
    console.log(fmt(live) || '    (none — B2 default: every version kept forever)');
    return 0;
  }

  const want = normalise(declared.rules);

  const same = JSON.stringify(live) === JSON.stringify(want);

  if (mode === 'check') {
    if (same) {
      console.log(`bucket lifecycle: live rules MATCH bucket-lifecycle.json.`);
      return 0;
    }
    console.error('bucket lifecycle: DRIFT — live rules differ from the declaration.\n');
    console.error('  live:');
    console.error(fmt(live) || '    (none)');
    console.error('\n  declared:');
    console.error(fmt(want));
    console.error('\nApply with --apply (needs a key with `writeBuckets`; `readBucketLifecycleRules` / `writeBucketLifecycleRules` are not B2 capabilities), or update the declaration if the live state is intended.');
    return 1;
  }

  // ── apply ────────────────────────────────────────────────────────────
  if (same) {
    console.log('bucket lifecycle: already matches the declaration; nothing to do.');
    return 0;
  }
  console.log('applying:\n  from:');
  console.log(fmt(live) || '    (none)');
  console.log('  to:');
  console.log(fmt(want));

  await b2(`${api.apiUrl}/b2api/v3/b2_update_bucket`, {
    method: 'POST',
    headers: { Authorization: token, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      accountId: auth.accountId,
      bucketId: bucket.bucketId,
      lifecycleRules: want,
    }),
  });

  // Read back rather than trusting the write — the whole point of codifying
  // this is not to have to take the provider's word for the live state.
  const after = await b2(`${api.apiUrl}/b2api/v3/b2_list_buckets?${qs}`, {
    headers: { Authorization: token },
  });
  // NO `?? []` here (#1471 r9). The guard ~80 lines above hard-exits on an
  // absent `lifecycleRules` precisely because absent means "cannot read them",
  // not "none are set" — and coercing to an empty set on the READBACK path
  // would let a write that silently applied nothing report a mismatch against
  // `[]` instead of saying the readback could not be performed. Same field,
  // same ambiguity, opposite handling, in one file.
  const afterBucket = after.buckets.find((b) => b.bucketName === declared.bucket);
  if (!afterBucket || afterBucket.lifecycleRules == null) {
    console.error(
      `applied, but the READBACK could not be performed: B2 returned ` +
        `${afterBucket ? 'no `lifecycleRules` field' : 'no such bucket'} for ` +
        `${declared.bucket}. The write reported success and is UNVERIFIED — ` +
        `re-run with --check using a key that can read the rules before ` +
        `treating this as applied.`,
    );
    process.exit(1);
  }
  const now = normalise(afterBucket.lifecycleRules);
  if (JSON.stringify(now) !== JSON.stringify(want)) {
    console.error('applied, but the READBACK does not match the declaration:');
    console.error(fmt(now));
    return 1;
  }
  console.log('applied and verified by readback.');
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(String(err.message ?? err));
    process.exit(1);
  },
);
