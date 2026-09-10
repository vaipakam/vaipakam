#!/usr/bin/env node
/**
 * storage-layout-provenance.mjs — is a storage slot derived from TODAY's
 * `LibVaipakam.Storage` layout sound for a Diamond compiled from OLDER source?
 *
 * #1566, design §7. No deployment artifact records the source it was
 * compiled from, and the library has been edited many times since the earliest
 * deployment in the census inventory. A slot the census reads directly (where a
 * Diamond routes no getter) means the same thing on an older Diamond only if
 * the struct has been APPEND-ONLY up to that field since the field appeared —
 * the same discipline an in-place facet refresh already depends on, but never
 * checked. This script checks it from history:
 *
 *   for every commit of the library since --since (and HEAD), extract the
 *   declaration sequence (type + name, comments stripped) of `struct Storage`
 *   and of the row structs the census reads into, and require each historical
 *   sequence to be a PREFIX of HEAD's. It also reports the commit that
 *   introduced each field the census depends on.
 *
 * Under that property a deployment older than a field has never run code able
 * to write the field's slot, and the slot was unused, so a zero read there is
 * honest. If the property fails the census refuses the storage read and names
 * the commit (the census calls `walkProvenance` at startup); CI runs this file
 * standalone so the failure is loud before a census ever runs.
 *
 * Usage:  node scripts/storage-layout-provenance.mjs [--since 2026-05-01] [--json]
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { keccak256, toBytes } from 'viem';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve as resolvePath } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolvePath(HERE, '..', '..', '..');
export const LIB_PATH = 'contracts/src/libraries/LibVaipakam.sol';
export const SLOTS_JSON = join(REPO_ROOT, 'contracts', 'deployments', 'storage-slots.json');
/** The earliest deployment in the census inventory is 2026-05-10; the walk starts a little before it. */
export const DEFAULT_SINCE = '2026-05-01';
/** Structs whose layout the census reads: the state root and the three loan-keyed rows. */
export const STRUCTS = ['Storage', 'SwapToRepayIntentCommit', 'BorrowerLifRebate', 'FallbackSnapshot'];

/**
 * Strip `//`, `///` and block comments in ONE left-to-right scan. Two regexes
 * applied in sequence are wrong here: a `/*` inside a `//` line comment (the
 * library has one) would open a block comment that swallows real code — the
 * first cut of this walker lost `struct Storage`'s closing brace that way and
 * read every function after it as a field. String literals are skipped so a
 * quoted slash cannot start a comment either.
 */
