#!/usr/bin/env node
/**
 * check-loan-terms-writer.mjs — a loan's principal and rate have ONE writer
 * (#1808).
 *
 * The interest ledger prices each stretch of a loan's life at the principal
 * and rate in force over it, so every change to either must first close the
 * stretch at the old figures. `src/libraries/LibInterestLedger.sol` is the one
 * place that is written (`setPrincipal`, `writeOffPrincipal`, `setRate`). A
 * write anywhere else would price the stretch before it at the new figures, so
 * this check fails on any write to a stored loan's `principal` or
 * `interestRateBps` in src/ outside that library, unless the site is LISTED
 * below with its reason.
 *
 * A write is, as the compiler resolved it:
 *   - an assignment (`=`, `+=`, `-=`, ...) whose left side is the `principal`
 *     or `interestRateBps` member of a `LibVaipakam.Loan` in storage;
 *   - `++`, `--` or `delete` on such a member; and
 *   - an assignment or `delete` of a whole `LibVaipakam.Loan` in storage,
 *     which writes both fields at once.
 * A memory copy of a loan (a view's DTO, a cached struct) is not storage and
 * is not counted. Inline assembly is outside what the AST can show and is
 * stated here rather than implied; none writes a loan in src/ today.
 *
 * It reads the compiler's AST from the artifacts the measured-delivery guard
 * builds (`out-measured-delivery/`, one `forge build --force --ast` job), so
 * the pre-deploy gate pays for one AST build, not two. Run it after that
 * guard, or point `--out` at any artifacts built the same way.
 *
 * Each listed site is keyed by file, contract and function with the number of
 * writes it contains, so a second write added to a listed function fails as
 * well, and a listed site that no longer writes fails too.
 *
 * CLI: node contracts/script/check-loan-terms-writer.mjs [--out <dir>]
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONTRACTS_DIR, loadBuild } from './storage-layout-guard.mjs';
import { BUILD_OUT_DIR } from './check-measured-delivery.mjs';

/** The library every principal and rate write goes through. */
export const HOME = 'src/libraries/LibInterestLedger.sol';

const FIELDS = new Set(['principal', 'interestRateBps']);
const LOAN_STORAGE = /^struct LibVaipakam\.Loan storage\b/;

/**
 * The sites outside {HOME} that may write the terms, with why. Origination is
 * the only one: the ledger opens at the loan's start, so there is no earlier
 * stretch to close.
 */
export const ALLOWED = [
  {
    site: 'src/facets/LoanFacet.sol:LoanFacet._copyFinancialFields',
    writes: 4,
    reason:
      'Origination writes the loan record before it exists to anyone; the ledger opens lazily at the start time, so there is no earlier stretch to price.',
  },
];

function walk(node, visit, ancestors = []) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const n of node) walk(n, visit, ancestors);
    return;
  }
  if (typeof node.nodeType === 'string') visit(node, ancestors);
  const next = typeof node.nodeType === 'string' ? [...ancestors, node] : ancestors;
  for (const [k, v] of Object.entries(node)) {
    if (k === 'nodeType') continue;
    if (v && typeof v === 'object') walk(v, visit, next);
  }
}

function enclosingName(ancestors) {
  let contract = '<file>';
  let fn = '<top-level>';
  for (const a of ancestors) {
    if (a.nodeType === 'ContractDefinition') contract = a.name;
    if (a.nodeType === 'FunctionDefinition') {
      fn = a.kind === 'function' || a.kind === 'freeFunction' ? a.name : `<${a.kind}>`;
    }
    if (a.nodeType === 'ModifierDefinition') fn = `modifier ${a.name}`;
  }
  return `${contract}.${fn}`;
}

function lineOf(src, bytes) {
  const start = Number(String(src).split(':')[0]);
  if (!bytes || !Number.isFinite(start)) return 0;
  let line = 1;
  for (let i = 0; i < start && i < bytes.length; i++) if (bytes[i] === 10) line++;
  return line;
}

const typeOf = (n) => n?.typeDescriptions?.typeString ?? '';

