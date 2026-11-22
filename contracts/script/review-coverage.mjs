#!/usr/bin/env node
/**
 * review-coverage.mjs — the review coverage record (#3936,
 * ReviewCoveragePassDesign §2, §4).
 *
 * A piece of contract code is COVERED when its present text passed two
 * layers: a reader pass and a converged reviewer loop, each inside a review no
 * larger than the size limit. Coverage is recorded per DECLARATION: each
 * function, modifier, state variable, struct, enum, event, error, `using`
 * directive and contract header under contracts/src, identified by a hash of
 * its code with comments and spacing removed. So:
 *   - moved code keeps its hash and stays covered;
 *   - any edit changes the hash, so changed code loses coverage by itself;
 *   - a comment-only change keeps coverage.
 *
 * The declarations come from solc's parser (`stopAfter: "parsing"`), never
 * from reading text, and the parse needs no build, so it can be run over any
 * commit's files (the entry check does).
 *
 * Records, beside the contracts in contracts/review-coverage/:
 *   ledger.json    each hash with its marks: `reader` and `reviewer`, each an
 *                  opaque review number, plus the commit the hash was taken
 *                  at. No finding and no description, ever (design §4).
 *   accepted.json  declarations the owner accepted as uncovered, each with a
 *                  reason and a link to the owner's own words (design §8.5).
 *   exclusions     not a file: the excluded paths are {EXCLUDED} below, each
 *                  with its reason, and the report prints them.
 *
 * What the ledger does NOT say (printed first by every report): every piece
 * of code was reviewed, not every combination. A function unchanged since its
 * review may now be called from a new place (design §2.2).
 *
 * CLI:
 *   node contracts/script/review-coverage.mjs report [--json <path>] [--solc <path>]
 *   node contracts/script/review-coverage.mjs check  [--solc <path>]
 *   node contracts/script/review-coverage.mjs hashes [--file <src path>] [--solc <path>]
 *
 * `report --json <path>` writes the shape the launch check reads (#3937):
 *   { coveredBoth, total, uncovered: [{ declaration, ownerAcceptance }], ... }
 * where `coveredBoth` and `total` are amounts of declaration CODE (bytes of
 * normalized text), so the share is code covered over all code (design §10.6).
 * Extra fields (per-layer shares, counts, exclusions) may be added; those
 * three keep their meaning.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findSolc } from './check-signer-seam.mjs';
import { routedCallAt } from './refactor-reports.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
export const CONTRACTS_DIR = join(HERE, '..');
export const RECORD_DIR = join(CONTRACTS_DIR, 'review-coverage');
export const LEDGER_FILE = join(RECORD_DIR, 'ledger.json');
export const ACCEPTED_FILE = join(RECORD_DIR, 'accepted.json');
export const ORDER_FILE = join(RECORD_DIR, 'order.json');

/** Paths under contracts/ left out of the pass, each with its reason (design §6). */
export const EXCLUDED = [
  { prefix: 'src/vendor/', reason: 'code taken from upstream at a pinned commit; checked against upstream, not by review' },
  { prefix: 'src/storage-layout/', reason: 'storage-layout probes; never deployed' },
  { prefix: 'src/interfaces/', reason: "interfaces: an interface's declarations are covered with the code that implements them" },
];

export const LIMIT_LINE =
  'Coverage says every piece of code passed review, not every combination: a declaration unchanged since its review may now be called from a new place (ReviewCoveragePassDesign §2.2).';

// ─── Normalized text ─────────────────────────────────────────────────────

/**
 * The code of `text` with comments removed and spacing reduced to what keeps
 * two tokens apart: whitespace is dropped, except one space where both
 * neighbours are word characters (`uint256 a`, `return x`). String literals
 * are kept exactly, so a changed message is a changed declaration.
 */
export function normalize(text) {
  let out = '';
  let pendingSpace = false;
  const isWord = (c) => /[A-Za-z0-9_$]/.test(c);
  const push = (s) => {
    if (pendingSpace && out.length && isWord(out[out.length - 1]) && isWord(s[0])) out += ' ';
    pendingSpace = false;
    out += s;
  };
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const n = text[i + 1];
    if (c === '/' && n === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      pendingSpace = true;
    } else if (c === '/' && n === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 2;
      pendingSpace = true;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < text.length && text[j] !== c) j += text[j] === '\\' ? 2 : 1;
      push(text.slice(i, j + 1));
      i = j + 1;
    } else if (/\s/.test(c)) {
      pendingSpace = true;
      i++;
    } else {
      push(c);
      i++;
    }
  }
  return out;
}

export const hashOf = (normalized) => createHash('sha256').update(normalized).digest('hex');

// ─── Declarations ────────────────────────────────────────────────────────

const typeText = (t) => {
  if (!t) return '?';
  switch (t.nodeType) {
    case 'ElementaryTypeName':
      return t.name;
    case 'UserDefinedTypeName':
      return t.pathNode?.name ?? t.name ?? '?';
    case 'ArrayTypeName':
      return `${typeText(t.baseType)}[]`;
    case 'Mapping':
      return `mapping(${typeText(t.keyType)}=>${typeText(t.valueType)})`;
    case 'FunctionTypeName':
      return 'function';
    default:
      return t.nodeType;
  }
};
const params = (list) => (list?.parameters ?? []).map((p) => typeText(p.typeName)).join(',');

/** The name a declaration is shown under. Not part of its identity. */
function labelOf(node, contract) {
  const c = contract ? `${contract.name}.` : '';
  switch (node.nodeType) {
    case 'ContractDefinition':
      return `${node.name} (header)`;
    case 'FunctionDefinition': {
      const name = node.kind === 'function' || node.kind === 'freeFunction' ? node.name : node.kind;
      return `${c}${name}(${params(node.parameters)})`;
    }
    case 'ModifierDefinition':
      return `${c}modifier ${node.name}(${params(node.parameters)})`;
    case 'EventDefinition':
      return `${c}event ${node.name}(${params(node.parameters)})`;
    case 'ErrorDefinition':
      return `${c}error ${node.name}(${params(node.parameters)})`;
    case 'UsingForDirective':
      return `${c}using ${node.libraryName?.name ?? 'functions'} for ${node.typeName ? typeText(node.typeName) : '*'}`;
    default:
      return `${c}${node.name}`;
  }
}

