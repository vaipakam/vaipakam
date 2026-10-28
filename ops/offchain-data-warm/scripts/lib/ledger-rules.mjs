/**
 * The backup ledger's rules: what an entry is, and what the watcher pages on
 * (#1469, #1473; design: docs/DesignsAndPlans/BackupSecurityDesign.md §5).
 *
 * Pure, and kept apart from the network calls in `../backup-ledger.mjs`, so every
 * rule here is pinned by `backup-ledger.test.mjs` without a B2 account.
 *
 * WHAT THE LEDGER IS. A separate B2 bucket with Object Lock, written only by
 * the watcher, one entry per archive VERSION, each under a compliance-mode
 * retention nobody can shorten. The archive Worker holds no key to it. So the
 * ledger records when each archive first existed and what its bytes were, in
 * a record the Worker cannot write and nobody can rewrite.
 *
 * HOW IT IS READ. Always as its full version list. Object Lock protects each
 * stored version, not what a plain listing shows as current: the ledger key can
 * still add a second version at a name, or hide one. Every reader therefore
 * lists all versions and treats a name with more than one version, or any hide
 * marker, as tampering.
 */

import { TIERS, classifyListing, isRealPeriod, periodOf } from '../../src/tiers.ts';

export const LEDGER_PREFIX = 'entries/';
const DAY = 86_400_000;

/**
 * Entry retention, as the defaults the design states for the owner to confirm.
 * A daily or monthly entry outlives the longest life of the archives it can
 * describe (12 months). A yearly entry is kept ten years and renewed while its
 * archive exists, because the yearly archives have no lifecycle rule at all.
 */
export const ENTRY_RETENTION_DAYS = 400;
export const YEARLY_RETENTION_DAYS = 3653;
export const YEARLY_RENEW_BELOW_DAYS = 365;
/**
 * Slack on the retention a stored entry must carry. The watcher sets the
 * deadline from its own clock and B2 stamps the upload from its own, so the
 * two can differ by seconds; a day absorbs that without admitting an entry
 * whose retention was set short on purpose.
 */
const RETENTION_SLACK_MS = DAY;

/**
 * How long an archive may wait for its manifest before it is recorded without
 * one. The Worker uploads the archive first and the manifest straight after,
 * so a run that lands between the two must not record the pair as broken.
 */
export const MANIFEST_GRACE_MS = 2 * 60 * 60 * 1000;

/** The only archive format before the public-key switch (design §3). */
export const LEGACY_FORMAT = 'legacy-aes-256-gcm';

const NONCE = /^[0-9a-f]{32}$/;
const FILE_ID = /^[A-Za-z0-9_-]{1,200}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const TIER_NAMES = TIERS.map((t) => t.tier);

/** A name under one tier's prefix: `<prefix><period>/<nonce><suffix>`. */
function parseUnder(fileName, prefixOf, suffix) {
  for (const spec of TIERS) {
    const prefix = prefixOf(spec);
    if (!fileName.startsWith(prefix)) continue;
    const m = /^([^/]+)\/([^/]+)$/.exec(fileName.slice(prefix.length));
    if (!m || !m[2].endsWith(suffix)) return null;
    const nonce = m[2].slice(0, -suffix.length);
    if (!isRealPeriod(spec.tier, m[1]) || !NONCE.test(nonce)) return null;
    return { spec, tier: spec.tier, period: m[1], nonce };
  }
  return null;
}

/** An archive name the Worker writes, or null. */
export function parseArchiveName(fileName) {
  const p = parseUnder(fileName, (s) => s.archivePrefix, '.bin');
  return p && { ...p, manifestName: `${p.spec.manifestPrefix}${p.period}/${p.nonce}.json` };
}

/** A manifest name the Worker writes, or null. */
export function parseManifestName(fileName) {
  const p = parseUnder(fileName, (s) => s.manifestPrefix, '.json');
  return p && { ...p, archiveName: `${p.spec.archivePrefix}${p.period}/${p.nonce}.bin` };
}