/** What `target` writes when assigned or deleted, or undefined when it is not a loan term. */
export function termTarget(target) {
  if (!target) return undefined;
  if (target.nodeType === 'MemberAccess' && FIELDS.has(target.memberName) && LOAN_STORAGE.test(typeOf(target.expression))) {
    return `Loan.${target.memberName}`;
  }
  if (LOAN_STORAGE.test(typeOf(target)) && target.nodeType !== 'Identifier') return 'Loan (whole record)';
  if (target.nodeType === 'TupleExpression') {
    const parts = (target.components ?? []).map(termTarget).filter(Boolean);
    return parts.length ? parts.join(' + ') : undefined;
  }
  return undefined;
}

/**
 * Every write to a stored loan's principal or rate in src/ outside {HOME}.
 * Pure over the ASTs; `sourceText(path)` is used only for line numbers.
 *
 * @returns {Map<string, {writes: number, refs: {label: string, line: number}[]}>}
 */
export function termWriteSites(units, { home = HOME, sourceText = () => undefined } = {}) {
  const sites = new Map();
  for (const unit of units) {
    const path = unit.absolutePath;
    if (typeof path !== 'string' || !path.startsWith('src/') || path === home) continue;
    const text = sourceText(path);
    walk(unit, (node, ancestors) => {
      let label;
      if (node.nodeType === 'Assignment') label = termTarget(node.leftHandSide);
      else if (node.nodeType === 'UnaryOperation' && ['++', '--', 'delete'].includes(node.operator)) {
        label = termTarget(node.subExpression);
      }
      if (!label) return;
      const key = `${path}:${enclosingName(ancestors)}`;
      const site = sites.get(key) ?? { writes: 0, refs: [] };
      site.writes += 1;
      site.refs.push({ label, line: lineOf(node.src, text) });
      sites.set(key, site);
    });
  }
  return sites;
}

/** Problems with `sites` against `allowed`. Pure. */
export function verdict(sites, allowed = ALLOWED) {
  const problems = [];
  const listed = new Map(allowed.map((e) => [e.site, e]));
  for (const [key, site] of [...sites].sort(([a], [b]) => a.localeCompare(b))) {
    const where = site.refs.map((r) => `${r.label}${r.line ? ` @${r.line}` : ''}`).join(', ');
    const entry = listed.get(key);
    if (!entry) {
      problems.push(`${key}: ${site.writes} write(s) to a loan's principal or rate outside LibInterestLedger (${where}) — use setPrincipal / writeOffPrincipal / setRate`);
    } else if (entry.writes !== site.writes) {
      problems.push(`${key}: listed with ${entry.writes} write(s), found ${site.writes} (${where}) — a changed count is a new write to justify`);
    }
  }
  for (const e of allowed) {
    if (!sites.has(e.site)) problems.push(`${e.site}: listed, but writes neither field any more — remove the entry`);
  }
  return problems;
}

export function main(argv = process.argv.slice(2)) {
  let outDir = BUILD_OUT_DIR;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out' && argv[i + 1]) outDir = argv[++i];
    else {
      console.error(`check-loan-terms-writer: unknown argument ${argv[i]}`);
      return 2;
    }
  }
  let build;
  try {
    build = loadBuild(outDir);
  } catch (e) {
    console.error(`  ✗ cannot read ${outDir}: ${e.message} — run check-measured-delivery.mjs first, or pass --out`);
    return 1;
  }
  if (build.problems.length) {
    for (const p of build.problems) console.error(`  ✗ ${p}`);
    return 1;
  }
  const units = [...build.units.values()];
  if (!units.some((u) => u.absolutePath === HOME)) {
    console.error(`  ✗ ${HOME} is not among the compiled sources — the check would see nothing`);
    return 1;
  }
  const sites = termWriteSites(units, {
    sourceText: (p) => {
      try {
        return readFileSync(join(CONTRACTS_DIR, p));
      } catch {
        return undefined;
      }
    },
  });
  const problems = verdict(sites);
  if (problems.length) {
    for (const p of problems) console.error(`  ✗ ${p}`);
    return 1;
  }
  const total = [...sites.values()].reduce((n, s) => n + s.writes, 0);
  console.log(`  ✓ a loan's principal and rate are written only through LibInterestLedger, or at a listed site (${sites.size} listed, ${total} writes)`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main();
}
