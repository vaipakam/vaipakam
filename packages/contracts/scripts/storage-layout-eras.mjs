#!/usr/bin/env node
/**
 * storage-layout-eras.mjs — the storage slots of the fields the custody census
 * reads directly, for EVERY layout era `LibVaipakam.Storage` has had since the
 * earliest deployment (#1566, design §7a).
 *
 * The provenance walker found that the struct was not append-only, so a slot
 * from today's layout is wrong for facets compiled before a change. Instead of
 * identifying each deployment's source, the census reads a row at every era's
 * slot and proves it absent only when all of them are zero. This tool produces
 * that era table, from the COMPILER at one commit per era:
 *
 *   1. eras = the first walked commit, every change-event commit the walker
 *      reports, and HEAD;
 *   2. for each era, a throwaway git worktree at that commit, a probe contract
 *      holding `LibVaipakam.Storage s;`, and
 *      `forge build --skip test --skip script --extra-output storageLayout`;
 *   3. the artifact's storageLayout gives every member's slot relative to `s`,
 *      the era's own `VANGKI_STORAGE_POSITION` (or the plain hash, where the
 *      source still used it) gives the base, and the sum is the absolute slot.
 *
 * Every era is recorded — an era whose build failed is listed under
 * `unavailable`, never silently dropped, because an incomplete era table would
 * make the census's "zero at every era" claim false. Never hand-edit the
 * output; re-run this.
 *
 * Usage: node scripts/storage-layout-eras.mjs [--since 2026-05-01] [--only-head] [--keep-worktrees] [--out <path>]
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { walkProvenance, storagePositionOf, layoutFingerprint, REPO_ROOT, LIB_PATH, DEFAULT_SINCE, STRUCTS } from './storage-layout-provenance.mjs';
export { storagePositionOf };

export const FIELDS = ['nextLoanId', 'totalLoansEverCreated', 'intentLiveCommitCount', 'intentCommits', 'borrowerLifRebate', 'fallbackSnapshot'];
export const ROW_STRUCTS = ['SwapToRepayIntentCommit', 'BorrowerLifRebate', 'FallbackSnapshot'];
export const OUT_DEFAULT = join(REPO_ROOT, 'contracts', 'deployments', 'storage-slot-eras.json');
const PROBE_SRC = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
import {LibVaipakam} from "./libraries/LibVaipakam.sol";
/// Throwaway: holds the struct so the compiler reports its layout. Written by storage-layout-eras.mjs.
contract StorageLayoutEraProbe {
    LibVaipakam.Storage internal s;
}
`;

function sh(cmd, args, cwd, opts = {}) {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], ...opts });
}

/**
 * Every top-level `Storage` member's occupied slot span at a given position —
 * what a slot from an EARLIER era may alias today (#2095 r3 follow-up). A
 * mapping or dynamic array occupies one head slot; a value type or inline
 * struct occupies `numberOfBytes` from its slot. Pure; exported for the test.
 */
export function occupiedRangesFromLayout(layout, position) {
  const s = (layout.storage ?? []).find((v) => v.label === 's');
  const struct = layout.types[s.type];
  const base = BigInt(position);
  const out = [];
  for (const m of struct.members) {
    const t = layout.types[m.type];
    const bytes = BigInt(t?.numberOfBytes ?? 32);
    const from = base + BigInt(m.slot);
    const slots = bytes <= 32n ? 1n : (bytes + 31n) / 32n;
    out.push({ label: m.label, type: m.type, from: '0x' + from.toString(16).padStart(64, '0'), to: '0x' + (from + slots - 1n).toString(16).padStart(64, '0'), isMapping: /^t_mapping/.test(m.type) });
  }
  return out;
}

