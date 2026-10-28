#!/usr/bin/env node
/**
 * The backup watcher (#1469, #1473; design:
 * docs/DesignsAndPlans/BackupSecurityDesign.md §5, slice 1 of §8).
 *
 * Run daily by `.github/workflows/backup-ledger.yml`, an hour after the
 * nightly archive. Each run:
 *
 *   1. lists every VERSION in the archive bucket (archives and manifests, all
 *      three tiers) and every version in the ledger bucket;
 *   2. records each archive version the ledger has not seen: downloads it,
 *      computes its SHA-256 and length from the bytes (never copied from the
 *      manifest), compares them with its manifest, and writes one entry under
 *      a compliance-mode retention nobody can shorten;
 *   3. lengthens the retention of each yearly entry whose archive still
 *      exists and which has under a year left;
 *   4. re-reads the ledger, re-checks any manifest whose versions changed
 *      since its archive was recorded, and judges the whole picture
 *      (`lib/ledger-rules.mjs`): missing, ambiguous, replay, mismatch, ledger
 *      tampered, hidden early, deleted early, renewal failed.
 *
 * A problem is written to GITHUB_OUTPUT in the shape the shared alert job
 * reads (`problems`, `keys`), and the run exits 1. A run that cannot reach a
 * verdict (a missing secret, a key with the wrong authority, B2 down) exits 2
 * with no output, and the alert job then says the watcher is not running
 * rather than that a backup is broken.
 *
 * WHAT IT NEVER PRINTS. An archive's name. The run log, the summary and the
 * alert issue are public, and the random nonce in each archive's name is what
 * keeps a leaked write key from replacing that archive (design §4). Output
 * names tiers, periods and B2 file ids only; the names live in the private
 * ledger bucket.
 *
 * Environment:
 *   B2_ARCHIVE_READ_KEY_ID / B2_ARCHIVE_READ_KEY   the watcher's own read key,
 *       confined to the archive bucket (listFiles, readFiles)
 *   B2_LEDGER_KEY_ID / B2_LEDGER_KEY               the ledger key, confined to
 *       the ledger bucket, with no deleteFiles and no bypassGovernance
 *   ARCHIVE_BUCKET   default vaipakam-offchain-data-warm
 *   LEDGER_BUCKET    default vaipakam-offchain-backup-ledger
 *   ARCHIVE_FIRST_MONTHLY / ARCHIVE_FIRST_YEARLY   the committed first periods
 *   BACKUP_ACKNOWLEDGED   problem keys an operator investigated, comma-separated
 *
 * `--dry-run` reads and judges without writing an entry or a retention.
 */

import { appendFileSync, readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MAX_MANIFEST_BYTES, MAX_STORED_ARCHIVE_BYTES } from '../src/limits.ts';
import { TIERS, validateBaseline } from '../src/tiers.ts';
import { authorize, bytesById, digestById, extendRetention, listAllVersions, requireScope, uploadLocked } from './lib/b2-native.mjs';
import {
  MANIFEST_GRACE_MS,
  NOT_DIGESTED,
  boundedKeys,
  entryBody,
  entryFileInfo,
  entryName,
  judge,
  manifestCheck,
  manifestIdsField,
  parseAcknowledged,
  parseEntryName,
  readArchiveBucket,
  readLedger,
  renewalsDue,
  retentionFor,
  unrecorded,
} from './lib/ledger-rules.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/** What each key may hold. Anything outside the allowlist is refused. */
export const ARCHIVE_KEY_SCOPE = {
  label: 'archive read',
  allowed: ['listBuckets', 'listFiles', 'readFiles'],
  required: ['listFiles', 'readFiles'],
};
export const LEDGER_KEY_SCOPE = {
  label: 'ledger',
  allowed: ['listBuckets', 'listFiles', 'readFiles', 'writeFiles', 'readFileRetentions', 'writeFileRetentions'],
  required: ['listFiles', 'writeFiles', 'readFileRetentions', 'writeFileRetentions'],
};

