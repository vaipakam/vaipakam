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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { keccak256 } from 'viem';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { walkProvenance, storagePositionOf, layoutFingerprint, layoutShapeFingerprint, REPO_ROOT, LIB_PATH, DEFAULT_SINCE, STRUCTS } from './storage-layout-provenance.mjs';
export { storagePositionOf };

export const FIELDS = ['nextLoanId', 'totalLoansEverCreated', 'intentLiveCommitCount', 'intentCommits', 'borrowerLifRebate', 'fallbackSnapshot'];
export const ROW_STRUCTS = ['SwapToRepayIntentCommit', 'BorrowerLifRebate', 'FallbackSnapshot'];
export const OUT_DEFAULT = join(REPO_ROOT, 'contracts', 'deployments', 'storage-slot-eras.json');
/** Commits the census asked to have built, derived from cut timestamps it saw on chain (#2095 r9) — written by the census, read here. */
export const CANDIDATES_FILE = join(REPO_ROOT, 'contracts', 'deployments', 'facet-build-candidates.json');
export const DEPLOYMENTS_DIR = join(REPO_ROOT, 'contracts', 'deployments');
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

/**
 * The runtime bytecode of every contract under `src/` that the era's build
 * produced, keyed by keccak256 (#2095 r9 P1). A facet on a chain whose code
 * hash is in some era's catalogue was compiled from that era's sources —
 * the metadata trailer hashes every source in its import closure, so a
 * facet built from a tree whose dirt touched the storage library matches
 * NO era and the census refuses to certify the deployment. Pure over an
 * `out/` directory; exported for the test.
 */