const KINDS = new Set([
  'FunctionDefinition',
  'ModifierDefinition',
  'VariableDeclaration',
  'StructDefinition',
  'EnumDefinition',
  'EventDefinition',
  'ErrorDefinition',
  'UsingForDirective',
  'UserDefinedValueTypeDefinition',
]);

/**
 * Every declaration of one parsed source unit: `{ path, label, kind, hash,
 * size, start, end }`, where `size` is the length of the normalized code and
 * `start`/`end` are byte offsets. A contract's header is its text up to the
 * opening brace (name, kind, inheritance); its members are their own entries.
 */
export function declarationsOf(path, ast, bytes) {
  const out = [];
  const take = (node, contract, label, from, to) => {
    const text = bytes.subarray(from, to).toString('utf8');
    const norm = normalize(text);
    const contractKind = contract?.contractKind ?? (node.nodeType === 'ContractDefinition' ? node.contractKind : null);
    out.push({ path, label, kind: node.nodeType, hash: hashOf(norm), size: norm.length, start: from, end: to, contract: contract?.name ?? null, contractKind });
  };
  const span = (n) => {
    const [s, l] = n.src.split(':').map(Number);
    return [s, s + l];
  };
  for (const n of ast.nodes ?? []) {
    if (n.nodeType === 'ContractDefinition') {
      const [s, e] = span(n);
      const brace = bytes.indexOf('{', s);
      take(n, null, labelOf(n), s, brace >= 0 && brace < e ? brace : e);
      for (const m of n.nodes ?? []) {
        if (!KINDS.has(m.nodeType)) continue;
        const [ms, me] = span(m);
        take(m, n, labelOf(m, n), ms, me);
      }
    } else if (KINDS.has(n.nodeType)) {
      const [s, e] = span(n);
      take(n, null, labelOf(n), s, e);
    }
  }
  return out;
}

/** Parse `{ path: contentBuffer }` with solc's parser; returns Map(path → ast). */
export function parseSources(sources, solc) {
  const input = {
    language: 'Solidity',
    sources: Object.fromEntries(Object.entries(sources).map(([p, b]) => [p, { content: b.toString('utf8') }])),
    settings: { stopAfter: 'parsing', outputSelection: { '*': { '': ['ast'] } } },
  };
  const r = spawnSync(solc, ['--standard-json'], { input: JSON.stringify(input), encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024 });
  if (r.status !== 0 && !r.stdout) throw new Error(`solc failed: ${r.stderr}`);
  const out = JSON.parse(r.stdout);
  const errors = (out.errors ?? []).filter((e) => e.severity === 'error');
  if (errors.length) throw new Error(errors.map((e) => e.formattedMessage ?? e.message).join('\n'));
  const asts = new Map();
  for (const [p, v] of Object.entries(out.sources ?? {})) asts.set(p, v.ast);
  return asts;
}

export const INTERFACE_REASON = "an interface's declarations are covered with the code that implements them";

/** Why a declaration is left out of the pass, or undefined. */
export function excludedReason(d) {
  return EXCLUDED.find((x) => d.path.startsWith(x.prefix))?.reason ?? (d.contractKind === 'interface' ? INTERFACE_REASON : undefined);
}

/** Every .sol path under contracts/src, relative to contracts/. */
export function srcFiles(dir = join(CONTRACTS_DIR, 'src')) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...srcFiles(p));
    else if (name.endsWith('.sol')) out.push(relative(CONTRACTS_DIR, p).split(sep).join('/'));
  }
  return out.sort();
}

/** The declarations of the tree whose files `read(path)` returns. */
export function treeDeclarations(paths, read, solc) {
  const sources = Object.fromEntries(paths.map((p) => [p, read(p)]));
  const asts = parseSources(sources, solc);
  const decls = [];
  for (const p of paths) decls.push(...declarationsOf(p, asts.get(p), sources[p]));
  return decls;
}

// ─── Ledger and report ───────────────────────────────────────────────────

export function readJson(p, fallback) {
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : fallback;
}

/** The area a path belongs to: its folder under src/ (a top-level file is `src`). */
export const areaOf = (path) => {
  const parts = path.split('/');
  return parts.length > 2 ? parts[1] : 'src';
};

/**
 * The coverage report. `ledger.entries` maps hash → { reader, reviewer,
 * commit }; `accepted.declarations` maps a declaration's label → { reason,
 * owner }. Pure.
 */
export function buildReport(decls, ledger, accepted) {
  const entries = ledger?.entries ?? {};
  const acc = accepted?.declarations ?? {};
  const excluded = [];
  const counted = [];
  for (const d of decls) {
    const why = excludedReason(d);
    if (why) excluded.push(d);
    else counted.push(d);
  }
  const z = () => ({ total: 0, reader: 0, reviewer: 0, both: 0, declarations: 0, declarationsBoth: 0 });
  const totals = z();
  const byArea = {};
  const byFile = {};
  const uncovered = [];
  for (const d of counted) {
    const e = entries[d.hash] ?? {};
    const r = Boolean(e.reader);
    const v = Boolean(e.reviewer);
    for (const t of [totals, (byArea[areaOf(d.path)] ??= z()), (byFile[d.path] ??= z())]) {
      t.total += d.size;
      t.declarations += 1;
      if (r) t.reader += d.size;
      if (v) t.reviewer += d.size;
      if (r && v) {
        t.both += d.size;
        t.declarationsBoth += 1;
      }
    }
    if (!(r && v)) {
      const key = `${d.path}:${d.label}`;
      uncovered.push({
        declaration: key,
        layers: { reader: r, reviewer: v },
        ownerAcceptance: acc[key] ?? null,
      });
    }
  }
  const exclusions = EXCLUDED.map((x) => ({
    prefix: x.prefix,
    reason: x.reason,
    declarations: excluded.filter((d) => d.path.startsWith(x.prefix)).length,
  }));
  exclusions.push({
    prefix: '(any interface)',
    reason: INTERFACE_REASON,
    declarations: excluded.filter((d) => !EXCLUDED.some((x) => d.path.startsWith(x.prefix))).length,
  });
  return {
    limit: LIMIT_LINE,
    sizeLimit: ledger?.sizeLimit ?? null,
    unit: 'bytes of declaration code with comments and spacing removed',
    coveredBoth: totals.both,
    total: totals.total,
    coveredReader: totals.reader,
    coveredReviewer: totals.reviewer,
    declarations: totals.declarations,
    declarationsCoveredBoth: totals.declarationsBoth,
    byArea,
    byFile,
    uncovered,
    exclusions,
  };
}