function need(env, name) {
  const v = env[name];
  if (!v) throw new Error(`${name} is not set; the watcher has no ${name.includes('LEDGER') ? 'ledger' : 'archive'} key yet`);
  return v;
}

/**
 * One watcher run. Every input arrives as an argument (the environment, the
 * clock, the network), so the whole run is exercised by the tests against an
 * in-memory B2.
 *
 * @returns {Promise<{live: Array<{keys: string[], text: string}>, quieted: number,
 *   notes: string[], summary: string, written: object[], deferred: object[]}>}
 */
export async function runWatcher({ env = process.env, dryRun = false, now = Date.now(), fetchImpl = fetch, log = () => {} } = {}) {
  const io = { fetchImpl };
  const archiveBucket = env.ARCHIVE_BUCKET || 'vaipakam-offchain-data-warm';
  const ledgerBucket = env.LEDGER_BUCKET || 'vaipakam-offchain-backup-ledger';
  const lifecycle = JSON.parse(readFileSync(resolve(HERE, '../bucket-lifecycle.json'), 'utf8'));
  if (lifecycle.bucket !== archiveBucket) {
    throw new Error(`bucket-lifecycle.json declares ${lifecycle.bucket}, not ${archiveBucket}; the early-deletion check would judge the wrong rules`);
  }
  const baselineCheck = validateBaseline(
    { monthly: env.ARCHIVE_FIRST_MONTHLY || undefined, yearly: env.ARCHIVE_FIRST_YEARLY || undefined },
    now,
  );

  const archiveAuth = await authorize(need(env, 'B2_ARCHIVE_READ_KEY_ID'), need(env, 'B2_ARCHIVE_READ_KEY'), io);
  const archiveBucketId = requireScope(archiveAuth, { ...ARCHIVE_KEY_SCOPE, bucket: archiveBucket });
  const ledgerAuth = await authorize(need(env, 'B2_LEDGER_KEY_ID'), need(env, 'B2_LEDGER_KEY'), io);
  const ledgerBucketId = requireScope(ledgerAuth, { ...LEDGER_KEY_SCOPE, bucket: ledgerBucket });

  // 1. Both listings, every version.
  const archiveVersions = [];
  for (const spec of TIERS) {
    for (const prefix of [spec.archivePrefix, spec.manifestPrefix]) {
      archiveVersions.push(...(await listAllVersions(archiveAuth, archiveBucketId, prefix, io)));
    }
  }
  // The WHOLE ledger bucket, not only `entries/`: a name outside the prefix is
  // one the watcher never writes, and must be seen to be reported.
  const ledgerVersions = await listAllVersions(ledgerAuth, ledgerBucketId, '', io);
  const ledgerBefore = readLedger(ledgerVersions);
  const bucket = readArchiveBucket(archiveVersions);
  const ctx = {
    now,
    archiveBucket,
    // When the ledger began: its oldest version, or this run on an empty one.
    ledgerStartedAt: Math.min(now, ...ledgerVersions.map((v) => v.uploadTimestamp)),
    runUrl: env.GITHUB_RUN_ID ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` : null,
    commit: env.GITHUB_SHA ?? null,
  };

  // 2. Record what the ledger has not seen.
  const deferred = [];
  const written = [];
  for (const a of unrecorded(bucket, ledgerBefore.recorded)) {
    const manifestUploads = bucket.manifests.get(a.manifestName)?.uploads ?? [];
    if (manifestUploads.length === 0 && now - a.uploadTimestamp < MANIFEST_GRACE_MS) {
      deferred.push(a);
      continue;
    }
    const name = entryName(a.tier, a.period, a.fileId);
    if (!parseEntryName(name)) {
      // The watcher would then report its own entry as tampering.
      throw new Error(`the ${a.tier} archive for ${a.period} has a file id the ledger cannot name`);
    }
    // What the bucket holds is the input under test, so its size is judged,
    // never allowed to stop the run: an archive larger than the nightly can
    // write is recorded as such without downloading it, and a manifest too
    // large to be one is a bad manifest.
    const oversized = Number.isSafeInteger(a.contentLength) && a.contentLength > MAX_STORED_ARCHIVE_BYTES;
    const digest = oversized ? { sha256: NOT_DIGESTED, length: a.contentLength } : await digestById(archiveAuth, a.fileId, io);
    const manifests = [];
    for (const m of manifestUploads) {
      manifests.push({ bytes: await bytesById(archiveAuth, m.fileId, { ...io, maxBytes: MAX_MANIFEST_BYTES }), fileId: m.fileId, uploadTimestamp: m.uploadTimestamp });
    }
    const verdict = oversized ? { check: 'oversized', format: 'unknown', declared: null } : manifestCheck(digest, manifests);
    const record = {
      ...a,
      sha256: digest.sha256,
      length: digest.length,
      check: verdict.check,
      format: verdict.format,
      manifest: {
        key: a.manifestName,
        versions: manifests.map((m) => ({
          fileId: m.fileId,
          uploadTimestamp: m.uploadTimestamp,
          sha256: m.bytes == null ? null : createHash('sha256').update(m.bytes).digest('hex'),
          ...(m.bytes == null ? { refused: `larger than ${MAX_MANIFEST_BYTES} bytes` } : {}),
        })),
        declared: verdict.declared,
      },
    };
    const retainUntil = retentionFor(a.tier, now);
    if (!dryRun) {
      await uploadLocked(
        ledgerAuth,
        ledgerBucketId,
        {
          fileName: name,
          bytes: Buffer.from(`${JSON.stringify(entryBody(record, ctx), null, 2)}\n`),
          contentType: 'application/json',
          fileInfo: entryFileInfo(record),
          retainUntil,
        },
        io,
      );
    }
    written.push({ ...record, uploaded: record.uploadTimestamp, retainUntil, manifests: manifestIdsField(manifests.map((m) => m.fileId)) });
    log(`${dryRun ? 'would record' : 'recorded'} ${a.tier} ${a.period} (${a.fileId}): ${verdict.check}`);
  }

  // 3. Keep each yearly entry locked while its archive exists.
  const renewalFailures = [];
  for (const r of renewalsDue({ now, ledger: ledgerBefore, bucket })) {
    if (dryRun) {
      log(`would renew the ${r.period} yearly entry (${r.fileId})`);
      continue;
    }
    try {
      await extendRetention(ledgerAuth, { fileName: r.entryName, fileId: r.entryFileId, retainUntil: retentionFor('yearly', now) }, io);
      log(`renewed the ${r.period} yearly entry (${r.fileId})`);
    } catch (e) {
      renewalFailures.push({ fileId: r.fileId, period: r.period, error: String(e?.message ?? e).slice(0, 200) });
    }
  }

  // 4. Judge from the ledger as it now stands. After a write that is a fresh
  // listing, so the verdict rests on what B2 holds, not on what this run
  // believes it wrote.
  const ledger = dryRun
    ? { recorded: new Map([...ledgerBefore.recorded, ...written.map((r) => [r.fileId, r])]), tampered: ledgerBefore.tampered }
    : readLedger(await listAllVersions(ledgerAuth, ledgerBucketId, '', io));

  // Before judging, a manifest whose versions differ from the ones an entry
  // was checked against is checked again, against the digest the entry recorded: the
  // archive's bytes cannot have changed (a B2 version is immutable), but the
  // manifest beside it can be replaced.
  const manifestRechecks = new Map();
  const present = new Map(bucket.archives.map((a) => [a.fileId, a]));
  for (const r of ledger.recorded.values()) {
    const a = present.get(r.fileId);
    if (!a || r.sha256 === NOT_DIGESTED) continue;
    const uploads = bucket.manifests.get(a.manifestName)?.uploads ?? [];
    if (manifestIdsField(uploads.map((m) => m.fileId)) === r.manifests) continue;
    const manifests = [];
    for (const m of uploads) manifests.push({ bytes: await bytesById(archiveAuth, m.fileId, { ...io, maxBytes: MAX_MANIFEST_BYTES }) });
    manifestRechecks.set(r.fileId, manifestCheck({ sha256: r.sha256, length: r.length }, manifests).check);
  }

  const { problems, notes } = judge({
    now,
    ledger,
    bucket,
    lifecycle,
    baseline: baselineCheck.baseline,
    baselineErrors: baselineCheck.byTier,
    deferred,
    renewalFailures,
    manifestRechecks,
  });

  const acknowledged = parseAcknowledged(env.BACKUP_ACKNOWLEDGED);
  const live = problems
    .map((p) => ({ ...p, keys: p.keys.filter((k) => !acknowledged.has(k)) }))
    .filter((p) => p.keys.length > 0);
  const quieted = problems.length - live.length;
  const summary = summarise({ dryRun, bucket, ledger, written, deferred, notes, live, quieted });
  return { live, quieted, notes, summary, written, deferred };
}

/**
 * The run summary. The earliest current monthly and yearly periods are
 * printed as the values to commit for ARCHIVE_FIRST_* once the operator has
 * confirmed nothing older was ever written.
 */
function summarise({ dryRun, bucket, ledger, written, deferred, notes, live, quieted }) {
  const lines = [];
  lines.push(live.length > 0 ? '## Backup watcher: problems found' : '## Backup watcher: no problems');
  lines.push('');
  for (const p of live) lines.push(`- ${p.text}`);
  if (live.length > 0) lines.push('');
  lines.push(
    `${dryRun ? 'Dry run: would record' : 'Recorded'} ${written.length} archive version(s); ` +
      `the ledger holds ${ledger.recorded.size}; ${deferred.length} wait for a manifest; ` +
      `${quieted} problem(s) acknowledged.`,
  );
  for (const spec of TIERS.filter((t) => t.tier !== 'daily')) {
    const periods = bucket.archives.filter((a) => a.tier === spec.tier).map((a) => a.period).sort();
    lines.push(`Earliest ${spec.tier} archive present: ${periods[0] ?? 'none'}.`);
  }
  if (notes.length > 0) {
    lines.push('');
    for (const n of notes) lines.push(`- ${n}`);
  }
  return lines.join('\n');
}

const MAX_ALERT_LINES = 40;

/**
 * The verdict, in the shape `alert-issue.yml` reads. Each problem is one line,
 * and the heredoc delimiter is random, so no text can end the value early and
 * write a second output.
 */
function writeVerdict(live) {
  if (process.env.GITHUB_OUTPUT) {
    const delimiter = `EOF_${randomUUID()}`;
    // At most MAX_ALERT_LINES lines reach the alert issue; the rest are
    // counted, and every one is in the run summary. Every key is kept, so
    // the condition the issue tracks is whole.
    const lines = live.slice(0, MAX_ALERT_LINES).map((p) => p.text.replace(/[\r\n]+/g, ' ').slice(0, 500));
    if (live.length > MAX_ALERT_LINES) lines.push(`… and ${live.length - MAX_ALERT_LINES} more problem(s), listed in the run summary.`);
    const keys = boundedKeys(live.flatMap((p) => p.keys));
    appendFileSync(process.env.GITHUB_OUTPUT, `problems<<${delimiter}\n${lines.join('\n')}\n${delimiter}\nkeys=${keys}\n`);
  }
  process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const log = (line) => process.stdout.write(`${line}\n`);
  runWatcher({ dryRun: process.argv.includes('--dry-run'), log })
    .then(({ live, summary }) => {
      log(summary);
      if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
      if (live.length > 0) writeVerdict(live);
    })
    .catch((e) => {
      process.stderr.write(`backup watcher could not reach a verdict: ${e?.message ?? e}\n`);
      process.exit(2);
    });
}