/** Pull the members we need out of a forge storageLayout artifact. Pure; exported for the test. */
export function slotsFromLayout(layout, position, fields = FIELDS, rowStructs = ROW_STRUCTS) {
  const s = (layout.storage ?? []).find((v) => v.label === 's');
  if (!s) throw new Error('storageLayout has no variable `s`');
  const struct = layout.types[s.type];
  if (!struct?.members) throw new Error(`type ${s.type} has no members`);
  const base = BigInt(position);
  const out = {};
  for (const f of fields) {
    const m = struct.members.find((x) => x.label === f);
    out[f] = m ? { slot: '0x' + (base + BigInt(m.slot)).toString(16).padStart(64, '0'), relative: Number(m.slot), offset: Number(m.offset), type: m.type } : null;
  }
  const rows = {};
  for (const name of rowStructs) {
    const key = Object.keys(layout.types).find((k) => new RegExp(`^t_struct\\(${name}\\)`).test(k));
    rows[name] = key ? Object.fromEntries(layout.types[key].members.map((m) => [m.label, { slot: Number(m.slot), offset: Number(m.offset), type: m.type }])) : null;
  }
  return { fields: out, rows };
}

/**
 * One commit per era: the first walked commit, every change event, and every
 * commit at which a TARGET FIELD's index changed — the latter covers an
 * APPEND, which is append-only and therefore no change event, yet opens an
 * era of its own for that field (intentCommits appeared on 2026-06-08 at an
 * index the 2026-06-23 removals later shifted; neither neighbouring event
 * commit carries that slot). Sorted by date; HEAD is added by the caller.
 */