const pct = (a, b) => (b ? ((100 * a) / b).toFixed(1) : '100.0');

export function printReport(r, log = console.log) {
  log(r.limit);
  log(`Size limit: ${r.sizeLimit ? `${r.sizeLimit.lines} lines, set by ${r.sizeLimit.setBy}` : 'not yet set by a planted-fault run'}`);
  log(`Covered by both layers: ${pct(r.coveredBoth, r.total)}% of declaration code (${r.declarationsCoveredBoth}/${r.declarations} declarations); reader pass ${pct(r.coveredReader, r.total)}%, reviewer loop ${pct(r.coveredReviewer, r.total)}%`);
  log('By area (both / reader / reviewer):');
  for (const [a, t] of Object.entries(r.byArea).sort()) {
    log(`  ${a.padEnd(14)} ${pct(t.both, t.total).padStart(5)}% ${pct(t.reader, t.total).padStart(5)}% ${pct(t.reviewer, t.total).padStart(5)}%  (${t.declarations} declarations)`);
  }
  log('Excluded:');
  for (const x of r.exclusions) log(`  ${x.prefix} (${x.declarations} declarations): ${x.reason}`);
  const open = r.uncovered.filter((u) => !u.ownerAcceptance).length;
  log(`Uncovered: ${r.uncovered.length} declarations (${r.uncovered.length - open} accepted by the owner)`);
}

// ─── The entry check ─────────────────────────────────────────────────────

/**
 * Problems with the ledger itself (design §4, §10.4, §10.11, §10.13). Each
 * entry's hash must be a declaration of the tree at the commit it names;
 * `declsAt(commit)` returns that tree's hashes as a Set (or throws when the
 * commit is unknown). A reader mark whose reading thread is the thread that
 * wrote the fix under review is refused, and so is a reviewer mark recorded
 * while the latest planted-fault run has a miss.
 */
export function ledgerProblems(ledger, declsAt) {
  const problems = [];
  const entries = ledger?.entries ?? {};
  const cache = new Map();
  const planted = ledger?.plantedRuns ?? [];
  const latestMiss = planted.length && planted[planted.length - 1].missed > 0 ? planted[planted.length - 1] : null;
  for (const [hash, e] of Object.entries(entries)) {
    if (!/^[0-9a-f]{64}$/.test(hash)) problems.push(`entry ${hash}: not a declaration hash`);
    if (!e.commit || !/^[0-9a-f]{7,40}$/.test(e.commit)) {
      problems.push(`entry ${hash.slice(0, 12)}: names no commit`);
      continue;
    }
    if (!e.reader && !e.reviewer) problems.push(`entry ${hash.slice(0, 12)}: carries no mark`);
    for (const k of Object.keys(e)) if (!['reader', 'reviewer', 'commit', 'readerThread', 'fixThread', 'recordedAt'].includes(k)) problems.push(`entry ${hash.slice(0, 12)}: unknown field ${k} (the ledger holds marks only)`);
    if (e.reader && e.readerThread && e.fixThread && e.readerThread === e.fixThread) {
      problems.push(`entry ${hash.slice(0, 12)}: the reader pass was made by the thread that wrote the fix under review`);
    }
    if (e.reviewer && latestMiss && e.recordedAt && e.recordedAt > latestMiss.at) {
      problems.push(`entry ${hash.slice(0, 12)}: a reviewer mark recorded while the latest planted-fault run (${latestMiss.id}) has a miss`);
    }
    let set = cache.get(e.commit);
    if (!set) {
      try {
        set = declsAt(e.commit);
      } catch (err) {
        problems.push(`entry ${hash.slice(0, 12)}: commit ${e.commit} cannot be read (${err.message.split('\n')[0]})`);
        continue;
      }
      cache.set(e.commit, set);
    }
    if (!set.has(hash)) problems.push(`entry ${hash.slice(0, 12)}: matches no declaration at ${e.commit}`);
  }
  return problems;
}

/** The declaration hashes of contracts/src at `commit`, read through git. */
export function hashesAtCommit(commit, solc) {
  const ls = spawnSync('git', ['ls-tree', '-r', '--name-only', commit, '--', 'src'], { cwd: CONTRACTS_DIR, encoding: 'utf8' });
  if (ls.status !== 0) throw new Error(ls.stderr.trim() || `git ls-tree ${commit} failed`);
  const paths = ls.stdout.split('\n').filter((p) => p.endsWith('.sol'));
  const read = (p) => {
    const r = spawnSync('git', ['show', `${commit}:contracts/${p}`], { cwd: CONTRACTS_DIR, maxBuffer: 1024 * 1024 * 256 });
    if (r.status !== 0) throw new Error(`git show ${commit}:contracts/${p} failed`);
    return r.stdout;
  };
  return new Set(treeDeclarations(paths, read, solc).map((d) => d.hash));
}

// ─── The unit tool ───────────────────────────────────────────────────────

export const DEFAULT_LIMIT = 1000;

const lineAt = (bytes, offset) => {
  let n = 1;
  for (let i = 0; i < offset && i < bytes.length; i++) if (bytes[i] === 10) n++;
  return n;
};

/**
 * The declarations of every src unit of a full build (the AST with
 * references), keyed by `<path>:<start>`, with their line spans. Each
 * declaration's hash is computed exactly as {declarationsOf} computes it
 * from the parser, because both read the same source bytes.
 */
export function buildDeclarations(units, read) {
  const byKey = new Map();
  const byPath = new Map();
  for (const u of units) {
    if (typeof u.absolutePath !== 'string' || !u.absolutePath.startsWith('src/')) continue;
    const bytes = read(u.absolutePath);
    const list = declarationsOf(u.absolutePath, u, bytes).map((d) => ({
      ...d,
      lineStart: lineAt(bytes, d.start),
      lineEnd: lineAt(bytes, d.end),
    }));
    byPath.set(u.absolutePath, list);
    for (const d of list) byKey.set(`${d.path}:${d.start}`, d);
  }
  return { byKey, byPath };
}