/**
 * One entry per archive version, named by the version's B2 file id, which is
 * unique per upload. So the honest watcher writes each name exactly once.
 */
export function entryName(tier, period, fileId) {
  return `${LEDGER_PREFIX}${tier}/${period}/${fileId}.json`;
}

export function parseEntryName(name) {
  const m = /^entries\/([a-z]+)\/([^/]+)\/([^/]+)\.json$/.exec(name);
  if (!m || !TIER_NAMES.includes(m[1]) || !isRealPeriod(m[1], m[2]) || !FILE_ID.test(m[3])) return null;
  return { tier: m[1], period: m[2], fileId: m[3] };
}

/** The deadline a new entry is written with. */
export function retentionFor(tier, nowMs) {
  return nowMs + (tier === 'yearly' ? YEARLY_RETENTION_DAYS : ENTRY_RETENTION_DAYS) * DAY;
}

/** The least retention a stored entry may carry, from its own upload time. */
export function minimumRetention(tier, entryUploadedMs) {
  return retentionFor(tier, entryUploadedMs) - RETENTION_SLACK_MS;
}

/**
 * The manifest verdict on one archive, from its bytes and its manifest.
 *
 * @param {{sha256: string, length: number}} archive computed by the watcher
 * @param {Array<{bytes: Buffer}>} manifests every uploaded version of the
 *        sibling manifest name
 */
export function manifestCheck(archive, manifests) {
  if (manifests.length === 0) return { check: 'no-manifest', format: 'unknown', declared: null };
  if (manifests.length > 1) return { check: 'ambiguous-manifest', format: 'unknown', declared: null };
  let m;
  try {
    m = JSON.parse(manifests[0].bytes.toString('utf8'));
  } catch {
    return { check: 'bad-manifest', format: 'unknown', declared: null };
  }
  const a = m?.archive;
  if (!a || typeof a.sha256 !== 'string' || !Number.isInteger(a.byteLength)) {
    return { check: 'bad-manifest', format: 'unknown', declared: null };
  }
  const declared = { sha256: a.sha256, byteLength: a.byteLength, encryption: a.encryption ?? null };
  const format = a.encryption === 'AES-256-GCM' ? LEGACY_FORMAT : 'unknown';
  if (a.sha256 !== archive.sha256) return { check: 'sha-mismatch', format, declared };
  if (a.byteLength !== archive.length) return { check: 'length-mismatch', format, declared };
  return { check: 'match', format, declared };
}

const CHECKS = ['match', 'sha-mismatch', 'length-mismatch', 'no-manifest', 'bad-manifest', 'ambiguous-manifest'];
const FORMATS = [LEGACY_FORMAT, 'unknown'];

/**
 * The fields every reader needs, carried as B2 file info so the ledger listing
 * alone answers the daily checks, without downloading every entry every day.
 * Every value is plain ASCII, so B2's header encoding never changes it. The
 * entry body carries the same facts and more, for a human or a restore.
 */
export function entryFileInfo(r) {
  return {
    tier: r.tier,
    period: r.period,
    nonce: r.nonce,
    sha256: r.sha256,
    length: String(r.length),
    uploaded: String(r.uploadTimestamp),
    check: r.check,
    format: r.format,
    // The manifest versions the check was made against, so a later run can
    // tell when the manifest beside a recorded archive has changed.
    manifests: manifestIdsField(r.manifest.versions.map((m) => m.fileId)),
  };
}

const MANIFEST_IDS = /^(-|[A-Za-z0-9_-]{1,200}(\.[A-Za-z0-9_-]{1,200})*)$/;

/** Manifest version ids as one ASCII file-info value: dot-joined, `-` for none. */
export function manifestIdsField(ids) {
  return ids.length === 0 ? '-' : [...ids].sort().join('.');
}

