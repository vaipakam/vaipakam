#!/usr/bin/env node
/**
 * archive-manifest.mjs — the ONE writer of the committed archived-Diamond
 * inventory, `contracts/deployments/archive-manifest.json`.
 *
 * Why one module (#1566, Codex #2070 r12 P1): the deploy scripts each carried
 * an identical read-modify-write of this file, and two chains running `--fresh`
 * at the same time could both read the old inventory, each append only its own
 * archive, and write in either order — both reporting success, both then
 * MOVING their prior artifacts into the gitignored `.archive/` tree, and the
 * last writer silently dropping the other Diamond from the committed record. A
 * census on that workspace would catch it through the local-archive staleness
 * check, but once the raced file is committed a clean checkout has no local
 * archive left to expose the omission and censuses a smaller population as
 * complete. That is the manifest's own failure mode, one door over from the
 * one it exists to prevent (r7: a regeneration that could shrink it).
 *
 * So every writer — the deploy scripts' append and the census's regeneration —
 * goes through this module, and every write:
 *
 *   1. takes an EXCLUSIVE LOCK on the manifest (`<manifest>.lock/`, created
 *      with `mkdir`, which is atomic on every platform Node runs on — no
 *      `flock` dependency, so macOS and Linux operators are treated alike);
 *   2. reads the CURRENT file inside the lock, so a merge is always over the
 *      latest committed state and never over a copy taken before the lock;
 *   3. writes to a temp file and `rename`s it into place, so a reader (the
 *      census, a `git diff`) never observes a half-written manifest;
 *   4. re-reads the file it just wrote and verifies the intended content is
 *      there, so "recorded" is a fact read back, not a write that returned.
 *
 * A held lock is waited on with backoff up to `timeoutMs`, then the write FAILS
 * loudly — the deploy script aborts before it moves anything, which is the safe
 * side. A lock whose owner process is dead and which is older than `staleMs`
 * is broken and the write retried; a lock whose owner is alive is never broken,
 * however old — a hung holder is for the operator to inspect, not for a
 * concurrent writer to overrule.
 *
 * CLI (what the deploy scripts call):
 *
 *   node archive-manifest.mjs append <manifest> <slug> <stamp> <addresses.json>
 *
 * Exit 0 with "recorded" / "already recorded" / "nothing to record" (an
 * artifact naming no diamond); non-zero on a lock timeout, a conflicting record
 * (same slug + stamp, different content — the r10 content-staleness rule), or a
 * verification mismatch. Anything non-zero must abort the caller.
 */

import {
  closeSync,
  existsSync,
  openSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MANIFEST_PURPOSE =
  'Committed inventory of every ARCHIVED Diamond (a --fresh redeploy archives the off-chain artifact but cannot wipe on-chain custody). ' +
  'The local .archive/ directories are gitignored; this file is what a clean checkout censuses. Regenerate with --write-archive-manifest.';

/** The fields an entry carries — the census reads every one of them, so the
 *  staleness and conflict checks compare every one of them (r10 P1). */
export const ENTRY_FIELDS = ['slug', 'stamp', 'chainId', 'diamond', 'deployBlock', 'vpfiToken'];

export function emptyManifest() {
  return { purpose: MANIFEST_PURPOSE, generatedAt: null, entries: [] };
}

/** @returns {object|null} the parsed manifest, or null when the file does not exist. Malformed JSON throws. */
export function readManifest(manifestPath) {
  if (!existsSync(manifestPath)) return null;
  const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (!m || !Array.isArray(m.entries)) throw new Error(`${manifestPath}: not an archive manifest (no entries[])`);
  return m;
}

/** Build the manifest entry for an archived artifact; null when the artifact names no diamond (nothing on-chain to record). */
export function entryFromArtifact({ slug, stamp, addrPath }) {
  const a = JSON.parse(readFileSync(addrPath, 'utf8'));
  if (!a.diamond) return null;
  return {
    slug,
    stamp,
    chainId: a.chainId ?? null,
    diamond: a.diamond,
    deployBlock: a.deployBlock ?? null,
    vpfiToken: a.vpfiToken ?? a.vpfiMirror ?? null,
  };
}

export function entryKey(e) {
  return `${e.slug}|${e.stamp}`;
}

/** Field-by-field equality over ENTRY_FIELDS — the comparison the census's staleness check makes (r10 P1). */
export function sameEntry(a, b) {
  return ENTRY_FIELDS.every((f) => String(a[f] ?? '').toLowerCase() === String(b[f] ?? '').toLowerCase());
}

export function sortEntries(entries) {
  return [...entries].sort((x, y) => entryKey(x).localeCompare(entryKey(y)));
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to another user — alive.
    return err.code === 'EPERM';
  }
}

