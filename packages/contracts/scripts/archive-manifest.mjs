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
  existsSync,
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
  mkdirSync(dirname(manifestPath), { recursive: true });

  const started = Date.now();
  let waited = 0;
  for (;;) {
    try {
      mkdirSync(lockDir); // atomic: exactly one process succeeds
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    // Held. Break it only when its owner is provably gone AND it is old.
    let owner = null;
    try {
      owner = JSON.parse(readFileSync(ownerFile, 'utf8'));
    } catch {
      owner = null;
    }
    let ageMs = 0;
    try {
      ageMs = Date.now() - statSync(lockDir).mtimeMs;
    } catch {
      continue; // released between our mkdir and stat — retry immediately
    }
    const ownerAlive = owner ? pidAlive(owner.pid) : false;
    if (!ownerAlive && ageMs > staleMs) {
      process.stderr.write(
        `archive-manifest: breaking a stale lock on ${manifestPath} (owner pid ${owner?.pid ?? '?'} is gone, ${Math.round(ageMs / 1000)}s old)\n`,
      );
      rmSync(lockDir, { recursive: true, force: true });
      continue;
    }
    if (Date.now() - started >= timeoutMs) {
      throw new Error(
        `archive-manifest: could not lock ${manifestPath} within ${timeoutMs} ms — held by pid ${owner?.pid ?? '?'} ` +
          `(${ownerAlive ? 'alive' : 'unknown'}, lock ${Math.round(ageMs / 1000)}s old). Another --fresh or census writer may be ` +
          `running; if not, inspect and remove ${lockDir} yourself. Nothing was written.`,
      );
    }
    waited += pollMs;
    sleepSync(Math.min(pollMs * (1 + Math.floor(waited / 1000)), 500));
  }

  try {
    writeFileSync(ownerFile, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    return fn();
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
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
 * @param {(current: object) => object[]} collect
 * @param {{allowDrop?: boolean, allowEmpty?: boolean}} [policy]
 * @returns {{manifest: object, dropped: number}}
 */
export function regenerateEntries(manifestPath, collect, policy = {}, lockOpts) {
  const { allowDrop = false, allowEmpty = false } = policy;
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
      const dropped = current.entries.filter((e) => !now.has(entryKey(e)));
      if (dropped.length && !allowDrop) {
        throw new Error(
          `archive-manifest: refusing to rewrite ${manifestPath}: it would DROP ${dropped.length} committed archived ` +
            `deployment(s) (${dropped.map(entryKey).join(', ')}). The local .archive/ tree is gitignored, so this usually ` +
            `means it is absent or partial on this checkout — not that those Diamonds are gone from the chain. Run on a ` +
            `checkout that has them, or drop them deliberately with the explicit override.`,
        );
      }
      if (dropped.length) process.stderr.write(`archive-manifest: DROPPING ${dropped.length} entr(y/ies) on explicit override\n`);
      const next = { purpose: MANIFEST_PURPOSE, generatedAt: new Date().toISOString(), entries: sortEntries(collected) };
      writeManifestAtomic(manifestPath, next);
      const verify = readManifest(manifestPath);
      for (const e of collected) {
        if (!verify.entries.some((x) => sameEntry(x, e))) {
          throw new Error(`archive-manifest: ${entryKey(e)} is not present after the regeneration — refusing to report success`);
        }
      }
      return { manifest: next, dropped: dropped.length };
    },
    lockOpts,
  );
}

// ── CLI ──────────────────────────────────────────────────────────────────────
function main(argv) {
  const [cmd, manifestPath, slug, stamp, addrPath] = argv;
  if (cmd !== 'append' || !manifestPath || !slug || !stamp || !addrPath) {
    process.stderr.write('usage: archive-manifest.mjs append <manifest> <slug> <stamp> <addresses.json>\n');
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