/** The file info of one stored entry version, or null when it is not one the watcher writes. */
export function readEntryInfo(v, named) {
  const i = v.fileInfo ?? {};
  const length = Number(i.length);
  const uploaded = Number(i.uploaded);
  if (
    i.tier !== named.tier ||
    i.period !== named.period ||
    !NONCE.test(i.nonce ?? '') ||
    !SHA256.test(i.sha256 ?? '') ||
    !Number.isSafeInteger(length) ||
    length < 0 ||
    !Number.isSafeInteger(uploaded) ||
    !CHECKS.includes(i.check) ||
    !FORMATS.includes(i.format) ||
    !MANIFEST_IDS.test(i.manifests ?? '')
  ) {
    return null;
  }
  return { tier: i.tier, period: i.period, nonce: i.nonce, sha256: i.sha256, length, uploaded, check: i.check, format: i.format, manifests: i.manifests };
}

/** The entry body: everything the file info holds, plus provenance. */
export function entryBody(r, ctx) {
  return {
    kind: 'vaipakam-backup-ledger-entry',
    version: 1,
    tier: r.tier,
    period: r.period,
    nonce: r.nonce,
    archive: {
      bucket: ctx.archiveBucket,
      key: r.archiveName,
      fileId: r.fileId,
      uploadTimestamp: r.uploadTimestamp,
      uploadedAt: new Date(r.uploadTimestamp).toISOString(),
      byteLength: r.length,
      sha256: r.sha256,
    },
    manifest: r.manifest,
    check: r.check,
    format: r.format,
    recordedAt: new Date(ctx.now).toISOString(),
    // An archive uploaded before the ledger existed is recorded as found when
    // the ledger began: its entry proves it has not changed since then, not
    // that it was genuine before (design §6). `recordedAt` beside the upload
    // time shows any later gap, such as days the watcher did not run.
    discovery: r.uploadTimestamp < ctx.ledgerStartedAt ? 'before-ledger' : 'routine',
    writtenBy: { run: ctx.runUrl ?? null, commit: ctx.commit ?? null },
  };
}

function newestFirst(a, b) {
  return b.uploadTimestamp - a.uploadTimestamp || (a.fileId < b.fileId ? 1 : -1);
}

/** Versions grouped by name, uploads and hides apart, newest first. */
export function groupByName(versions) {
  const out = new Map();
  for (const v of versions) {
    const g = out.get(v.fileName) ?? { uploads: [], hides: [], other: [] };
    (v.action === 'upload' ? g.uploads : v.action === 'hide' ? g.hides : g.other).push(v);
    out.set(v.fileName, g);
  }
  for (const g of out.values()) {
    g.uploads.sort(newestFirst);
    g.hides.sort(newestFirst);
  }
  return out;
}

/** Is a name current: its newest version an upload, not a hide marker? */
function isCurrent(g) {
  const newestUpload = g.uploads[0];
  if (!newestUpload) return false;
  const newestHide = g.hides[0];
  return !newestHide || newestHide.uploadTimestamp < newestUpload.uploadTimestamp;
}

/**
 * The ledger as recorded: one record per archive file id, and every name that
 * shows tampering.
 *
 * A name with more than one version or a hide marker is tampering, because the
 * honest watcher writes each name once. So is a version whose retention is not
 * compliance mode or is shorter than the watcher sets, and a name or file info
 * the watcher does not write. When a name is tampered, its OLDEST upload is
 * still the record: Object Lock means the genuine first version cannot have
 * been removed, so it is always there to read.
 */
