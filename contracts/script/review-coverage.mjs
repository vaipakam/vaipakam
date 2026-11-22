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

const HERE = fileURLToPath(new URL('.', import.meta.url));
export const CONTRACTS_DIR = join(HERE, '..');
export const RECORD_DIR = join(CONTRACTS_DIR, 'review-coverage');
export const LEDGER_FILE = join(RECORD_DIR, 'ledger.json');
export const ACCEPTED_FILE = join(RECORD_DIR, 'accepted.json');

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

// ─── CLI ─────────────────────────────────────────────────────────────────

export function main(argv = process.argv.slice(2)) {
  const [cmd, ...rest] = argv;
  let solc;
  let jsonOut;
  let file;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--solc' && rest[i + 1]) solc = rest[++i];
    else if (rest[i] === '--json' && rest[i + 1]) jsonOut = rest[++i];
    else if (rest[i] === '--file' && rest[i + 1]) file = rest[++i];
    else {
      console.error(`review-coverage: unknown argument ${rest[i]}`);
      return 2;
    }
  }
  if (!['report', 'check', 'hashes'].includes(cmd)) {
    console.error('usage: review-coverage.mjs report [--json <path>] | check | hashes [--file <src path>]  [--solc <path>]');
    return 2;
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
  process.exitCode = main();
}