/**
 * Run `fn` while holding the manifest's exclusive lock.
 *
 * THE LOCK IS THE OWNER FILE, NOT THE DIRECTORY (Codex #2070 r15–r18). The
 * directory is only the atomic create that lets one process publish first;
 * whoever holds `owner.json` holds the lock, and ONLY the holder ever removes
 * the directory (at release). A takeover therefore never deletes anything:
 *
 *   - acquire: `mkdir` the directory, then publish `owner.json` with an
 *     EXCLUSIVE create. If the exclusive create fails, someone else published
 *     into the directory first (a breaker taking over an ownerless directory,
 *     or a rival that resumed) and we go back to waiting. There is no
 *     check-then-withdraw step — the exclusive create IS the decision.
 *   - ownerless stale directory (its creator died, or is suspended, between
 *     mkdir and publishing): a breaker takes it over by the same exclusive
 *     owner create — exactly one wins, and a creator that resumes finds the
 *     owner file already there and waits.
 *   - dead-owner stale directory: a breaker wins an exclusive `claim` file
 *     (one claimant), re-reads the owner and confirms it is still the dead one
 *     it observed (same pid and timestamp, same directory inode), then
 *     atomically RENAMES its own owner file over the dead one and drops the
 *     claim. A live owner is never replaced; a claimant that sees one
 *     withdraws its claim and waits.
 *
 * Earlier shapes removed and re-created the directory during a takeover; each
 * revision closed one interleaving and opened the next (a claimant deleting a
 * freshly acquired directory; a resumed creator publishing after a claimant's
 * revalidation; a check-then-withdraw handoff that orphaned an ownerless
 * directory). Never removing a directory except at release is what makes the
 * protocol single-winner by construction.
 *
 * @param {string} manifestPath
 * @param {() => T} fn
 * @param {{timeoutMs?: number, staleMs?: number, pollMs?: number}} [opts]
 * @returns {T}
 * @template T
 */