export function readLedger(ledgerVersions) {
  const recorded = new Map();
  const tampered = [];
  for (const [name, g] of groupByName(ledgerVersions)) {
    const named = parseEntryName(name);
    if (!named) {
      tampered.push({ name, why: 'a name the watcher never writes' });
      continue;
    }
    if (g.uploads.length > 1) tampered.push({ name, why: `${g.uploads.length} versions` });
    if (g.hides.length > 0) tampered.push({ name, why: 'a hide marker' });
    if (g.other.length > 0) tampered.push({ name, why: 'an unfinished upload' });
    const oldest = g.uploads[g.uploads.length - 1];
    if (!oldest) continue;
    for (const v of g.uploads) {
      const r = v.fileRetention;
      if (!r?.isClientAuthorizedToRead) {
        throw new Error(`cannot read the retention of ${name}: the ledger key lacks readFileRetentions`);
      }
      const until = r.value?.retainUntilTimestamp;
      if (r.value?.mode !== 'compliance' || !Number.isFinite(until) || until < minimumRetention(named.tier, v.uploadTimestamp)) {
        tampered.push({ name, why: `retention ${r.value?.mode ?? 'none'} until ${Number.isFinite(until) ? new Date(until).toISOString() : 'unset'}` });
      }
    }
    const info = readEntryInfo(oldest, named);
    if (!info) {
      tampered.push({ name, why: 'file info the watcher never writes' });
      continue;
    }
    recorded.set(named.fileId, {
      ...info,
      fileId: named.fileId,
      entryName: name,
      entryFileId: oldest.fileId,
      retainUntil: oldest.fileRetention?.value?.retainUntilTimestamp ?? null,
    });
  }
  return { recorded, tampered };
}

/**
 * The archive bucket as listed: every archive upload version, grouped and
 * parsed, and the names a tier listing should see as current.
 */
export function readArchiveBucket(archiveVersions) {
  const groups = groupByName(archiveVersions);
  const archives = [];
  const manifests = new Map();
  const currentManifests = new Map(TIERS.map((t) => [t.tier, []]));
  const currentArchives = new Map(TIERS.map((t) => [t.tier, []]));
  // Every upload and hide time at each archive name, so a version's end as
  // the current one (superseded or hidden) can be read back.
  const changes = new Map();
  const hideTimes = new Map();
  for (const [name, g] of groups) {
    changes.set(name, [...g.uploads, ...g.hides].map((v) => v.uploadTimestamp).sort((a, b) => a - b));
    hideTimes.set(name, g.hides.map((v) => v.uploadTimestamp).sort((a, b) => a - b));
    const a = parseArchiveName(name);
    if (a) {
      for (const v of g.uploads) archives.push({ ...a, archiveName: name, fileId: v.fileId, uploadTimestamp: v.uploadTimestamp, versions: g.uploads.length });
      if (isCurrent(g)) currentArchives.get(a.tier).push(name);
      continue;
    }
    const m = parseManifestName(name);
    if (m) {
      manifests.set(name, { ...m, uploads: g.uploads });
      if (isCurrent(g)) currentManifests.get(m.tier).push(name);
    }
  }
  return { archives, manifests, currentArchives, currentManifests, changes, hideTimes };
}

/** The archive versions the ledger has not recorded, oldest first. */
export function unrecorded(bucket, recorded) {
  return bucket.archives
    .filter((a) => !recorded.has(a.fileId))
    .sort((a, b) => a.uploadTimestamp - b.uploadTimestamp);
}

/**
 * The declared lifecycle for `prefix`, in days: `hide` after upload, then
 * `del` after the version stops being current. A prefix with no rule (the
 * yearly tier) is never hidden or deleted by the lifecycle.
 */
export function lifecycleTerms(lifecycle, prefix) {
  const rule = lifecycle.rules.find((r) => r.fileNamePrefix === prefix);
  if (!rule || rule.daysFromUploadingToHiding == null) return { hide: Infinity, del: Infinity };
  return { hide: rule.daysFromUploadingToHiding, del: rule.daysFromHidingToDeleting ?? 0 };
}

/**
 * When a version at `name` uploaded at `uploaded` stopped being current: the
 * first upload or hide marker after it at the same name, if the listing still
 * shows one.
 */