export function bytecodeCatalogueFrom(outDir) {
  const catalogue = {};
  let count = 0;
  for (const f of readdirSync(outDir, { recursive: true })) {
    if (!String(f).endsWith('.json')) continue;
    let art;
    try { art = JSON.parse(readFileSync(join(outDir, String(f)), 'utf8')); } catch { continue; }
    const target = art?.metadata?.settings?.compilationTarget;
    if (!target) continue;
    const [path, name] = Object.entries(target)[0] ?? [];
    if (!path || !/^src\//.test(path)) continue;
    const code = art.deployedBytecode?.object;
    if (!code || code === '0x' || code.length < 4) continue;
    const h = keccak256(code);
    catalogue[h] = catalogue[h] && catalogue[h] !== name ? `${catalogue[h]}|${name}` : name;
    count += 1;
  }
  return { catalogue, count };
}

/** Rebuild per-era and per-build `bytecode` maps (hash → name) from a table's compact `bytecodeIndex` + `bytecodeIds`. Pure. */
export function expandBytecode(table) {
  const index = table?.bytecodeIndex ?? [];
  const expand = (b) => {
    if (!b || b.bytecode || !Array.isArray(b.bytecodeIds)) return b;
    const bytecode = {};
    for (const i of b.bytecodeIds) { const [h, name] = index[i] ?? []; if (h) bytecode[h] = name; }
    return { ...b, bytecode };
  };
  return { ...table, eras: (table?.eras ?? []).map(expand), deploymentBuilds: (table?.deploymentBuilds ?? []).map(expand) };
}

/** Parse `git ls-tree <rev> <dir>/` into { path: { mode, type, hash } }. Pure. */
export function parseLsTree(text) {
  const out = {};
  for (const line of String(text).split('\n')) {
    const m = /^(\d{6}) (\w+) ([0-9a-f]{40})\t(.+)$/.exec(line);
    if (m) out[m[4]] = { mode: m[1], type: m[2], hash: m[3] };
  }
  return out;
}

/**
 * Whether the main checkout's `contracts/lib` may stand in for an era's
 * dependencies (#2095 r9 P2): only when the era commit's lib tree — every
 * vendored tree AND every submodule gitlink — is identical to HEAD's, and
 * every gitlink's working checkout is at that very commit. A dependency
 * revision that changed an imported enum, value type or inline struct
 * would otherwise yield slots for a source combination that never existed.
 * Pure; exported for the test.
 */
export function depsFromMainAreIdentical({ eraTree, headTree, submoduleHeads }) {
  const a = parseLsTree(eraTree);
  const b = parseLsTree(headTree);
  const paths = new Set([...Object.keys(a), ...Object.keys(b)]);
  const differences = [];
  for (const p of paths) {
    if (!a[p] || !b[p] || a[p].hash !== b[p].hash) { differences.push(`${p}: ${a[p]?.hash?.slice(0, 9) ?? 'absent'} at the era vs ${b[p]?.hash?.slice(0, 9) ?? 'absent'} at HEAD`); continue; }
    if (a[p].type === 'commit' && (submoduleHeads?.[p] ?? null) !== a[p].hash) differences.push(`${p}: gitlink ${a[p].hash.slice(0, 9)} but the working submodule is at ${submoduleHeads?.[p]?.slice(0, 9) ?? 'unknown'}`);
  }
  return { identical: differences.length === 0, differences };
}

/** `1782867868-unix` or ISO → ISO-8601 UTC, or null. Pure. */
export function deployedAtIso(v) {
  if (v === null || v === undefined) return null;
  const s = String(v);
  if (/^\d+-unix$/.test(s)) return new Date(Number(s.slice(0, -5)) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * A block's timestamp estimated between two known (block, time) anchors —
 * for a cut block below an endpoint's pruning floor, whose header cannot be
 * read (#2095 r9). Block time is near-constant on these chains, and a
 * candidate commit is only help for attribution by code, never a verdict.
 * Returns ISO or null when the anchors cannot bracket an estimate. Pure.
 */
export function interpolateTimestamp({ block, b0, t0, b1, t1 }) {
  const n = BigInt(block); const B0 = BigInt(b0); const B1 = BigInt(b1);
  const T0 = Date.parse(t0); const T1 = Date.parse(t1);
  if (Number.isNaN(T0) || Number.isNaN(T1) || B1 <= B0 || T1 <= T0) return null;
  const ms = T0 + Number(n - B0) * ((T1 - T0) / Number(B1 - B0));
  return new Date(Math.round(ms / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** The main ref to date commits against: origin/main when it exists, else HEAD. */
export function mainRef(repo = REPO_ROOT) {
  try { sh('git', ['rev-parse', '--verify', '-q', 'origin/main'], repo); return 'origin/main'; } catch { return 'HEAD'; }
}

/**
 * The commits a deployment's facets were most plausibly built from, given a
 * moment in time: the last first-parent commit of main at or before it, and
 * the first one after it (a refresh run from a branch that merged minutes
 * later builds the same tree as its squash). Exported for the census; pure
 * over git.
 */
export function commitsAround(iso, { repo = REPO_ROOT, ref = mainRef(repo), branches = true, maxBranches = 16 } = {}) {
  const out = [];
  const seen = new Set();
  const push = (commit, relation) => { if (commit && !seen.has(commit)) { seen.add(commit); out.push({ commit, relation }); } };
  try { push(sh('git', ['rev-list', '-1', '--first-parent', `--before=${iso}`, ref], repo).trim(), 'last main commit at or before'); } catch { /* none */ }
  try { push(sh('git', ['rev-list', '--reverse', '--first-parent', `--after=${iso}`, ref], repo).trim().split('\n')[0], 'first main commit after'); } catch { /* none */ }
  // A refresh run from a feature branch builds that branch's tree, which a
  // squash merge need not reproduce (main may have moved). Merged branches are
  // kept, so for every branch or tag active around the moment — a tip within
  // three days before or one day after — the last commit at or before it is a
  // candidate too, nearest tips first.
  if (branches) {
    const t = Date.parse(iso);
    const lo = t - 3 * 86400e3; const hi = t + 86400e3;
    let refs = [];
    try {
      // only refs every checkout shares — origin's branches and the tags, never
      // local heads — deduplicated by tip, so the operator's checkout and CI
      // derive the same candidates (#2095 r10)
      const seenTip = new Set();
      refs = sh('git', ['for-each-ref', '--format=%(committerdate:iso8601-strict)\t%(objectname)\t%(refname)', 'refs/remotes/origin', 'refs/tags'], repo).trim().split('\n')
        .map((l) => { const [d, tip, r] = l.split('\t'); return { r, tip, t: Date.parse(d) }; })
        .filter((x) => x.r && !Number.isNaN(x.t) && x.t >= lo && x.t <= hi && !/\/HEAD$/.test(x.r))
        .sort((a, b) => Math.abs(a.t - t) - Math.abs(b.t - t) || a.r.localeCompare(b.r))
        .filter((x) => (seenTip.has(x.tip) ? false : (seenTip.add(x.tip), true)))
        .slice(0, maxBranches);
    } catch { refs = []; }
    for (const { r } of refs) {
      try { push(sh('git', ['rev-list', '-1', `--before=${iso}`, r], repo).trim(), `last commit at or before, on ${r.replace(/^refs\/(heads|remotes)\//, '')}`); } catch { /* none */ }
    }
  }
  return out;
}

/**
 * Every commit a deployed facet may have been compiled from, as far as the
 * LOCAL records and the census's candidates file say (#2095 r9 P1):
 *   - the `monorepoCommit` each `deployment_source.json` records;
 *   - the commits around each record's `deployedAt` (a refresh rewrites it);
 *   - the commits the census derived from cut timestamps on chain.
 * Returns [{ commit, reasons[] }] sorted by commit. Exported for the test.
 */
export function deploymentBuildCandidates({ deploymentsDir = DEPLOYMENTS_DIR, candidatesFile = CANDIDATES_FILE, repo = REPO_ROOT, ref = mainRef(repo) } = {}) {
  const byCommit = new Map();
  const required = new Set();
  const add = (commit, reason, isRequired = false) => {
    if (!/^[0-9a-f]{40}$/.test(commit ?? '')) return;
    if (!byCommit.has(commit)) byCommit.set(commit, new Set());
    byCommit.get(commit).add(reason);
    if (isRequired) required.add(commit);
  };
  const record = (file, label, slug) => {
    if (!existsSync(file)) return;
    let a; try { a = JSON.parse(readFileSync(file, 'utf8')); } catch { return; }
    const src = join(file, '..', 'deployment_source.json');
    if (existsSync(src)) {
      try { const m = /^([0-9a-f]{40})/.exec(String(JSON.parse(readFileSync(src, 'utf8')).monorepoCommit ?? '')); if (m) add(m[1], `recorded by ${slug}/${label}`, true); } catch { /* unreadable record */ }
    }
    const iso = deployedAtIso(a.deployedAt);
    if (iso) for (const c of commitsAround(iso, { repo, ref })) add(c.commit, `${c.relation} ${slug}/${label}'s deployedAt ${iso}`);
  };
  if (existsSync(deploymentsDir)) {
    for (const slug of readdirSync(deploymentsDir, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name !== 'anvil' && !d.name.startsWith('.')).map((d) => d.name).sort()) {
      const dir = join(deploymentsDir, slug);
      record(join(dir, 'addresses.json'), 'live', slug);
      const arch = join(dir, '.archive');
      if (existsSync(arch)) for (const stamp of readdirSync(arch).sort()) record(join(arch, stamp, 'addresses.json'), `archived ${stamp}`, slug);
      for (const f of readdirSync(dir).filter((f) => /^addresses\.prior-rehearsal\.\d+\.json$/.test(f)).sort()) record(join(dir, f), f, slug);
    }
  }
  if (existsSync(candidatesFile)) {
    try { for (const c of JSON.parse(readFileSync(candidatesFile, 'utf8')).candidates ?? []) for (const r of c.reasons ?? []) add(c.commit, r, true); } catch { /* an unreadable candidates file adds nothing; --check reports it */ }
  }
  // `required`: derived from COMMITTED inputs (a record's stamp, the census's
  // candidates file) — the same on every checkout, so --check may demand them;
  // ref-derived candidates depend on which refs a checkout has and are advisory
  return [...byCommit.entries()].map(([commit, reasons]) => ({ commit, reasons: [...reasons].sort(), required: required.has(commit) })).sort((x, y) => x.commit.localeCompare(y.commit));
}

export function buildEra(sha, { repo = REPO_ROOT, keep = false, log = () => {} } = {}) {
  // A fresh, unpredictable directory per build (CodeQL js/insecure-temporary-file:
  // a fixed name under the OS temp dir could be pre-created by another user).
  const dir = mkdtempSync(join(tmpdir(), `vaipakam-era-${sha.slice(0, 9)}-`));
  rmSync(dir, { recursive: true, force: true }); // git worktree add wants a path that does not exist yet
  sh('git', ['worktree', 'add', '--detach', dir, sha], repo);
  try {
    const c = join(dir, 'contracts');
    // dependencies: the pinned submodules from the superproject's own store. The
    // main checkout's lib may stand in ONLY when the era's lib tree is identical
    // to HEAD's and every submodule checkout sits at its gitlink (#2095 r9 P2);
    // otherwise the era is unavailable rather than built from sources that
    // never existed together.
    let dependencies = 'submodules at the era commit';
    try {
      sh('git', ['submodule', 'update', '--init', '--recursive', '--', 'contracts/lib'], dir);
    } catch (e) {
      const eraTree = sh('git', ['ls-tree', sha, 'contracts/lib/'], repo);
      const headTree = sh('git', ['ls-tree', 'HEAD', 'contracts/lib/'], repo);
      const submoduleHeads = {};
      for (const [p, ent] of Object.entries(parseLsTree(eraTree))) {
        if (ent.type !== 'commit') continue;
        try { submoduleHeads[p] = sh('git', ['rev-parse', 'HEAD'], join(repo, p)).trim(); } catch { submoduleHeads[p] = null; }
      }
      const same = depsFromMainAreIdentical({ eraTree, headTree, submoduleHeads });
      if (!same.identical) throw new Error(`submodule update failed (${String(e.stderr || e.message).split('\n')[0].slice(0, 80)}) and the main checkout's contracts/lib is not the era's: ${same.differences.join('; ')}`);
      log(`  ${sha.slice(0, 9)}: submodule update failed (${String(e.stderr || e.message).split('\n')[0].slice(0, 80)}); linking contracts/lib from the main checkout (identical lib tree)`);
      rmSync(join(c, 'lib'), { recursive: true, force: true });
      symlinkSync(join(repo, 'contracts', 'lib'), join(c, 'lib'));
      dependencies = 'main checkout (lib tree identical to the era commit)';
    }
    writeFileSync(join(c, 'src', 'StorageLayoutEraProbe.sol'), PROBE_SRC);
    const lib = readFileSync(join(dir, LIB_PATH), 'utf8');
    const pos = storagePositionOf(lib);
    if (!pos) throw new Error('no storage position found in the era source');
    const profile = /^\[profile\.quick\]/m.test(readFileSync(join(c, 'foundry.toml'), 'utf8')) ? 'quick' : 'default';
    sh('forge', ['build', '--skip', 'test', '--skip', 'script', '--extra-output', 'storageLayout', '--silent'], c, { env: { ...process.env, FOUNDRY_PROFILE: profile } });
    const art = JSON.parse(readFileSync(join(c, 'out', 'StorageLayoutEraProbe.sol', 'StorageLayoutEraProbe.json'), 'utf8'));
    if (!art.storageLayout) throw new Error('artifact carries no storageLayout');
    const { catalogue, count } = bytecodeCatalogueFrom(join(c, 'out'));
    if (!count) throw new Error('the era build produced no src/ bytecode to catalogue');
    return { ...slotsFromLayout(art.storageLayout, pos.position), occupied: occupiedRangesFromLayout(art.storageLayout, pos.position), storagePosition: pos.position, positionDerivation: pos.derivation, profile, dependencies, bytecode: catalogue, bytecodeCount: count };
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
  if ((table.eras ?? []).some((e) => !(Array.isArray(e.bytecodeIds) ? e.bytecodeIds.length : Object.keys(e.bytecode ?? {}).length))) problems.push('an era carries no bytecode catalogue — regenerate the table (#2095 r9)');
  if (!table.complete) problems.push(`the table is incomplete (${(table.unavailable ?? []).length} era(s) unavailable${table.partial ? `; ${table.partial}` : ''})`);
  // Freshness is a CONTENT identity, never a commit SHA: the table's HEAD era
  // must have been built from the layout inputs HEAD has now (#2095 r2 P1 — a
  // branch SHA is no ancestor of a squash commit, and PR CI reviews a merge
  // commit the branch head is not an ancestor of either).
  if (table.headFingerprint !== walk.headFingerprint) problems.push(`the table's HEAD era was built from a different layout (fingerprint ${String(table.headFingerprint).slice(0, 12)} vs ${walk.headFingerprint.slice(0, 12)} now) — regenerate`);
  for (const m of missing) problems.push(`era ${m.sha.slice(0, 9)} (${m.date.slice(0, 10)}, ${m.event}) is not in the table`);
  // every commit a deployed facet may have been built from must be catalogued (#2095 r9 P1)
  const haveBuilds = new Set([...(table.eras ?? []).map((e) => e.commit), ...(table.deploymentBuilds ?? []).filter((b) => b.bytecode || b.bytecodeIds).map((b) => b.commit)]);
  const advisory = [];
  for (const c of deploymentBuildCandidates()) {
    if (haveBuilds.has(c.commit)) continue;
    if (c.required) problems.push(`deployment build ${c.commit.slice(0, 9)} (${c.reasons[0]}) is not in the table — regenerate`);
    else advisory.push(`${c.commit.slice(0, 9)} (${c.reasons[0]})`);
  }
  if (advisory.length) log(`storage-layout-eras --check: ${advisory.length} ref-derived candidate(s) not catalogued (advisory — they depend on this checkout's refs): ${advisory.slice(0, 5).join('; ')}${advisory.length > 5 ? '; …' : ''}`);
  if ((table.eras ?? []).some((e) => e.origin === 'deployment build' && !e.fields)) problems.push('an era promoted from a deployment build carries no slots — regenerate');
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
  let reuseTable = null;
  if (reusePath && existsSync(reusePath)) {
    reuseTable = JSON.parse(readFileSync(reusePath, 'utf8'));
    for (const e of expandBytecode(reuseTable).eras ?? []) if (e.origin !== 'deployment build') reusable.set(e.commit, e);
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
    const eraSource = sh('git', ['show', `${e.sha}:${LIB_PATH}`], REPO_ROOT);
    const fingerprint = layoutFingerprint(eraSource, STRUCTS, FIELDS);
    const layoutShape = layoutShapeFingerprint(eraSource, STRUCTS, FIELDS);
    if (reusable.has(e.sha) && reusable.get(e.sha).bytecode && !(e.sha === head && !reusable.get(e.sha).occupied)) {
      built.push({ ...reusable.get(e.sha), event: e.event ?? reusable.get(e.sha).event ?? null, fingerprint, layoutShape });
      log(`  ${e.sha.slice(0, 9)} ${e.date.slice(0, 10)} ${(e.event ?? '').padEnd(34)} reused`);
      continue;
    }
    try {
      const r = buildEra(e.sha, { keep, log });
      built.push({ commit: e.sha, date: e.date, event: e.event ?? null, fingerprint, layoutShape, ...r });
      log(`  ${e.sha.slice(0, 9)} ${e.date.slice(0, 10)} ${(e.event ?? '').padEnd(34)} ok in ${Math.round((Date.now() - t0) / 1000)}s (${r.profile}); intentCommits ${r.fields.intentCommits ? r.fields.intentCommits.slot.slice(0, 12) + '…' : 'absent'}`);
    } catch (err) {
      const reason = String(err.stderr || err.message).split('\n').slice(0, 3).join(' | ').slice(0, 300);
      unavailable.push({ commit: e.sha, date: e.date, event: e.event ?? null, reason });
      log(`  ${e.sha.slice(0, 9)} ${e.date.slice(0, 10)} FAILED: ${reason.slice(0, 160)}`);
    }
  }
  // Deployment builds (#2095 r9 P1): the commits deployed facets were most
  // plausibly compiled from, catalogued so the census can attribute a facet's
  // code to a layout the table holds. An era commit needs no second build.
  // Membership is by the NAMED compiler layout the census reads (#2095 r10
  // P1): every target field's slot and every row member's slot/offset/type.
  // A names-free shape would let two same-typed members swap unseen. A build
  // whose layout no era holds is PROMOTED to an era — its slots were computed
  // by the same probe — so the era-complete read covers it.
  const layoutKey = (b) => JSON.stringify({ f: Object.fromEntries(FIELDS.map((f) => [f, b.fields?.[f]?.slot ?? null])), r: b.rows ?? null, p: b.storagePosition });
  const eraLayouts = new Map(built.map((b) => [layoutKey(b), b.commit]));
  const reusableBuilds = new Map();
  if (reuseTable) for (const b of expandBytecode(reuseTable).deploymentBuilds ?? []) reusableBuilds.set(b.commit, b);
  const deploymentBuilds = [];
  const candidates = onlyHead ? [] : deploymentBuildCandidates();
  log(`storage-layout-eras: ${candidates.length} deployment build candidate(s)`);
  for (const cand of candidates) {
    const era = built.find((b) => b.commit === cand.commit);
    let src;
    try { src = sh('git', ['show', `${cand.commit}:${LIB_PATH}`], REPO_ROOT); } catch { unavailable.push({ commit: cand.commit, date: null, event: 'deployment build', reason: 'the commit is not in this repository' }); continue; }
    const fingerprint = layoutFingerprint(src, STRUCTS, FIELDS);
    const layoutShape = layoutShapeFingerprint(src, STRUCTS, FIELDS);
    const date = sh('git', ['show', '-s', '--format=%cI', cand.commit], REPO_ROOT).trim();
    // membership is by SHAPE: a rename between two change events leaves the
    // layout in the table while the content fingerprint differs
    const base = { commit: cand.commit, date, reasons: cand.reasons, layoutFingerprint: fingerprint, layoutShape };
    if (era) { deploymentBuilds.push({ ...base, sameAsEra: true, layoutInTable: true, layoutEra: era.commit, bytecode: era.bytecode, bytecodeCount: era.bytecodeCount, profile: era.profile, dependencies: era.dependencies }); log(`  ${cand.commit.slice(0, 9)} ${date.slice(0, 10)} deployment build = era`); continue; }
    const reusableBuild = reusableBuilds.get(cand.commit);
    const finish = (r, how) => {
      const key = layoutKey(r);
      let layoutEra = eraLayouts.get(key);
      if (!layoutEra) {
        // promote: this build's layout becomes an era of its own
        built.push({ commit: cand.commit, date, event: 'deployment build', origin: 'deployment build', fingerprint, layoutShape, ...r });
        eraLayouts.set(key, cand.commit);
        layoutEra = cand.commit;
        log(`  ${cand.commit.slice(0, 9)} ${date.slice(0, 10)} deployment build ${how}: layout held by NO era — promoted to an era`);
      } else log(`  ${cand.commit.slice(0, 9)} ${date.slice(0, 10)} deployment build ${how} (${r.bytecodeCount} contracts; layout = era ${layoutEra.slice(0, 9)})`);
      deploymentBuilds.push({ ...base, layoutInTable: true, layoutEra, bytecode: r.bytecode, bytecodeCount: r.bytecodeCount, profile: r.profile, dependencies: r.dependencies, fields: r.fields, rows: r.rows, storagePosition: r.storagePosition });
    };
    if (reusableBuild && reusableBuild.bytecode && reusableBuild.fields) { finish(reusableBuild, 'reused'); continue; }
    const t0 = Date.now();
    try {
      const r = buildEra(cand.commit, { keep, log });
      finish(r, `ok in ${Math.round((Date.now() - t0) / 1000)}s`);
    } catch (err) {
      const reason = String(err.stderr || err.message).split('\n').slice(0, 3).join(' | ').slice(0, 300);
      unavailable.push({ commit: cand.commit, date, event: 'deployment build', reason });
      log(`  ${cand.commit.slice(0, 9)} ${date.slice(0, 10)} deployment build FAILED: ${reason.slice(0, 160)}`);
    }
  }
  // Compact catalogue (#2095 r10 — the drift gate refuses to scan a tracked
  // file above 2 MB): every distinct runtime-code hash once, in a global
  // index; each era and build lists ids. `expandBytecode` in the census
  // rebuilds the per-build maps.
  const index = []; const idOf = new Map();
  const idsFor = (map) => Object.entries(map ?? {}).map(([h, name]) => { const k = `${h}|${name}`; if (!idOf.has(k)) { idOf.set(k, index.length); index.push([h, name]); } return idOf.get(k); }).sort((a, b) => a - b);
  const compact = (b) => { const { bytecode, ...rest } = b; return { ...rest, bytecodeIds: idsFor(bytecode) }; };
  const distinct = {};
  for (const f of FIELDS) distinct[f] = [...new Set(built.map((b) => b.fields[f]?.slot).filter(Boolean))];
  const result = {
    purpose: 'Every storage slot each census-read field has occupied across the layout eras of LibVaipakam.Storage since the walk began (#1566, design section 7a), and per era the keccak256 of every src/ contract\'s runtime bytecode so a deployed facet can be attributed to the layout it was compiled against. A row is proven absent only when it reads zero at EVERY era slot on a deployment whose every facet attributes to an era. Generated by storage-layout-eras.mjs from the compiler at one commit per era; never hand-edit.',
    generatedAt: new Date().toISOString(),
    head,
    since,
    walk: { commitsWalked: walk.commitsWalked, changeEvents: walk.changeEvents.map((x) => ({ commit: x.commit, date: x.date, struct: x.struct, kind: x.kind, index: x.firstDifferentIndex, lengthDelta: x.lengthDelta })) },
    complete: unavailable.length === 0 && !onlyHead,
    partial: onlyHead ? 'only-head diagnostic — one era, not a table the census may read' : undefined,
    headFingerprint: walk.headFingerprint,
    // the occupied-slot map is what an EARLIER era's slot may alias TODAY, so
    // only HEAD's is read; carrying it for every era multiplied the table's
    // size by nine for nothing
    eras: built.map((b) => compact(b.commit === head ? b : { ...b, occupied: undefined })),
    deploymentBuilds: deploymentBuilds.map(compact),
    bytecodeIndex: index,
    unavailable,
    distinctSlots: distinct,
  };
  mkdirSync(resolvePath(out, '..'), { recursive: true });
  writeFileSync(out, JSON.stringify(result, null, 2) + '\n');
  log(`written ${out}: ${built.length} era(s) built, ${unavailable.length} unavailable; distinct intentCommits slots: ${distinct.intentCommits.length}`);
  return result.complete ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolvePath(process.argv[1])) process.exit(main());