export function eraCommits(walk, commitsAsc) {
  const set = new Map();
  if (commitsAsc.length) set.set(commitsAsc[0].sha, { ...commitsAsc[0], event: 'walk start' });
  for (const e of walk.changeEvents) set.set(e.commit, { sha: e.commit, date: e.date, event: `${e.struct} ${e.kind} @${e.firstDifferentIndex}` });
  for (const [f, eras] of Object.entries(walk.indexEras ?? {})) {
    for (const era of eras) if (!set.has(era.fromCommit)) set.set(era.fromCommit, { sha: era.fromCommit, date: era.from, event: `${f} → index ${era.index}` });
  }
  return [...set.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export function buildEra(sha, { repo = REPO_ROOT, keep = false, log = () => {} } = {}) {
  // A fresh, unpredictable directory per build (CodeQL js/insecure-temporary-file:
  // a fixed name under the OS temp dir could be pre-created by another user).
  const dir = mkdtempSync(join(tmpdir(), `vaipakam-era-${sha.slice(0, 9)}-`));
  rmSync(dir, { recursive: true, force: true }); // git worktree add wants a path that does not exist yet
  sh('git', ['worktree', 'add', '--detach', dir, sha], repo);
  try {
    const c = join(dir, 'contracts');
    // dependencies: the pinned submodules from the superproject's own store; a symlink to the main checkout's lib is the fallback
    try {
      sh('git', ['submodule', 'update', '--init', '--recursive', '--', 'contracts/lib'], dir);
    } catch (e) {
      log(`  ${sha.slice(0, 9)}: submodule update failed (${String(e.stderr || e.message).split('\n')[0].slice(0, 80)}); linking contracts/lib from the main checkout`);
      rmSync(join(c, 'lib'), { recursive: true, force: true });
      symlinkSync(join(repo, 'contracts', 'lib'), join(c, 'lib'));
    }
    writeFileSync(join(c, 'src', 'StorageLayoutEraProbe.sol'), PROBE_SRC);
    const lib = readFileSync(join(dir, LIB_PATH), 'utf8');
    const pos = storagePositionOf(lib);
    if (!pos) throw new Error('no storage position found in the era source');
    const profile = /^\[profile\.quick\]/m.test(readFileSync(join(c, 'foundry.toml'), 'utf8')) ? 'quick' : 'default';
    sh('forge', ['build', '--skip', 'test', '--skip', 'script', '--extra-output', 'storageLayout', '--silent'], c, { env: { ...process.env, FOUNDRY_PROFILE: profile } });
    const art = JSON.parse(readFileSync(join(c, 'out', 'StorageLayoutEraProbe.sol', 'StorageLayoutEraProbe.json'), 'utf8'));
    if (!art.storageLayout) throw new Error('artifact carries no storageLayout');
    return { ...slotsFromLayout(art.storageLayout, pos.position), occupied: occupiedRangesFromLayout(art.storageLayout, pos.position), storagePosition: pos.position, positionDerivation: pos.derivation, profile };
  } finally {
    if (!keep) {
      try { sh('git', ['worktree', 'remove', '--force', dir], repo); } catch { /* leave it; `git worktree prune` cleans up */ }
    }
  }
}

/**
 * `--check`: no builds. The era commits the CURRENT walk implies must all be
 * present in the committed table, the table must be complete, and its head
 * must be an ancestor of (or equal to) HEAD — otherwise a layout change has
 * landed since the table was generated and the census would read too few
 * eras. Exported for the CI job; returns the list of missing commits.
 */
export function checkEraTable({ tablePath = OUT_DEFAULT, since = DEFAULT_SINCE, log = () => {} } = {}) {
  const table = JSON.parse(readFileSync(tablePath, 'utf8'));
  const walk = walkProvenance({ since, fields: FIELDS });
  const commitsAsc = sh('git', ['log', '--format=%H %cI', `--since=${since}`, '--', LIB_PATH], REPO_ROOT).trim().split('\n').filter(Boolean).map((l) => { const [sha, date] = l.split(' '); return { sha, date }; }).reverse();
  const needed = eraCommits(walk, commitsAsc);
  // Era identity is a CONTENT fingerprint, not a SHA (#2095 r3 P2): a squash
  // merge records the same source under another commit, so membership is
  // checked by the fingerprint of each needed commit's source.
  const have = new Set((table.eras ?? []).map((e) => e.fingerprint).filter(Boolean));
  const fingerprintAt = (sha) => layoutFingerprint(sh('git', ['show', `${sha}:${LIB_PATH}`], REPO_ROOT), STRUCTS, FIELDS);
  const missing = needed.filter((e) => !have.has(fingerprintAt(e.sha)));
  const problems = [];
  if ((table.eras ?? []).some((e) => !e.fingerprint)) problems.push('an era carries no fingerprint — regenerate the table');
  if (!table.complete) problems.push(`the table is incomplete (${(table.unavailable ?? []).length} era(s) unavailable${table.partial ? `; ${table.partial}` : ''})`);
  // Freshness is a CONTENT identity, never a commit SHA: the table's HEAD era
  // must have been built from the layout inputs HEAD has now (#2095 r2 P1 — a
  // branch SHA is no ancestor of a squash commit, and PR CI reviews a merge
  // commit the branch head is not an ancestor of either).
  if (table.headFingerprint !== walk.headFingerprint) problems.push(`the table's HEAD era was built from a different layout (fingerprint ${String(table.headFingerprint).slice(0, 12)} vs ${walk.headFingerprint.slice(0, 12)} now) — regenerate`);
  for (const m of missing) problems.push(`era ${m.sha.slice(0, 9)} (${m.date.slice(0, 10)}, ${m.event}) is not in the table`);
  log(`storage-layout-eras --check: ${problems.length ? 'STALE' : 'OK'} — ${needed.length} era(s) implied by the walk, ${have.size} in the table${problems.length ? '\n  ' + problems.join('\n  ') : ''}`);
  return { ok: problems.length === 0, problems, needed: needed.length, inTable: have.size };
}

export function main(argv = process.argv.slice(2)) {
  const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
  const since = arg('--since', DEFAULT_SINCE);
  const out = arg('--out', OUT_DEFAULT);
  if (argv.includes('--check')) return checkEraTable({ tablePath: out, since, log: (m) => process.stderr.write(m + '\n') }).ok ? 0 : 1;
  const onlyHead = argv.includes('--only-head');
  // --only-head is a pipeline diagnostic: it must never overwrite the production table (#2095 r2 P2)
  if (onlyHead && resolvePath(out) === resolvePath(OUT_DEFAULT)) {
    process.stderr.write('storage-layout-eras: --only-head builds one era and is not a complete table; pass --out <path> outside contracts/deployments\n');
    return 2;
  }
  const keep = argv.includes('--keep-worktrees');
  // --reuse <path>: eras already built (same commit) in a previous output are copied, not rebuilt
  const reusePath = arg('--reuse', null);
  const reusable = new Map();
  if (reusePath && existsSync(reusePath)) {
    for (const e of JSON.parse(readFileSync(reusePath, 'utf8')).eras ?? []) reusable.set(e.commit, e);
  }
  const log = (m) => process.stderr.write(m + '\n');
  const walk = walkProvenance({ since, fields: FIELDS });
  const commitsAsc = sh('git', ['log', '--format=%H %cI', `--since=${since}`, '--', LIB_PATH], REPO_ROOT).trim().split('\n').filter(Boolean).map((l) => { const [sha, date] = l.split(' '); return { sha, date }; }).reverse();
  const head = walk.head;
  const eras = onlyHead ? [] : eraCommits(walk, commitsAsc);
  if (!eras.some((e) => e.sha === head)) eras.push({ sha: head, date: new Date().toISOString(), event: 'HEAD' });
  log(`storage-layout-eras: ${eras.length} era(s) to build since ${since} (walk: ${walk.commitsWalked} commits, ${walk.changeEvents.length} change events)`);
  const built = [];
  const unavailable = [];
  for (const e of eras) {
    const t0 = Date.now();
    const fingerprint = layoutFingerprint(sh('git', ['show', `${e.sha}:${LIB_PATH}`], REPO_ROOT), STRUCTS, FIELDS);
    if (reusable.has(e.sha) && !(e.sha === head && !reusable.get(e.sha).occupied)) {
      built.push({ ...reusable.get(e.sha), event: e.event ?? reusable.get(e.sha).event ?? null, fingerprint });
      log(`  ${e.sha.slice(0, 9)} ${e.date.slice(0, 10)} ${(e.event ?? '').padEnd(34)} reused`);
      continue;
    }
    try {
      const r = buildEra(e.sha, { keep, log });
      built.push({ commit: e.sha, date: e.date, event: e.event ?? null, fingerprint, ...r });
      log(`  ${e.sha.slice(0, 9)} ${e.date.slice(0, 10)} ${(e.event ?? '').padEnd(34)} ok in ${Math.round((Date.now() - t0) / 1000)}s (${r.profile}); intentCommits ${r.fields.intentCommits ? r.fields.intentCommits.slot.slice(0, 12) + '…' : 'absent'}`);
    } catch (err) {
      const reason = String(err.stderr || err.message).split('\n').slice(0, 3).join(' | ').slice(0, 300);
      unavailable.push({ commit: e.sha, date: e.date, event: e.event ?? null, reason });
      log(`  ${e.sha.slice(0, 9)} ${e.date.slice(0, 10)} FAILED: ${reason.slice(0, 160)}`);
    }
  }
  const distinct = {};
  for (const f of FIELDS) distinct[f] = [...new Set(built.map((b) => b.fields[f]?.slot).filter(Boolean))];
  const result = {
    purpose: 'Every storage slot each census-read field has occupied across the layout eras of LibVaipakam.Storage since the walk began (#1566, design section 7a). A row is proven absent only when it reads zero at EVERY era slot. Generated by storage-layout-eras.mjs from the compiler at one commit per era; never hand-edit.',
    generatedAt: new Date().toISOString(),
    head,
    since,
    walk: { commitsWalked: walk.commitsWalked, changeEvents: walk.changeEvents.map((x) => ({ commit: x.commit, date: x.date, struct: x.struct, kind: x.kind, index: x.firstDifferentIndex, lengthDelta: x.lengthDelta })) },
    complete: unavailable.length === 0 && !onlyHead,
    partial: onlyHead ? 'only-head diagnostic — one era, not a table the census may read' : undefined,
    headFingerprint: walk.headFingerprint,
    eras: built,
    unavailable,
    distinctSlots: distinct,
  };
  mkdirSync(resolvePath(out, '..'), { recursive: true });
  writeFileSync(out, JSON.stringify(result, null, 2) + '\n');
  log(`written ${out}: ${built.length} era(s) built, ${unavailable.length} unavailable; distinct intentCommits slots: ${distinct.intentCommits.length}`);
  return result.complete ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolvePath(process.argv[1])) process.exit(main());