export function noncurrentAt(bucket, name, uploaded) {
  return (bucket.changes.get(name) ?? []).find((t) => t > uploaded) ?? null;
}

/**
 * The earliest time the declared lifecycle could delete a version. A version
 * stops being current at its age-hide time, or earlier when it was
 * superseded or hidden, and is deleted `del` days after that (B2 counts the
 * second term from when the version stopped being current, not from upload).
 */
export function earliestLifecycleDeletion(terms, uploaded, endedAt) {
  if (terms.hide === Infinity) return Infinity;
  const end = Math.min(uploaded + terms.hide * DAY, endedAt ?? Infinity);
  return end + terms.del * DAY;
}

/**
 * The January pair the current Worker writes: the same encrypted bytes as the
 * monthly for `<year>-01` and the yearly for `<year>`, under one nonce. Only
 * that pair, in the legacy format, is an honest copy; any other equal pair is
 * a replay. The public-key format encrypts each tier on its own, so it never
 * produces one.
 */
export function isLegacyJanuaryPair(a, b) {
  if (a.format !== LEGACY_FORMAT || b.format !== LEGACY_FORMAT || a.nonce !== b.nonce) return false;
  const [m, y] = a.tier === 'monthly' ? [a, b] : [b, a];
  return m.tier === 'monthly' && y.tier === 'yearly' && m.period === `${y.period}-01`;
}

const CHECK_TEXT = {
  'sha-mismatch': "its bytes do not match its manifest's SHA-256",
  'length-mismatch': "its length does not match its manifest's",
  'no-manifest': 'it has no manifest beside it',
  'bad-manifest': 'its manifest cannot be read',
  'ambiguous-manifest': 'its manifest name holds more than one version',
};

/**
 * Every problem the watcher pages on, judged from the two listings alone.
 *
 * Each problem has stable `keys` (no ages or counts), so a condition that
 * lasts is not re-announced and a changed one is, and so an operator can
 * acknowledge a key in a reviewed commit. Problem text names tiers, periods
 * and B2 file ids, never an archive's name: the alert issue is public, and the
 * nonce in an archive's name is what keeps a leaked write key from replacing
 * it (design §4).
 */