const startOf = (node) => Number(node.src.split(':')[0]);

/**
 * The functions and modifiers a body calls directly, by node id: internal
 * calls, library calls and modifiers. Routed self-calls through the Diamond
 * are another facet's unit, so they are listed as outside calls by selector.
 */
function directCallees(fn, ctx, walk) {
  const ids = new Set();
  const selectors = new Set();
  for (const m of fn.modifiers ?? []) {
    const d = ctx.byId.get(m.modifierName?.referencedDeclaration);
    if (d?.nodeType === 'ModifierDefinition') ids.add(d.id);
  }
  walk(fn.body, (n) => {
    if (n.nodeType === 'FunctionCall') {
      const e = n.expression;
      const d = e?.referencedDeclaration === undefined ? undefined : ctx.byId.get(e.referencedDeclaration);
      if (d?.nodeType === 'FunctionDefinition' && d.body) {
        const lib = ctx.contractOf.get(d.id)?.contractKind === 'library';
        const ext = d.visibility === 'external' && e.nodeType === 'MemberAccess';
        if (!ext || lib) ids.add(d.id);
      }
    }
    const r = routedCallAt(n, ctx);
    if (r) selectors.add(`${r.contract.name}.${r.fn.name}`);
    return undefined;
  });
  return { ids, selectors };
}

/**
 * Derive the review unit for one facet or standalone contract (design §3.2):
 * its own declarations (and those of its non-library bases), plus the library
 * functions and modifiers it reaches that are not covered yet and do not
 * belong to a shared library (which is reviewed in slices of its own).
 * Covered declarations are dropped. Over `limit` lines, the unit is split into
 * slices of whole declarations, the contract's own first, in file order.
 *
 * `ctx` comes from refactor-reports' makeContext; `reachFn` is its reach.
 */