export function withManifestLock(manifestPath, fn, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const staleMs = opts.staleMs ?? 120_000;
  const pollMs = opts.pollMs ?? 50;
  const lockDir = `${manifestPath}.lock`;
  const ownerFile = join(lockDir, 'owner.json');
  const claimFile = join(lockDir, 'claim');
  mkdirSync(dirname(manifestPath), { recursive: true });
  const myOwner = () => JSON.stringify({ pid: process.pid, at: new Date().toISOString() });
  const publishExclusive = () => {
    try {
      writeFileSync(ownerFile, myOwner(), { flag: 'wx' });
      return true;
    } catch (err) {
      if (err.code === 'EEXIST' || err.code === 'ENOENT') return false;
      throw err;
    }
  };
  const readOwner = () => {
    try {
      return JSON.parse(readFileSync(ownerFile, 'utf8'));
    } catch {
      return null;
    }
  };

  const started = Date.now();
  let waited = 0;
  for (;;) {
    let createdDir = false;
    try {
      mkdirSync(lockDir); // atomic: exactly one process creates it
      createdDir = true;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    if (createdDir && typeof opts._testAfterMkdir === 'function') opts._testAfterMkdir(lockDir); // test hook: interleave a rival here
    if (createdDir && publishExclusive()) break; // we created it AND published first: we hold it

    // The directory exists (ours or another's). Every wait path below is
    // bounded by this check, so nothing can `continue` past the timeout.
    if (Date.now() - started >= timeoutMs) {
      const held = readOwner();
      throw new Error(
        `archive-manifest: could not lock ${manifestPath} within ${timeoutMs} ms — held by pid ${held?.pid ?? '?'} ` +
          `(${held && pidAlive(held.pid) ? 'alive' : 'unknown'}). Another --fresh or census writer may be running; if not, ` +
          `inspect and remove ${lockDir} yourself (a leftover 'claim' file inside it means a breaker died mid-recovery). Nothing was written.`,
      );
    }
    const owner = readOwner();
    let ageMs = 0;
    let inoObserved = null;
    try {
      const st = statSync(lockDir);
      ageMs = Date.now() - st.mtimeMs;
      inoObserved = st.ino;
    } catch {
      continue; // released between our mkdir and stat — retry immediately
    }
    if (owner === null && ageMs > staleMs) {
      // Ownerless and old: its creator died or is suspended before publishing.
      // Take it over by publishing first — exactly one process can.
      if (publishExclusive()) {
        process.stderr.write(`archive-manifest: took over an ownerless stale lock on ${manifestPath} (${Math.round(ageMs / 1000)}s old)\n`);
        break;
      }
      sleepSync(pollMs);
      continue;
    }
    if (owner !== null && !pidAlive(owner.pid) && ageMs > staleMs) {
      // Dead owner: win the single claim, re-verify, then replace the owner
      // file ATOMICALLY (rename) — never the directory.
      try {
        closeSync(openSync(claimFile, 'wx'));
      } catch (err) {
        if (err.code === 'EEXIST' || err.code === 'ENOENT') {
          sleepSync(pollMs);
          continue;
        }
        throw err;
      }
      const ownerNow = readOwner();
      let inoNow = null;
      try {
        inoNow = statSync(lockDir).ino;
      } catch {
        continue;
      }
      const stillTheDeadOne =
        inoNow === inoObserved && ownerNow !== null && ownerNow.pid === owner.pid && ownerNow.at === owner.at && !pidAlive(ownerNow.pid);
      if (stillTheDeadOne) {
        const tmp = join(lockDir, `owner.${process.pid}.tmp`);
        writeFileSync(tmp, myOwner());
        renameSync(tmp, ownerFile); // atomic replacement of the dead owner by us
        rmSync(claimFile, { force: true });
        process.stderr.write(
          `archive-manifest: took over a stale lock on ${manifestPath} (owner pid ${owner.pid} is gone, ${Math.round(ageMs / 1000)}s old)\n`,
        );
        break;
      }
      rmSync(claimFile, { force: true }); // not the owner we observed — withdraw and wait
      sleepSync(pollMs);
      continue;
    }
    waited += pollMs;
    sleepSync(Math.min(pollMs * (1 + Math.floor(waited / 1000)), 500));
  }

  try {
    return fn();
  } finally {
    rmSync(lockDir, { recursive: true, force: true }); // only the holder removes the directory
  }
}

function canonical(m) {
  return JSON.stringify(m, null, 2);
}

/**
 * Write the manifest atomically (temp + rename) and read it back to verify.
 * Call ONLY inside `withManifestLock`.
 */
export function writeManifestAtomic(manifestPath, manifest) {
  const text = `${canonical(manifest)}\n`;
  const tmp = `${manifestPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(tmp, text);
    renameSync(tmp, manifestPath);
  } finally {
    rmSync(tmp, { force: true });
  }
  const back = readFileSync(manifestPath, 'utf8');
  if (back !== text) {
    throw new Error(`archive-manifest: ${manifestPath} does not read back as written — refusing to report success`);
  }
  return manifest;
}

/**
 * Append one archived deployment. Idempotent on an identical record; a
 * CONFLICTING record (same slug + stamp, different content) is refused, because
 * the two cannot both describe the same archived artifact and silently keeping
 * either is the r10 staleness hole.
 *
 * @returns {{status: 'recorded'|'already-recorded', manifest: object}}
 */
export function appendEntry(manifestPath, entry, lockOpts) {
  for (const f of ['slug', 'stamp', 'diamond']) {
    if (!entry[f]) throw new Error(`archive-manifest: entry is missing '${f}'`);
  }
  return withManifestLock(
    manifestPath,
    () => {
      const m = readManifest(manifestPath) ?? emptyManifest();
      const existing = m.entries.find((e) => entryKey(e) === entryKey(entry));
      if (existing) {
        if (sameEntry(existing, entry)) return { status: 'already-recorded', manifest: m };
        throw new Error(
          `archive-manifest: ${entryKey(entry)} is already recorded with DIFFERENT content ` +
            `(recorded diamond ${existing.diamond}, artifact says ${entry.diamond}). Two records cannot describe one archived ` +
            `artifact; correct the manifest deliberately rather than letting a write pick one.`,
        );
      }
      const next = { ...m, entries: sortEntries([...m.entries, entry]), generatedAt: new Date().toISOString() };
      writeManifestAtomic(manifestPath, next);
      // Verified by content, not by the write returning (r10: compare every field the consumer reads).
      const verify = readManifest(manifestPath);
      if (!verify.entries.some((e) => sameEntry(e, entry))) {
        throw new Error(`archive-manifest: ${entryKey(entry)} is not present after the write — refusing to report success`);
      }
      return { status: 'recorded', manifest: next };
    },
    lockOpts,
  );
}

/**
 * Regenerate the whole entry list (the census's `--write-archive-manifest`).
 *
 * `collect(current)` runs INSIDE the lock (Codex #2070 r13 P1): an earlier
 * shape collected the replacement list before taking the lock, so an append
 * that won the lock in between was overwritten by the stale list — both
 * writers reporting success, the newly archived Diamond gone from the
 * committed inventory, and the read-back verifying only the replacement.
 * Collecting under the lock means no append can interleave, and `current` is
 * the file as it stands at that moment.
 *
 * The never-drop policy (r7 P1) lives here too, so every regeneration path has
 * it: an entry the current file lists but the collector did not return is a
 * DROP, refused unless `allowDrop`, and named either way. A collector that
 * returns nothing is refused unless `allowEmpty`. Content changes for an
 * existing key are permitted — a regeneration from the local tree is how an
 * in-place correction of an archived artifact reaches the manifest (r10).
 *
 * A same-key entry whose DIAMOND differs is a DISPLACEMENT (Codex #2070 r16
 * P1): an in-place correction of an archived artifact from X to Y under the
 * same stamp would otherwise silently retire X — and any custody X holds —
 * from the committed inventory. It is refused unless `allowDisplace`, and the
 * displaced addresses are named either way. Other field changes (chainId,
 * deployBlock, vpfiToken) are corrections and are permitted.
 *
 * @param {(current: object) => object[]} collect
 * @param {{allowDrop?: boolean, allowEmpty?: boolean, allowDisplace?: boolean}} [policy]
 * @returns {{manifest: object, dropped: number, displaced: {key: string, from: string, to: string}[]}}
 */
export function regenerateEntries(manifestPath, collect, policy = {}, lockOpts) {
  const { allowDrop = false, allowEmpty = false, allowDisplace = false } = policy;
  const displaceAllowed = (key) => allowDisplace === true || (Array.isArray(allowDisplace) && allowDisplace.includes(key));
  return withManifestLock(
    manifestPath,
    () => {
      const current = readManifest(manifestPath) ?? emptyManifest();
      const collected = collect(current);
      if (!Array.isArray(collected)) throw new Error('archive-manifest: collect() must return an array of entries');
      if (!collected.length && !allowEmpty) {
        throw new Error(
          `archive-manifest: refusing to write an EMPTY manifest at ${manifestPath} — no entries were collected ` +
            `(the local .archive/ tree is gitignored and is usually absent on a clean checkout). An empty inventory ` +
            `would make a live-only census look complete.`,
        );
      }
      const now = new Set(collected.map(entryKey));
      const dropped = current.entries.filter((e) => e.displaced !== true && !now.has(entryKey(e)));
      if (dropped.length && !allowDrop) {
        throw new Error(
          `archive-manifest: refusing to rewrite ${manifestPath}: it would DROP ${dropped.length} committed archived ` +
            `deployment(s) (${dropped.map(entryKey).join(', ')}). The local .archive/ tree is gitignored, so this usually ` +
            `means it is absent or partial on this checkout — not that those Diamonds are gone from the chain. Run on a ` +
            `checkout that has them, or drop them deliberately with the explicit override.`,
        );
      }
      if (dropped.length) process.stderr.write(`archive-manifest: DROPPING ${dropped.length} entr(y/ies) on explicit override\n`);
      const byKey = new Map(current.entries.map((e) => [entryKey(e), e]));
      // Displaced-record entries (`displaced: true`) are manifest RECORDS, not
      // disk-derived — the collector never returns them — so they are retained
      // across every regeneration and never count as drops (Codex #2070 r20 P1).
      const retained = current.entries.filter((e) => e.displaced === true);
      const displaced = collected
        .filter((e) => byKey.has(entryKey(e)) && String(byKey.get(entryKey(e)).diamond).toLowerCase() !== String(e.diamond).toLowerCase())
        .map((e) => ({ key: entryKey(e), from: byKey.get(entryKey(e)).diamond, to: e.diamond }));
      const unacknowledged = displaced.filter((d) => !displaceAllowed(d.key));
      if (unacknowledged.length) {
        throw new Error(
          `archive-manifest: refusing to rewrite ${manifestPath}: ${unacknowledged.length} archived label(s) would change the DIAMOND they name ` +
            `(${unacknowledged.map((d) => `${d.key}: ${d.from} → ${d.to}`).join(', ')}). That retires the displaced Diamond — and any custody it ` +
            `holds — from the committed inventory; acknowledge each deliberately by key, and keep the displaced address on record.`,
        );
      }
      if (displaced.length) process.stderr.write(`archive-manifest: DISPLACING ${displaced.length} diamond(s) on explicit override: ${displaced.map((d) => `${d.key} ${d.from} → ${d.to}`).join(', ')}\n`);
      // Codex #2070 r20 P1 — a displaced Diamond is still a contract with
      // storage, and rows can be written to it after the census that last saw
      // it; the promise "the displaced address stays on record" must mean
      // CENSUSABLE record, not a log line. Each displacement RETAINS the old
      // entry under a derived stamp (`<stamp>@displaced-<n>`), flagged
      // `displaced: true`, so the census enumerates it as its own deployment.
      const retainedNow = [...retained];
      for (const d of displaced) {
        const old = byKey.get(d.key);
        const n = retainedNow.filter((e) => e.displacedFrom === old.stamp && e.slug === old.slug).length + 1;
        retainedNow.push({
          ...old,
          stamp: `${old.stamp}@displaced-${n}`,
          displaced: true,
          displacedFrom: old.stamp,
          displacedAt: new Date().toISOString(),
          replacedBy: d.to,
        });
      }
      const next = { ...current, purpose: MANIFEST_PURPOSE, generatedAt: new Date().toISOString(), entries: sortEntries([...collected, ...retainedNow]) };
      writeManifestAtomic(manifestPath, next);
      const verify = readManifest(manifestPath);
      for (const e of collected) {
        if (!verify.entries.some((x) => sameEntry(x, e))) {
          throw new Error(`archive-manifest: ${entryKey(e)} is not present after the regeneration — refusing to report success`);
        }
      }
      return { manifest: next, dropped: dropped.length, displaced };
    },
    lockOpts,
  );
}

/**
 * Record that a LIVE artifact was just published (Codex #2070 r20 P1). The
 * deploy scripts write `addresses.json` through forge, outside any lock; a
 * census holding the manifest lock through its publication could still miss
 * a Diamond that went live inside that window. So each deploy bumps a
 * `liveGeneration` counter in the manifest, under the lock, immediately after
 * the live artifact lands, and the census refuses to publish if the counter it
 * read at its start snapshot differs from the one it reads at publication.
 * (A Diamond that goes live AFTER the census block is out of the census's
 * scope by construction — it has no code at that block — so the residual
 * window between the forge write and this bump cannot hide custody; the
 * counter makes the "inventory unchanged" claim precise, not the verdict.)
 */
export function bumpLiveGeneration(manifestPath, { slug, diamond } = {}, lockOpts) {
  return endLivePublication(manifestPath, { slug, diamond }, lockOpts);
}

/**
 * TWO-PHASE live publication (Codex #2070 r24 P1). A single bump AFTER the
 * forge write left a window: a census holding the manifest lock through its
 * own publication could capture the inventory, the deploy could overwrite the
 * live artifact right after, and the bump would then wait behind the census's
 * lock until the stale snapshot was already renamed. So the deploy now marks
 * the publication BEFORE it broadcasts (`live-begin`, under the lock) and
 * clears the marker and bumps the generation AFTER the artifact lands
 * (`live-end`, under the lock). Any census that takes the lock in between —
 * at its start snapshot or at its publication — sees the marker and refuses:
 * the write it cannot see coming is now observable as an in-progress state.
 * A marker whose recording process is dead can be taken over by a new
 * `live-begin` for the same slug; otherwise a second begin on a slug already
 * publishing is refused. `live-end` with no matching marker still bumps (a
 * crashed deploy is cleared by running it).
 */
export function beginLivePublication(manifestPath, { slug } = {}, lockOpts) {
  if (!slug) throw new Error('archive-manifest: live-begin needs a slug');
  return withManifestLock(
    manifestPath,
    () => {
      const m = readManifest(manifestPath) ?? emptyManifest();
      const inProgress = { ...(m.livePublicationsInProgress ?? {}) };
      const existing = inProgress[slug];
      if (existing && pidAlive(existing.pid)) {
        throw new Error(
          `archive-manifest: ${slug} is already publishing a live artifact (pid ${existing.pid} since ${existing.startedAt}); ` +
            `a second deploy on the same chain cannot begin until it ends`,
        );
      }
      inProgress[slug] = { pid: process.pid, startedAt: new Date().toISOString() };
      const next = { ...m, livePublicationsInProgress: inProgress };
      writeManifestAtomic(manifestPath, next);
      return inProgress[slug];
    },
    lockOpts,
  );
}
export function endLivePublication(manifestPath, { slug, diamond } = {}, lockOpts) {
  return withManifestLock(
    manifestPath,
    () => {
      const m = readManifest(manifestPath) ?? emptyManifest();
      const inProgress = { ...(m.livePublicationsInProgress ?? {}) };
      if (slug) delete inProgress[slug];
      const next = {
        ...m,
        livePublicationsInProgress: inProgress,
        liveGeneration: (Number(m.liveGeneration) || 0) + 1,
        lastLivePublished: { slug: slug ?? null, diamond: diamond ?? null, at: new Date().toISOString() },
      };
      writeManifestAtomic(manifestPath, next);
      return next.liveGeneration;
    },
    lockOpts,
  );
}
/** Slugs with a live publication in progress (the marker set by `live-begin` and not yet cleared by `live-end`). */
export function livePublicationsInProgress(manifest) {
  return Object.entries(manifest?.livePublicationsInProgress ?? {}).map(([slug, v]) => ({ slug, ...v }));
}

/**
 * Replace a committed JSON snapshot under its lock, refusing a regression.
 *
 * Codex #2070 r14 P1 — two full censuses writing the same canonical artifact
 * both loaded the old committed-height floor before scanning, and the SLOWER
 * run, having resolved an EARLIER finality height, could rename its file over
 * a newer run's: an empty block-100 result replacing a block-101 result that
 * had seen a freshly created row. Atomic rename prevents truncation, not a
 * lost update. So the replacement is a read → compare → write lifecycle under
 * `<path>.lock`: the file as it stands is re-read INSIDE the lock, immediately
 * before the rename, and `regressedBy(current)` decides — a non-null reason
 * refuses the write and leaves the file untouched. An unparsable current file
 * is refused too (r13 P2: unreadable is not absent).
 *
 * `text` may be a function: it is then evaluated AFTER the comparison, still
 * under the lock, so what the comparison learned (an acknowledged
 * displacement, say) can be recorded in the bytes that are written (r16).
 *
 * @param {string} path
 * @param {string|(() => string)} textOrProduce the exact bytes to write, or a producer of them
 * @param {{regressedBy: (current: object) => string|null, lockOpts?: object}} opts
 */
export function writeSnapshotGuarded(path, textOrProduce, { regressedBy, lockOpts } = {}) {
  if (typeof regressedBy !== 'function') throw new Error('writeSnapshotGuarded: regressedBy is required');
  return withManifestLock(
    path,
    () => {
      if (existsSync(path)) {
        let current;
        try {
          current = JSON.parse(readFileSync(path, 'utf8'));
        } catch (err) {
          throw new Error(`${path} exists but cannot be parsed (${err.message}); refusing to replace what cannot be compared`);
        }
        const reason = regressedBy(current);
        if (reason) throw new Error(`refusing to replace ${path}: ${reason}`);
      }
      const text = typeof textOrProduce === 'function' ? textOrProduce() : textOrProduce;
      const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
      try {
        writeFileSync(tmp, text);
        renameSync(tmp, path);
      } finally {
        rmSync(tmp, { force: true });
      }
      if (readFileSync(path, 'utf8') !== text) throw new Error(`${path} does not read back as written — refusing to report success`);
      return true;
    },
    lockOpts,
  );
}

// ── CLI ──────────────────────────────────────────────────────────────────────
function main(argv) {
  const [cmd, manifestPath, slug, stamp, addrPath] = argv;
  if (cmd === 'live-begin') {
    if (!manifestPath || !slug) {
      process.stderr.write('usage: archive-manifest.mjs live-begin <manifest> <slug>\n');
      return 2;
    }
    const mark = beginLivePublication(manifestPath, { slug });
    process.stdout.write(`  ✓ live publication of ${slug} marked in progress (pid ${mark.pid}); the census refuses to read or publish until live-end\n`);
    return 0;
  }
  if (cmd === 'bump-live' || cmd === 'live-end') {
    if (!manifestPath || !slug) {
      process.stderr.write('usage: archive-manifest.mjs live-end <manifest> <slug> [<addresses.json>]\n');
      return 2;
    }
    let diamond = null;
    try {
      if (stamp) diamond = JSON.parse(readFileSync(stamp, 'utf8')).diamond ?? null; // third arg is the live artifact path here
    } catch {
      diamond = null;
    }
    const gen = endLivePublication(manifestPath, { slug, diamond });
    process.stdout.write(`  ✓ live artifact publication of ${slug} recorded and marker cleared (liveGeneration ${gen}) — COMMIT archive-manifest.json with the deploy\n`);
    return 0;
  }
  if (cmd !== 'append' || !manifestPath || !slug || !stamp || !addrPath) {
    process.stderr.write('usage: archive-manifest.mjs append <manifest> <slug> <stamp> <addresses.json>\n       archive-manifest.mjs live-begin <manifest> <slug>\n       archive-manifest.mjs live-end <manifest> <slug> [<addresses.json>]\n');
    return 2;
  }
  const entry = entryFromArtifact({ slug, stamp, addrPath });
  if (!entry) {
    process.stdout.write('  (archived artifact names no diamond — nothing on-chain to record)\n');
    return 0;
  }
  const { status } = appendEntry(manifestPath, entry);
  const shown = manifestPath.split('/deployments/')[1] ?? manifestPath;
  if (status === 'already-recorded') process.stdout.write('  (already recorded)\n');
  else process.stdout.write(`  ✓ recorded archived Diamond ${entry.diamond} in ${shown} — COMMIT THIS FILE with the deploy\n`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (err) {
    process.stderr.write(`ERROR: ${err.message}\n`);
    process.exit(1);
  }
}