export function judge({ now, ledger, bucket, lifecycle, baseline, baselineErrors = {}, deferred = [], renewalFailures = [], manifestRechecks = new Map() }) {
  const problems = [];
  const notes = [];
  // A problem carries one or more stable keys: the alert re-notifies when the
  // key set changes, so a condition that grows (a second missing day) is news.
  const add = (keyOrKeys, text) => {
    const keys = [keyOrKeys].flat().map(safeKey);
    if (keys.every((k) => problems.some((p) => p.keys.includes(k)))) return;
    problems.push({ keys, text });
  };

  // A committed first period that is not a real, past period turns that tier's
  // deletion check off silently, so it is a problem in its own right; the
  // other tiers are still judged.
  for (const [tier, msg] of Object.entries(baselineErrors)) add(`baseline:${tier}`, `Baseline invalid: ${msg}.`);

  // Ledger tampered.
  // A tampered name can be anything the ledger key chose, and the alert issue
  // is public, so the text carries it narrowed to the characters a genuine
  // entry name uses: no mention, link or markup reaches the issue through it.
  for (const t of ledger.tampered) {
    const shown = String(t.name).replace(/[^0-9A-Za-z_./-]/g, '?').slice(0, 200);
    add(`ledger-tampered:${t.name}`, `Ledger tampered: ${shown} has ${t.why}. The honest watcher never writes that.`);
  }

  // Missing: the same tier rules the healthcheck runs, on what is current.
  for (const spec of TIERS) {
    const v = classifyListing(
      spec,
      { ok: true, keys: bucket.currentManifests.get(spec.tier) },
      now,
      baseline,
      { ok: true, keys: bucket.currentArchives.get(spec.tier) },
    );
    if (v.ok === false) {
      // Monthly and yearly are keyed per missing period, so a period that
      // goes missing while an older one still is gets announced. The daily
      // rule names the last three days, which move every day, so it keeps one
      // key: a lasting daily outage is one condition, not a new one each day.
      const present = [...new Set(bucket.currentManifests.get(spec.tier).map((k) => periodOf(spec, k)).filter(Boolean))].sort();
      const periods = spec.tier === 'daily' ? [] : spec.missingRequired(present, now, baseline);
      const keys = periods.length > 0 ? periods.map((p) => `missing:${spec.tier}:${p}`) : [`missing:${spec.tier}`];
      add(keys, `Missing: ${v.reason}.`);
    } else if (v.absent) {
      notes.push(`${spec.tier}: ${v.reason}`);
    }
    if (v.degraded) notes.push(`${spec.tier}: ${v.degraded}`);
  }

  // Ambiguous period: more than one archive, or a manifest name written twice.
  const perPeriod = new Map();
  for (const a of bucket.archives) {
    const k = `${a.tier}:${a.period}`;
    perPeriod.set(k, (perPeriod.get(k) ?? 0) + 1);
  }
  for (const m of bucket.manifests.values()) {
    if (m.uploads.length > 1) perPeriod.set(`${m.tier}:${m.period}`, Math.max(2, perPeriod.get(`${m.tier}:${m.period}`) ?? 0));
  }
  for (const [k, n] of perPeriod) {
    if (n > 1) add(`ambiguous:${k}`, `Ambiguous period: ${k.replace(':', ' ')} holds more than one archive or manifest version. The nightly writes exactly one.`);
  }

  // An entry must describe the archive version it is named for. The ledger key
  // can write an entry before the watcher does; one whose tier, period, nonce
  // or upload time differs from the archive's own was not written from it.
  const byId = new Map(bucket.archives.map((a) => [a.fileId, a]));
  for (const r of ledger.recorded.values()) {
    const a = byId.get(r.fileId);
    if (a && (a.tier !== r.tier || a.period !== r.period || a.nonce !== r.nonce || a.uploadTimestamp !== r.uploaded)) {
      add(
        `ledger-tampered:${r.entryName ?? entryName(r.tier, r.period, r.fileId)}`,
        `Ledger tampered: the entry for ${r.fileId} does not describe that archive (it names ${r.tier} ${r.period}, uploaded ${new Date(r.uploaded).toISOString()}).`,
      );
    }
  }

  // Mismatch and replay, for every recorded archive still in the bucket.
  const present = new Set(bucket.archives.map((a) => a.fileId));
  const all = [...ledger.recorded.values()];
  for (const r of all) {
    if (!present.has(r.fileId)) continue;
    // The manifest as it stands now: re-checked by the caller when its
    // versions differ from the ones recorded, else the recorded verdict.
    const check = manifestRechecks.get(r.fileId) ?? r.check;
    const again = manifestRechecks.has(r.fileId) ? ' since it was recorded, its manifest changed and' : '';
    if (check !== 'match') add(`mismatch:${r.fileId}`, `Mismatch: the ${r.tier} archive for ${r.period} (${r.fileId}):${again} ${CHECK_TEXT[check]}.`);
    const earlier = all.find(
      (o) => o.fileId !== r.fileId && o.sha256 === r.sha256 && (o.uploaded < r.uploaded || (o.uploaded === r.uploaded && o.fileId < r.fileId)),
    );
    if (earlier && !isLegacyJanuaryPair(r, earlier)) {
      add(`replay:${r.fileId}`, `Replay: the ${r.tier} archive for ${r.period} (${r.fileId}) has the same bytes as the ${earlier.tier} archive for ${earlier.period}.`);
    }
  }

  // Hidden early: an archive version stopped being current before its age
  // rule. The nightly never hides or rewrites a name, so only a hand did; and
  // the lifecycle deletes it `del` days later. A supersession by a second
  // upload is the ambiguous period above; a hide marker is reported here.
  for (const a of bucket.archives) {
    const terms = lifecycleTerms(lifecycle, a.spec.archivePrefix);
    const hides = (bucket.hideTimes.get(a.archiveName) ?? []).filter((t) => t > a.uploadTimestamp);
    if (hides.length > 0 && hides[0] < a.uploadTimestamp + terms.hide * DAY) {
      const fate = terms.del === Infinity ? 'no rule deletes it, but a restore no longer sees it as current' : `B2 deletes it ${terms.del} days later`;
      add(`hidden-early:${a.fileId}`, `Hidden early: the ${a.tier} archive for ${a.period} (${a.fileId}) was hidden on ${new Date(hides[0]).toISOString().slice(0, 10)}, before its lifecycle would hide it; ${fate}.`);
    }
  }

  // Deleted early: a recorded archive gone before the lifecycle could remove
  // it. When the listing shows the version was superseded or hidden first,
  // the lifecycle's clock starts there (that event pages on its own above).
  for (const r of all) {
    if (present.has(r.fileId)) continue;
    const spec = TIERS.find((t) => t.tier === r.tier);
    const name = `${spec.archivePrefix}${r.period}/${r.nonce}.bin`;
    const deadline = earliestLifecycleDeletion(lifecycleTerms(lifecycle, spec.archivePrefix), r.uploaded, noncurrentAt(bucket, name, r.uploaded));
    if (now < deadline) {
      add(`deleted-early:${r.fileId}`, `Deleted early: the ${r.tier} archive for ${r.period} (${r.fileId}) is gone; the lifecycle could not have removed it before ${deadline === Infinity ? 'never' : new Date(deadline).toISOString().slice(0, 10)}.`);
    }
  }

  // A yearly entry whose archive still exists must keep being renewed.
  for (const r of all) {
    if (r.tier !== 'yearly' || !present.has(r.fileId)) continue;
    if (!(r.retainUntil >= now + (YEARLY_RENEW_BELOW_DAYS - 1) * DAY)) {
      add(`renewal-failed:${r.fileId}`, `Retention not renewed: the ledger entry for the ${r.period} yearly archive (${r.fileId}) is locked only until ${r.retainUntil ? new Date(r.retainUntil).toISOString().slice(0, 10) : 'unknown'}.`);
    }
  }

  // An extension B2 refused this run: paged now, not when the year runs out.
  for (const f of renewalFailures) {
    add(`renewal-failed:${f.fileId}`, `Retention not renewed: extending the ledger entry for the ${f.period} yearly archive (${f.fileId}) failed: ${f.error}.`);
  }

  // An archive left unrecorded on purpose, waiting for its manifest.
  for (const d of deferred) notes.push(`${d.tier} ${d.period} (${d.fileId}) waits for its manifest and will be recorded on a later run`);

  return { problems, notes };
}

/**
 * A problem key as the alert issue records it: the characters a key may carry
 * there, and nothing else. A key built from a name the watcher never writes
 * can hold anything, so it is narrowed here, once, before it is compared with
 * an acknowledgement or recorded.
 */
export function safeKey(key) {
  return String(key).replace(/[^0-9A-Za-z_.:/-]/g, '?').slice(0, 300);
}

/** The yearly entries to lengthen now: archive still present, under a year left. */
export function renewalsDue({ now, ledger, bucket }) {
  const present = new Set(bucket.archives.map((a) => a.fileId));
  return [...ledger.recorded.values()].filter(
    (r) => r.tier === 'yearly' && present.has(r.fileId) && !(r.retainUntil >= now + YEARLY_RENEW_BELOW_DAYS * DAY),
  );
}

/** Problem keys an operator acknowledged in a reviewed commit, comma-separated. */
export function parseAcknowledged(raw) {
  return new Set(
    String(raw ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
}