export function deriveUnit(name, { ctx, reachFn, walk, decls, ledger, shared = [], limit = DEFAULT_LIMIT }) {
  const c = ctx.contracts.get(name);
  if (!c) throw new Error(`no contract ${name} in the build`);
  const entries = ledger?.entries ?? {};
  const covered = (d) => Boolean(entries[d.hash]?.reader && entries[d.hash]?.reviewer);
  const sharedSet = new Set(shared);
  const own = [];
  const ownIds = new Set();
  const bases = (c.linearizedBaseContracts ?? [c.id]).map((id) => ctx.byId.get(id)).filter(Boolean);
  for (const b of bases) {
    if (b.contractKind === 'interface' || (b.contractKind === 'library' && b.id !== c.id)) continue;
    const header = decls.byKey.get(`${ctx.pathOf(b.id)}:${startOf(b)}`);
    if (header) own.push(header);
    for (const m of b.nodes ?? []) {
      const d = decls.byKey.get(`${ctx.pathOf(b.id)}:${startOf(m)}`);
      if (d) {
        own.push(d);
        ownIds.add(m.id);
      }
    }
  }
  // Library functions reached from the contract's own code, without crossing
  // a routed self-call.
  const reachedLib = new Map();
  for (const b of bases) {
    for (const m of b.nodes ?? []) {
      if (m.nodeType !== 'FunctionDefinition' && m.nodeType !== 'ModifierDefinition') continue;
      if (!m.body) continue;
      const { functions } = reachFn(m, c, ctx, undefined, { selfCalls: false });
      for (const id of functions) {
        const owner = ctx.contractOf.get(id);
        if (owner?.contractKind !== 'library' || sharedSet.has(owner.name)) continue;
        const node = ctx.byId.get(id);
        const d = decls.byKey.get(`${ctx.pathOf(owner.id)}:${startOf(node)}`);
        if (d && !excludedReason(d)) reachedLib.set(d.path + ':' + d.start, { d, id });
      }
    }
  }
  const libs = [...reachedLib.values()].sort((a, b) => (a.d.path === b.d.path ? a.d.start - b.d.start : a.d.path < b.d.path ? -1 : 1));
  const all = [...own.filter((d) => !excludedReason(d)), ...libs.map((x) => x.d)];
  let members = all.filter((d) => !covered(d));
  // A library's storage structs and enums are read first, as their own
  // slice, because every later slice depends on them (design §3.2).
  if (c.contractKind === 'library') {
    const types = members.filter((d) => d.kind === 'StructDefinition' || d.kind === 'EnumDefinition');
    if (types.length) members = [...types, ...members.filter((d) => !types.includes(d))];
  }
  const lines = (d) => d.lineEnd - d.lineStart + 1;
  const slices = [];
  let cur = [];
  let size = 0;
  const typeSlice = c.contractKind === 'library';
  for (const d of members) {
    const isType = d.kind === 'StructDefinition' || d.kind === 'EnumDefinition';
    const endTypes = typeSlice && cur.length && !isType && (cur[cur.length - 1].kind === 'StructDefinition' || cur[cur.length - 1].kind === 'EnumDefinition');
    if (cur.length && (size + lines(d) > limit || endTypes)) {
      slices.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(d);
    size += lines(d);
  }
  if (cur.length) slices.push(cur);
  return {
    name,
    limit,
    dropped: all.length - members.length,
    lines: members.reduce((a, d) => a + lines(d), 0),
    slices: slices.map((s) => ({ lines: s.reduce((a, d) => a + lines(d), 0), declarations: s, oversize: s.length === 1 && lines(s[0]) > limit })),
    sharedSkipped: [...sharedSet],
  };
}

/** The pull request description for one slice (design §3.2). */
export function describeSlice(unit, index, { ctx, walk, decls }) {
  const slice = unit.slices[index];
  const inUnit = new Set(slice.declarations.map((d) => `${d.path}:${d.start}`));
  // Callers across the tree, by declaration key.
  const callers = new Map();
  const nodeOf = new Map();
  for (const [id, node] of ctx.byId) {
    if ((node.nodeType === 'FunctionDefinition' || node.nodeType === 'ModifierDefinition') && node.body) {
      const owner = ctx.contractOf.get(id);
      if (!owner) continue;
      const key = `${ctx.pathOf(owner.id)}:${startOf(node)}`;
      nodeOf.set(key, node);
      for (const cid of directCallees(node, ctx, walk).ids) {
        const co = ctx.contractOf.get(cid);
        if (!co) continue;
        const ck = `${ctx.pathOf(co.id)}:${startOf(ctx.byId.get(cid))}`;
        if (!callers.has(ck)) callers.set(ck, new Set());
        const caller = decls.byKey.get(key);
        if (caller) callers.get(ck).add(`${caller.path}:${caller.label}`);
      }
    }
  }
  const out = [];
  out.push(`Review unit ${unit.name}, slice ${index + 1} of ${unit.slices.length}: ${slice.declarations.length} declarations, ${slice.lines} lines (limit ${unit.limit}).`);
  out.push('');
  out.push(LIMIT_LINE);
  out.push('');
  for (const d of slice.declarations) {
    out.push(`- \`${d.path}:${d.lineStart}-${d.lineEnd}\` ${d.label}`);
    const node = nodeOf.get(`${d.path}:${d.start}`);
    if (node) {
      const { ids, selectors } = directCallees(node, ctx, walk);
      const outside = [];
      for (const cid of ids) {
        const co = ctx.contractOf.get(cid);
        const ck = co && `${ctx.pathOf(co.id)}:${startOf(ctx.byId.get(cid))}`;
        if (ck && !inUnit.has(ck)) outside.push(decls.byKey.get(ck)?.label ?? ck);
      }
      for (const sel of selectors) outside.push(`${sel} (through the Diamond)`);
      if (outside.length) out.push(`  - calls outside the unit: ${[...new Set(outside)].sort().join(', ')}`);
    }
    const by = callers.get(`${d.path}:${d.start}`);
    if (by?.size) out.push(`  - called by: ${[...by].sort().join(', ')}`);
  }
  return out.join('\n');
}

// ─── The size ladder and the planted-fault run (design §2.3, §7.1) ─────

export const RUNGS = [1000, 1500, 2000];
export const PLANTED_INTERVAL = 10;

/**
 * Apply one planted-fault run to the ledger. Pure: returns
 * `{ ledger, changed: string[], reReview: string[] }`.
 * - A miss at any size steps the limit down one rung (not below the first),
 *   and every reviewer mark recorded since the last run caught in full is
 *   removed: those units are reviewed again at the smaller size.
 * - A full catch at the next rung steps the limit up to it. A step up is
 *   never taken any other way.
 */
export function applyPlantedRun(ledger, run) {
  if (!run?.id || !run.at || !(run.size > 0) || !(run.planted > 0) || !(run.missed >= 0) || run.missed > run.planted) {
    throw new Error('a planted-fault run needs id, at, size, planted > 0 and 0 <= missed <= planted');
  }
  const next = structuredClone(ledger);
  next.plantedRuns = [...(next.plantedRuns ?? []), { id: run.id, at: run.at, size: run.size, planted: run.planted, missed: run.missed }];
  const current = next.sizeLimit?.lines ?? RUNGS[0];
  const idx = Math.max(0, RUNGS.indexOf(current));
  const changed = [];
  const reReview = [];
  if (run.missed > 0) {
    const lower = RUNGS[Math.max(0, idx - 1)];
    const lastFull = [...(ledger.plantedRuns ?? [])].reverse().find((r) => r.missed === 0);
    for (const [hash, e] of Object.entries(next.entries ?? {})) {
      if (e.reviewer && (!lastFull || !e.recordedAt || e.recordedAt > lastFull.at)) {
        reReview.push(e.reviewer);
        delete e.reviewer;
        if (!e.reader) delete next.entries[hash];
      }
    }
    next.sizeLimit = { lines: lower, setBy: run.id };
    changed.push(`a miss in ${run.id}: the limit is ${lower} lines`);
  } else if (RUNGS[idx + 1] !== undefined && run.size === RUNGS[idx + 1]) {
    next.sizeLimit = { lines: run.size, setBy: run.id };
    changed.push(`a full catch at ${run.size} lines in ${run.id}: the limit steps up`);
  } else if (!next.sizeLimit) {
    next.sizeLimit = { lines: current, setBy: run.id };
  }
  return { ledger: next, changed, reReview: [...new Set(reReview)].sort() };
}

/** Whether a planted-fault run is due: ten units have converged since the last one. */
export function plantedRunDue(ledger, interval = PLANTED_INTERVAL) {
  const last = (ledger.plantedRuns ?? []).at(-1);
  const since = new Set();
  for (const e of Object.values(ledger.entries ?? {})) {
    if (e.reviewer && (!last || (e.recordedAt && e.recordedAt > last.at))) since.add(e.reviewer);
  }
  return { due: !last || since.size >= interval, unitsSince: since.size, interval };
}

// ─── Review branches and the one-way copy (design §3, §3.1) ────────────

export const REVIEW_PREFIX = 'claude/review-';
export const PLANTED_PREFIX = 'claude/planted-';

/** A review-only pull request is recognised by its base branch's name, never a label. */
export const isReviewOnlyBase = (ref) => typeof ref === 'string' && ref.startsWith(REVIEW_PREFIX) && ref !== 'main';
export const isPlantedBase = (ref) => typeof ref === 'string' && ref.startsWith(PLANTED_PREFIX);

/**
 * The base tree of a review: each file of the unit with the unit's
 * declarations removed (the base need not compile). `files` maps path →
 * Buffer of the head. Returns path → Buffer for the changed files only.
 */
export function baseFiles(files, declarations) {
  const byPath = new Map();
  for (const d of declarations) {
    if (!byPath.has(d.path)) byPath.set(d.path, []);
    byPath.get(d.path).push(d);
  }
  const out = {};
  for (const [path, list] of byPath) {
    const head = files[path];
    if (!head) throw new Error(`no head text for ${path}`);
    const cuts = list.map((d) => [d.start, d.end]).sort((a, b) => b[0] - a[0]);
    let buf = head;
    for (const [from, to] of cuts) buf = Buffer.concat([buf.subarray(0, from), buf.subarray(to)]);
    out[path] = buf;
  }
  return out;
}

/**
 * Refusals before a review-only pull request is opened (design §10.3,
 * §10.9, §10.12). `diff(a, b)` returns the paths that differ between two
 * trees; `fixPaths` are the paths the unit's fix branch changes.
 */
export function reviewPrProblems({ base, head, pinned, baseTree, headTree, unitPaths, fixPaths = [], diff }) {
  const p = [];
  if (!isReviewOnlyBase(base)) p.push(`base ${base} is not a ${REVIEW_PREFIX} branch: a review-only pull request is never opened against main or another branch`);
  if (!head?.startsWith(REVIEW_PREFIX)) p.push(`head ${head} is not a ${REVIEW_PREFIX} branch`);
  const headVsPinned = diff(pinned, headTree).filter((x) => !fixPaths.includes(x));
  if (headVsPinned.length) p.push(`the head differs from the pinned commit outside the unit's fix branch: ${headVsPinned.slice(0, 5).join(', ')}`);
  const baseVsHead = diff(headTree, baseTree).filter((x) => !unitPaths.includes(x));
  if (baseVsHead.length) p.push(`the base differs from the head outside the unit's files: ${baseVsHead.slice(0, 5).join(', ')}`);
  return p;
}

/**
 * Refusals before the one-way copy of a pinned commit to the review
 * repository (design §3.1, §10.16): its workflows must be switched off, and
 * the target is the review repository's own `main`, set to the commit and
 * nothing else. `actions` is the repository's Actions permission answer.
 */
export function copyProblems({ actions, commit, repo }) {
  const p = [];
  if (!/^[0-9a-f]{40}$/.test(commit ?? '')) p.push('the copy takes a full pinned commit hash');
  if (!repo || repo === 'vaipakam/vaipakam') p.push('the copy goes to the private review repository, never this one');
  if (!actions) p.push('no answer about the review repository\'s workflows: refusing (no answer is a refusal)');
  else if (actions.enabled !== false) p.push('workflows are enabled in the review repository: switch Actions off before any copy');
  return p;
}

/**
 * What the copy to the review repository leaves out (#3944): the workflow
 * files and the dependency-update config, so nothing in the review
 * repository can run or open pull requests on its own, whatever its settings
 * say. A path ending in `/` is a directory.
 */
export const COPY_STRIPPED = ['.github/workflows/', '.github/dependabot.yml'];
const isStripped = (path) => COPY_STRIPPED.some((s) => (s.endsWith('/') ? path.startsWith(s) : path === s));

/**
 * The copy must differ from the pinned commit by exactly the stripped paths,
 * each deleted. `diff` is `[{ status, path }]` from `git diff --name-status
 * <pinned> <copy>`; `pinnedPaths` is every file of the pinned tree.
 */
export function strippedCopyProblems({ diff, pinnedPaths }) {
  const p = [];
  const expected = new Set(pinnedPaths.filter(isStripped));
  const seen = new Set();
  for (const { status, path } of diff) {
    if (!isStripped(path)) p.push(`the copy changes ${path}, which is not a stripped path`);
    else if (status !== 'D') p.push(`the copy ${status === 'A' ? 'adds' : 'changes'} ${path} instead of leaving it out`);
    seen.add(path);
  }
  for (const path of expected) if (!seen.has(path)) p.push(`the copy still carries ${path}`);
  return p;
}

// ─── Git and GitHub glue (the review repository) ────────────────────────

const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 1024 * 1024 * 256, ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.slice(0, 3).join(' ')} failed: ${(r.stderr || r.stdout).trim().split('\n')[0]}`);
  return r.stdout.trim();
};
const gh = (args) => JSON.parse(run('gh', ['api', ...args]) || 'null');
const gitDiffNames = (clone) => (a, b) => run('git', ['diff', '--name-only', a, b], { cwd: clone }).split('\n').filter(Boolean);

/**
 * Make the two branches of one review slice in a local clone of the review
 * repository: the head at the pinned commit (plus the unit's fix branch, when
 * given, merged on top), and the base: the head with the slice's
 * declarations removed. Checked against {reviewPrProblems} before anything
 * is pushed.
 */
export function makeReviewBranches({ clone, unit, slice, pinned, fix }) {
  const tag = `${unit.name.toLowerCase()}-${slice + 1}`;
  const head = `${REVIEW_PREFIX}${tag}-head`;
  const base = `${REVIEW_PREFIX}${tag}-base`;
  run('git', ['checkout', '-q', '-B', head, pinned], { cwd: clone });
  let fixPaths = [];
  if (fix) {
    run('git', ['merge', '-q', '--no-edit', fix], { cwd: clone });
    fixPaths = gitDiffNames(clone)(pinned, head);
  }
  const decls = unit.slices[slice].declarations;
  const files = {};
  for (const d of decls) files[d.path] ??= readFileSync(join(clone, 'contracts', d.path));
  const cut = baseFiles(files, decls);
  run('git', ['checkout', '-q', '-B', base, head], { cwd: clone });
  for (const [path, buf] of Object.entries(cut)) writeFileSync(join(clone, 'contracts', path), buf);
  run('git', ['add', '-A', 'contracts/src'], { cwd: clone });
  run('git', ['-c', 'user.name=review-coverage', '-c', 'user.email=review-coverage@invalid', 'commit', '-q', '-m', `Review base for ${unit.name} slice ${slice + 1}: its declarations removed`], { cwd: clone });
  const problems = reviewPrProblems({
    base,
    head,
    pinned,
    baseTree: base,
    headTree: head,
    unitPaths: Object.keys(cut).map((p) => `contracts/${p}`),
    fixPaths,
    diff: gitDiffNames(clone),
  });
  return { head, base, problems };
}

/** Branches under the review prefixes that no open pull request uses (design §7.1, §10.14). */
export function strayBranches(branches, openPulls) {
  const used = new Set();
  for (const pr of openPulls) {
    used.add(pr.base);
    used.add(pr.head);
  }
  return branches.filter((b) => (b.startsWith(REVIEW_PREFIX) || b.startsWith(PLANTED_PREFIX)) && !used.has(b)).sort();
}

// ─── CLI ─────────────────────────────────────────────────────────────────

function flags(rest) {
  const f = { _: [] };
  for (let i = 0; i < rest.length; i++) {
    if (rest[i].startsWith('--')) f[rest[i].slice(2)] = rest[i + 1] !== undefined && !rest[i + 1].startsWith('--') ? rest[++i] : true;
    else f._.push(rest[i]);
  }
  return f;
}

/**
 * The commands that act on the review repository or the ladder:
 *   planted record --id <id> --size <lines> --planted <n> --missed <n> [--at <iso>]
 *   planted due
 *   branches <Unit> --slice <n> --clone <dir> --pinned <sha> [--fix <ref>] [--push]
 *   open --repo <owner/name> --base <branch> --head <branch> --title <text> --body-file <path>
 *   close --repo <owner/name> --pr <n>          (closes, then deletes both branches)
 *   strays --repo <owner/name>                  (review branches with no open pull request)
 *   copy --repo <owner/name> --commit <sha> --clone <dir>
 */
async function reviewRepoCommand(cmd, rest) {
  const f = flags(rest);
  try {
    if (['open', 'close', 'strays', 'copy'].includes(cmd) && !/^[\w.-]+\/[\w.-]+$/.test(f.repo ?? '')) throw new Error(`${cmd} needs --repo <owner/name> (the private review repository)`);
    if (cmd === 'planted') {
      const ledger = readJson(LEDGER_FILE, { entries: {} });
      if (f._[0] === 'due') {
        const d = plantedRunDue(ledger);
        console.log(d.due ? `  ⚠ a planted-fault run is due (${d.unitsSince} units since the last, interval ${d.interval})` : `  ✓ not due (${d.unitsSince} of ${d.interval} units since the last run)`);
        return 0;
      }
      if (f._[0] !== 'record') throw new Error('planted record ... | planted due');
      const r = applyPlantedRun(ledger, {
        id: f.id,
        at: f.at ?? new Date().toISOString(),
        size: Number(f.size),
        planted: Number(f.planted),
        missed: Number(f.missed),
      });
      writeFileSync(LEDGER_FILE, `${JSON.stringify(r.ledger, null, 2)}\n`);
      for (const c of r.changed) console.log(`  · ${c}`);
      if (r.reReview.length) console.log(`  ⚠ reviewer marks removed, to review again at the smaller size: ${r.reReview.join(', ')}`);
      return 0;
    }
    if (cmd === 'branches') {
      if (!f._[0] || !f.slice || !f.clone || !f.pinned) throw new Error('branches <Unit> --slice <n> --clone <dir> --pinned <sha>');
      const g = await loadGraph();
      const ledger = readJson(LEDGER_FILE, { entries: {} });
      const order = readJson(ORDER_FILE, { sharedLibraries: [] });
      const decls = buildDeclarations(g.units, (p) => readFileSync(join(CONTRACTS_DIR, p)));
      const unit = deriveUnit(f._[0], { ...g, decls, ledger, shared: order.sharedLibraries ?? [], limit: ledger.sizeLimit?.lines ?? DEFAULT_LIMIT });
      const { head, base, problems } = makeReviewBranches({ clone: f.clone, unit, slice: Number(f.slice) - 1, pinned: f.pinned, fix: f.fix });
      for (const p of problems) console.error(`  ✗ ${p}`);
      if (problems.length) return 1;
      if (f.push) run('git', ['push', '-q', 'origin', head, base], { cwd: f.clone });
      console.log(`  ✓ ${base} and ${head}${f.push ? ' pushed' : ' made (not pushed)'}`);
      return 0;
    }
    if (cmd === 'open') {
      if (!isReviewOnlyBase(f.base) || f.repo === 'vaipakam/vaipakam') throw new Error(`refusing: a review-only pull request needs a ${REVIEW_PREFIX} base, in the review repository`);
      const pr = gh(['-X', 'POST', `repos/${f.repo}/pulls`, '-f', `title=${f.title}`, '-f', `head=${f.head}`, '-f', `base=${f.base}`, '-F', `body=@${f['body-file']}`]);
      console.log(`  ✓ opened ${pr.html_url}`);
      return 0;
    }
    if (cmd === 'close') {
      const pr = gh([`repos/${f.repo}/pulls/${f.pr}`]);
      if (!isReviewOnlyBase(pr.base.ref) && !isPlantedBase(pr.base.ref)) throw new Error(`refusing: #${f.pr} is not a review-only or planted-fault pull request`);
      gh(['-X', 'PATCH', `repos/${f.repo}/pulls/${f.pr}`, '-f', 'state=closed']);
      for (const ref of [pr.head.ref, pr.base.ref]) gh(['-X', 'DELETE', `repos/${f.repo}/git/refs/heads/${ref}`]);
      console.log(`  ✓ closed #${f.pr} and deleted ${pr.base.ref}, ${pr.head.ref}`);
      return 0;
    }
    if (cmd === 'strays') {
      const branches = gh(['--paginate', `repos/${f.repo}/branches?per_page=100`]).map((b) => b.name);
      const open = gh(['--paginate', `repos/${f.repo}/pulls?state=open&per_page=100`]).map((p) => ({ base: p.base.ref, head: p.head.ref }));
      const stray = strayBranches(branches, open);
      for (const b of stray) console.log(`  ⚠ ${b}: no open pull request`);
      if (!stray.length) console.log('  ✓ every review branch belongs to an open pull request');
      return 0;
    }
    if (cmd === 'copy') {
      let actions = null;
      try {
        actions = gh([`repos/${f.repo}/actions/permissions`]);
      } catch {
        actions = null;
      }
      const problems = copyProblems({ actions, commit: f.commit, repo: f.repo });
      for (const p of problems) console.error(`  ✗ ${p}`);
      if (problems.length) return 1;
      // The copy: the pinned tree without the stripped paths, as a commit of
      // its own (no parent, so no history travels with it).
      const env = { ...process.env, GIT_INDEX_FILE: join(f.clone, '.git', 'review-copy-index') };
      run('git', ['read-tree', f.commit], { cwd: f.clone, env });
      run('git', ['rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', ...COPY_STRIPPED], { cwd: f.clone, env });
      const tree = run('git', ['write-tree'], { cwd: f.clone, env });
      const copy = run('git', ['commit-tree', tree, '-m', `Review copy of ${f.commit}, without workflows or the dependency-update config`], { cwd: f.clone });
      const diff = run('git', ['diff', '--no-renames', '--name-status', f.commit, copy], { cwd: f.clone })
        .split('\n').filter(Boolean).map((l) => ({ status: l.split('\t')[0], path: l.split('\t')[1] }));
      const pinnedPaths = run('git', ['ls-tree', '-r', '--name-only', f.commit], { cwd: f.clone }).split('\n').filter(Boolean);
      const stripped = strippedCopyProblems({ diff, pinnedPaths });
      for (const p of stripped) console.error(`  ✗ ${p}`);
      if (stripped.length) return 1;
      run('git', ['push', '-q', '--force', `https://github.com/${f.repo}.git`, `${copy}:refs/heads/main`], { cwd: f.clone });
      console.log(`  ✓ ${f.repo} main is ${copy}: ${f.commit} without ${COPY_STRIPPED.join(', ')}`);
      console.log(`    pass ${copy} as --pinned to \`branches\`: review slices are cut from the copy`);
      return 0;
    }
  } catch (e) {
    console.error(`  ✗ ${e.message}`);
    return 1;
  }
  return 2;
}