export function stripComments(src) {
  let out = '';
  for (let i = 0; i < src.length; ) {
    const c = src[i];
    const n = src[i + 1];
    if (c === '/' && n === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && n === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end < 0 ? src.length : end + 2;
      out += ' ';
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === '\\' ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * The declaration sequence of `struct <name> { … }`: one normalised
 * `type name` string per member, in order. Types are part of the sequence
 * because a retyped field changes packing as surely as an inserted one.
 */
export function extractDeclarations(source, structName) {
  const clean = stripComments(source);
  const m = new RegExp(`\\bstruct\\s+${structName}\\s*\\{`).exec(clean);
  if (!m) throw new Error(`struct ${structName} not found`);
  let depth = 1;
  let i = m.index + m[0].length;
  const start = i;
  for (; i < clean.length && depth > 0; i++) {
    if (clean[i] === '{') depth++;
    else if (clean[i] === '}') depth--;
  }
  if (depth !== 0) throw new Error(`struct ${structName}: unbalanced braces`);
  const body = clean.slice(start, i - 1);
  return body
    .split(';')
    .map((d) => d.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .map((d) => d.replace(/\s*=>\s*/g, ' => ').replace(/\(\s*/g, '(').replace(/\s*\)/g, ')'));
}

export function fieldName(decl) {
  return decl.split(' ').pop();
}
const PRIMITIVE = /^(u?int\d*|address|bool|bytes\d*|bytes|string)$/;
/** The era's own storage position: the ERC-7201 constant if declared, else the plain hash the older source used. */
export function storagePositionOf(libSource) {
  const c = /VANGKI_STORAGE_POSITION\s*=\s*(0x[0-9a-fA-F]{64})/.exec(libSource);
  if (c) return { position: c[1].toLowerCase(), derivation: 'VANGKI_STORAGE_POSITION constant (ERC-7201)' };
  if (/keccak256\("vaipakam\.storage"\)/.test(libSource)) return { position: keccak256(toBytes('vaipakam.storage')), derivation: 'keccak256("vaipakam.storage") (pre-ERC-7201 source)' };
  return null;
}
/**
 * A CONTENT fingerprint of everything the era table depends on at a source
 * revision: the storage position and the declaration sequences of Storage,
 * the row structs and every inline struct before a target. `--check` pins
 * the table's freshness to this rather than to a commit SHA, because a
 * feature-branch SHA is an ancestor of nothing after a squash merge (#2095 r2).
 */
export function layoutFingerprint(source, structs, fields) {
  const inline = inlineStructsBefore(source, fields);
  const names = [...new Set([...structs, ...inline.local])].sort();
  const parts = [storagePositionOf(source)?.position ?? 'no-position'];
  for (const n of names) {
    try { parts.push(`${n}:${extractDeclarations(source, n).join(';')}`); } catch { parts.push(`${n}:absent`); }
  }
  return createHash('sha256').update(parts.join('\n')).digest('hex');
}
/**
 * The INLINE struct types `struct Storage` embeds before the last target
 * field, recursively (#2095 r1 P1). An inline struct's members occupy slots
 * in place, so a member added to or retyped in `ProtocolConfig` shifts every
 * field after it without any `Storage` declaration changing — the walk must
 * track those structs' own declaration sequences too. A type defined outside
 * this file (OpenZeppelin's EnumerableSet) is reported as external and
 * assumed stable, which the pinned submodule makes true.
 */
export function inlineStructsBefore(source, targets, structName = 'Storage') {
  const decls = extractDeclarations(source, structName);
  const lastTarget = Math.max(-1, ...targets.map((t) => decls.findIndex((d) => fieldName(d) === t)));
  const local = new Set();
  const external = new Set();
  const visit = (struct, upTo) => {
    let list;
    try {
      list = extractDeclarations(source, struct);
    } catch {
      return;
    }
    for (let i = 0; i < (upTo === undefined ? list.length : upTo); i++) {
      const t = layoutType(list[i]);
      if (t === 'mapping' || t === 'dynamic-array') continue;
      const base = t.replace(/\[\d+\]$/, '');
      if (PRIMITIVE.test(base)) continue;
      const short = base.split('.').pop();
      if (new RegExp(`\\benum\\s+${short}\\b`).test(source)) continue; // an enum is a uint8
      if (new RegExp(`\\bstruct\\s+${short}\\s*\\{`).test(source)) {
        if (!local.has(short)) {
          local.add(short);
          visit(short);
        }
      } else external.add(base);
    }
  };
  visit(structName, lastTarget + 1);
  return { local: [...local], external: [...external] };
}
export function fieldType(decl) {
  return decl.slice(0, decl.length - fieldName(decl).length).trim();
}
/**
 * The SIZE-BEARING part of a type for sequence comparison: a mapping or a
 * dynamic array occupies exactly one slot whatever it maps to or holds, so a
 * changed value type (the 2026-07-15 `uint8 → uint16` keeper-action retype)
 * shifts nothing after it; value types, fixed arrays and inline structs keep
 * their full spelling because their size is what they are.
 */
export function layoutType(decl) {
  const t = fieldType(decl);
  if (/^mapping\(/.test(t)) return 'mapping';
  if (/\[\]$/.test(t)) return 'dynamic-array';
  return t;
}

/**
 * `a` is a layout-prefix of `b`: every historical declaration sits where it
 * sits today with the same size-bearing type. A name that differs at an index
 * is a RENAME (slot unchanged, reported as a note) only if the old name does
 * not appear later in today's sequence; if it does, the field MOVED — something
 * was inserted or removed before it — and that is a violation even when the
 * types at that index happen to agree (an inserted `uint256` looks exactly
 * like a rename to a type-only comparison; the first cut of this rule missed
 * that). Target fields are located by name at each commit, so a renamed
 * target simply reads as introduced later — the conservative direction.
 */
/**
 * At index i the two sequences carry the same layout type but different
 * names. It is a RENAME only if neither name exists elsewhere in the other
 * sequence; if the old name sits elsewhere today, or today's name sat
 * elsewhere then, a field MOVED — something was inserted or removed — and
 * the slot no longer means the same thing. Returns null for a rename, or the
 * reason for the move.
 */
export function moveReason(a, b, i) {
  const was = fieldName(a[i]);
  const now = fieldName(b[i]);
  const wasToday = b.findIndex((d, j) => j !== i && fieldName(d) === was);
  if (wasToday >= 0) return `"${a[i]}" was at index ${i} and is at index ${wasToday} today — something was inserted or removed before it`;
  const nowThen = a.findIndex((d, j) => j !== i && fieldName(d) === now);
  if (nowThen >= 0) return `"${b[i]}" is at index ${i} today and was at index ${nowThen} then — something was inserted or removed before it`;
  return null;
}
export function isPrefix(a, b) {
  const renames = [];
  if (a.length > b.length) return { ok: false, at: b.length, reason: `${a.length - b.length} declaration(s) removed since`, renames };
  for (let i = 0; i < a.length; i++) {
    if (layoutType(a[i]) !== layoutType(b[i])) return { ok: false, at: i, reason: `"${a[i]}" was at index ${i}; today "${b[i] ?? '(nothing)'}" is`, renames };
    if (fieldName(a[i]) !== fieldName(b[i])) {
      const moved = moveReason(a, b, i);
      if (moved) return { ok: false, at: i, reason: moved, renames };
      renames.push({ index: i, was: fieldName(a[i]), now: fieldName(b[i]) });
    }
  }
  return { ok: true, at: a.length, renames };
}

function git(args, cwd = REPO_ROOT) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * Walk the library's history since `since` and verify the prefix property for
 * every struct in `structs`. Returns a verdict object; never throws on a
 * layout violation (the verdict carries it), only on a broken repository.
 */
export function walkProvenance({ repo = REPO_ROOT, libPath = LIB_PATH, since = DEFAULT_SINCE, structs = STRUCTS, fields = [] } = {}) {
  const head = git(['rev-parse', 'HEAD'], repo).trim();
  // the inline structs that precede a target at HEAD are layout-bearing: track them like the row structs
  const headSourceForInline = readFileSync(join(repo, libPath), 'utf8');
  const inline = fields.length ? inlineStructsBefore(headSourceForInline, fields) : { local: [], external: [] };
  structs = [...new Set([...structs, ...inline.local])];
  const log = git(['log', '--format=%H %cI', `--since=${since}`, '--', libPath], repo).trim();
  const commits = log ? log.split('\n').map((l) => { const [sha, date] = l.split(' '); return { sha, date }; }) : [];
  // oldest first; HEAD last (HEAD's file may be uncommitted-clean or not — read the working tree for HEAD)
  commits.reverse();
  const headSource = readFileSync(join(repo, libPath), 'utf8');
  const today = Object.fromEntries(structs.map((s) => [s, extractDeclarations(headSource, s)]));
  const violations = [];
  const renames = new Set();
  const introducedAt = {};
  /** Layout CHANGE EVENTS between consecutive commits: where the type sequence first differs, and how. */
  const changeEvents = [];
  /** Per target field: the eras of its index — [{index, from, to}] — so a deployment date maps to an index. */
  const indexEras = Object.fromEntries(fields.map((f) => [f, []]));
  const prevSeq = {};
  /** The storage position at every commit: a change is an era for EVERY field (#2095 r2 P1). */
  const positionEras = [];
  /** Inline structs that preceded a target at SOME revision but not at HEAD (#2095 r5 P1): tracked while they existed. */
  const historicalInline = new Set();
  for (const f of fields) introducedAt[f] = null;
  for (const c of commits) {
    let src;
    try {
      src = git(['show', `${c.sha}:${libPath}`], repo);
    } catch {
      continue; // the file did not exist at this commit — nothing was deployable from it
    }
    // The inline structs before a target are discovered at EVERY revision, not
    // only at HEAD (#2095 r5 P1): one that was later renamed or removed still
    // shifted every field after it while it lived, and a member added to it
    // then is a layout era of its own.
    let tracked = structs;
    if (fields.length) {
      try {
        const here = inlineStructsBefore(src, fields).local;
        for (const n of here) if (!inline.local.includes(n)) historicalInline.add(n);
        tracked = [...new Set([...structs, ...here])];
      } catch {
        // no parseable Storage at this revision — the row structs are still compared
      }
    }
    const pos = storagePositionOf(src)?.position ?? null;
    const lastPos = positionEras[positionEras.length - 1];
    if (!lastPos || lastPos.position !== pos) {
      if (lastPos) changeEvents.push({ commit: c.sha, date: c.date, struct: '(storage position)', firstDifferentIndex: 0, before: lastPos.position ?? '(none)', after: pos ?? '(none)', lengthDelta: 0, kind: 'namespace-change' });
      positionEras.push({ position: pos, from: c.date, fromCommit: c.sha, to: c.date });
    } else lastPos.to = c.date;
    for (const s of tracked) {
      let seq;
      try {
        seq = extractDeclarations(src, s);
      } catch {
        continue; // the struct did not exist yet
      }
      // the prefix property is against HEAD; a struct HEAD no longer embeds has
      // nothing to be a prefix of — its removal from Storage is Storage's own event
      if (today[s]) {
        const v = isPrefix(seq, today[s]);
        if (!v.ok) violations.push({ commit: c.sha, date: c.date, struct: s, index: v.at, reason: v.reason });
        for (const r of v.renames) renames.add(`${s}@${r.index}: ${r.was} → ${r.now}`);
      }
      const prev = prevSeq[s];
      if (prev) {
        const a = prev.map(layoutType);
        const b = seq.map(layoutType);
        let i = 0;
        while (i < a.length && i < b.length && a[i] === b[i] && (fieldName(prev[i]) === fieldName(seq[i]) || moveReason(prev, seq, i) === null)) i++;
        const appendOnly = i === a.length && b.length >= a.length;
        // For `Storage` itself an append shifts nothing. For an INLINE or row
        // struct an append grows its footprint and shifts every Storage field
        // after it (#2095 r1 P1), so any length change there is an event too.
        const footprintBearing = s !== 'Storage';
        if (!appendOnly || (footprintBearing && seq.length !== prev.length)) {
          changeEvents.push({
            commit: c.sha,
            date: c.date,
            struct: s,
            firstDifferentIndex: i,
            before: prev[i] ?? '(end)',
            after: seq[i] ?? '(end)',
            lengthDelta: seq.length - prev.length,
            kind: appendOnly ? 'append' : seq.length > prev.length ? 'insertion' : seq.length < prev.length ? 'removal' : 'retype-or-swap',
          });
        }
      }
      prevSeq[s] = seq;
      if (s === 'Storage') {
        for (const f of fields) {
          const idx = seq.findIndex((d) => fieldName(d) === f);
          if (idx >= 0 && !introducedAt[f]) introducedAt[f] = { commit: c.sha, date: c.date, index: idx };
          const eras = indexEras[f];
          const last = eras[eras.length - 1];
          if (idx >= 0 && (!last || last.index !== idx)) eras.push({ index: idx, from: c.date, fromCommit: c.sha, to: c.date });
          else if (idx >= 0) last.to = c.date;
        }
      }
    }
  }
  const todayIndex = Object.fromEntries(fields.map((f) => [f, today.Storage.findIndex((d) => fieldName(d) === f)]));
  return {
    ok: violations.length === 0 && fields.every((f) => todayIndex[f] >= 0),
    head,
    since,
    libPath,
    commitsWalked: commits.length,
    structs: Object.fromEntries(structs.map((s) => [s, today[s].length])),
    inlineStructs: { ...inline, historical: [...historicalInline] },
    fields: Object.fromEntries(fields.map((f) => [f, { todayIndex: todayIndex[f], introducedAt: introducedAt[f] }])),
    renames: [...renames],
    violations,
    changeEvents,
    indexEras,
    positionEras,
    headFingerprint: layoutFingerprint(headSource, structs, fields),
  };
}

function main() {
  const argv = process.argv.slice(2);
  const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
  let fields = [];
  try {
    fields = Object.keys(JSON.parse(readFileSync(SLOTS_JSON, 'utf8')).fields);
  } catch {
    fields = ['nextLoanId', 'totalLoansEverCreated', 'intentLiveCommitCount', 'intentCommits', 'borrowerLifRebate', 'fallbackSnapshot'];
  }
  const v = walkProvenance({ since: arg('--since', DEFAULT_SINCE), fields });
  // A walk that saw no history proves nothing and must not print OK: a shallow
  // clone (CI's fetch-depth 1) has no commits to walk. Run this on a full
  // checkout; the tables it feeds are pinned in CI by StorageSlotPinTest and
  // by prepareStorageRead's cross-checks instead.
  if (v.commitsWalked < 2) {
    process.stderr.write(`storage-layout-provenance: refusing to report — only ${v.commitsWalked} commit(s) of ${v.libPath} visible since ${v.since} (shallow clone?); a walk over no history is not a verdict\n`);
    process.exit(2);
  }
  if (argv.includes('--json')) {
    process.stdout.write(JSON.stringify(v, null, 2) + '\n');
  } else {
    process.stdout.write(`storage-layout-provenance: ${v.ok ? 'OK' : 'VIOLATION'} — walked ${v.commitsWalked} commit(s) of ${v.libPath} since ${v.since}; HEAD ${v.head.slice(0, 9)}\n`);
    for (const [f, info] of Object.entries(v.fields)) {
      process.stdout.write(`  ${f.padEnd(24)} today index ${String(info.todayIndex).padStart(4)}  introduced ${info.introducedAt ? `${info.introducedAt.commit.slice(0, 9)} (${info.introducedAt.date.slice(0, 10)}, index ${info.introducedAt.index})` : 'before the walk began'}\n`);
    }
    process.stdout.write(`  inline structs before the targets: ${v.inlineStructs.local.join(', ') || 'none'}${v.inlineStructs.external.length ? ` (external, assumed stable: ${v.inlineStructs.external.join(', ')})` : ''}${v.inlineStructs.historical.length ? ` (at earlier revisions only: ${v.inlineStructs.historical.join(', ')})` : ''}\n`);
    for (const r of v.renames) process.stdout.write(`  note: rename (slot unchanged) ${r}\n`);
    for (const e of v.changeEvents) process.stdout.write(`  CHANGE ${e.commit.slice(0, 9)} (${e.date.slice(0, 10)}) ${e.struct} ${e.kind} at index ${e.firstDifferentIndex} (length ${e.lengthDelta >= 0 ? '+' : ''}${e.lengthDelta}): "${e.before.slice(0, 60)}" → "${e.after.slice(0, 60)}"\n`);
    for (const [f, eras] of Object.entries(v.indexEras)) if (eras.length > 1) process.stdout.write(`  eras ${f}: ${eras.map((e) => `index ${e.index} ${e.from.slice(0, 10)}..${e.to.slice(0, 10)}`).join(' | ')}\n`);
    process.stdout.write(`  violations: ${v.violations.length} commit(s) whose type sequence is not a prefix of HEAD's\n`);
  }
  process.exit(v.ok ? 0 : 1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolvePath(process.argv[1])) main();