/** The full build's units and a context for the call graph (unit tool only). */
async function loadGraph() {
  const { loadBuild } = await import('./storage-layout-guard.mjs');
  const { BUILD_OUT_DIR } = await import('./check-measured-delivery.mjs');
  const rr = await import('./refactor-reports.mjs');
  const build = loadBuild(BUILD_OUT_DIR);
  if (build.problems.length) throw new Error(`${build.problems[0]} (run check-measured-delivery.mjs first)`);
  const units = [...build.units.values()];
  // The Diamond's routing table: a selector the unit's code names resolves to
  // the facet that hosts it.
  const manifest = JSON.parse(readFileSync((await import('./storage-layout-guard.mjs')).FACETS_FILE, 'utf8'));
  const ctx = rr.makeContext(units, manifest.facets);
  const pathOfContract = new Map();
  for (const u of units) for (const n of u.nodes ?? []) if (n.nodeType === 'ContractDefinition') pathOfContract.set(n.id, u.absolutePath);
  ctx.pathOf = (id) => pathOfContract.get(id);
  return { units, ctx, reachFn: rr.reach, walk: rr.walk };
}

export async function main(argv = process.argv.slice(2)) {
  const [cmd, ...rest] = argv;
  if (['planted', 'branches', 'open', 'close', 'strays', 'copy'].includes(cmd)) return reviewRepoCommand(cmd, rest);
  let solc;
  let jsonOut;
  let file;
  let unitName;
  let slice;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--solc' && rest[i + 1]) solc = rest[++i];
    else if (rest[i] === '--json' && rest[i + 1]) jsonOut = rest[++i];
    else if (rest[i] === '--file' && rest[i + 1]) file = rest[++i];
    else if (rest[i] === '--slice' && rest[i + 1]) slice = Number(rest[++i]);
    else if (cmd === 'unit' && !unitName && !rest[i].startsWith('--')) unitName = rest[i];
    else {
      console.error(`review-coverage: unknown argument ${rest[i]}`);
      return 2;
    }
  }
  if (!['report', 'check', 'hashes', 'unit'].includes(cmd)) {
    console.error('usage: review-coverage.mjs report [--json <path>] | check | hashes [--file <src path>] | unit <Contract> [--slice <n>]  [--solc <path>]');
    return 2;
  }
  if (cmd === 'unit') {
    if (!unitName) {
      console.error('review-coverage unit: name the facet or contract');
      return 2;
    }
    let g;
    try {
      g = await loadGraph();
    } catch (e) {
      console.error(`  ✗ ${e.message}`);
      return 1;
    }
    const ledger = readJson(LEDGER_FILE, { entries: {} });
    const order = readJson(ORDER_FILE, { sharedLibraries: [] });
    const decls = buildDeclarations(g.units, (p) => readFileSync(join(CONTRACTS_DIR, p)));
    const unit = deriveUnit(unitName, { ...g, decls, ledger, shared: order.sharedLibraries ?? [], limit: ledger.sizeLimit?.lines ?? DEFAULT_LIMIT });
    if (slice === undefined) {
      console.log(`${unit.name}: ${unit.lines} uncovered lines in ${unit.slices.length} slice(s) at the ${unit.limit}-line limit; ${unit.dropped} covered declaration(s) dropped`);
      unit.slices.forEach((s, i) => console.log(`  slice ${i + 1}: ${s.declarations.length} declarations, ${s.lines} lines${s.oversize ? ' (one declaration over the limit)' : ''}`));
      return 0;
    }
    if (!(slice >= 1 && slice <= unit.slices.length)) {
      console.error(`review-coverage unit: slice must be 1..${unit.slices.length}`);
      return 2;
    }
    console.log(describeSlice(unit, slice - 1, { ...g, decls }));
    return 0;
  }
  solc ||= findSolc();
  if (!solc) {
    console.error('  ✗ no solc 0.8.29 found (run forge build once, or pass --solc)');
    return 1;
  }
  const read = (p) => readFileSync(join(CONTRACTS_DIR, p));
  const paths = file ? [file] : srcFiles();
  const decls = treeDeclarations(paths, read, solc);

  if (cmd === 'hashes') {
    for (const d of decls) console.log(`${d.hash}  ${d.size.toString().padStart(6)}  ${d.path}:${d.label}`);
    return 0;
  }
  const ledger = readJson(LEDGER_FILE, { entries: {} });
  if (cmd === 'report') {
    const r = buildReport(decls, ledger, readJson(ACCEPTED_FILE, { declarations: {} }));
    printReport(r);
    if (jsonOut) writeFileSync(jsonOut, `${JSON.stringify(r, null, 2)}\n`);
    return 0;
  }
  // check
  const here = new Set(decls.map((d) => d.hash));
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: CONTRACTS_DIR, encoding: 'utf8' }).stdout.trim();
  // The working tree stands for HEAD only when contracts/src is unchanged.
  const clean = spawnSync('git', ['status', '--porcelain', '--', 'src'], { cwd: CONTRACTS_DIR, encoding: 'utf8' }).stdout.trim() === '';
  const problems = ledgerProblems(ledger, (commit) => (clean && head.startsWith(commit) ? here : hashesAtCommit(commit, solc)));
  for (const p of problems) console.error(`  ✗ ${p}`);
  if (!problems.length) console.log(`  ✓ review-coverage ledger: ${Object.keys(ledger.entries ?? {}).length} entries, every hash a declaration at its commit`);
  return problems.length ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then((code) => {
    process.exitCode = code;
  });
}
