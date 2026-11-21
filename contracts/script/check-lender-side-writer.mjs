#!/usr/bin/env node
/**
 * check-lender-side-writer.mjs — the two stores a loan's lender side receives
 * into have ONE writer (#3760, LenderCashOutDesign §6.4).
 *
 * `heldForLender[loanId]` (what arrives while the loan is open) and
 * `lenderClaims[loanId]` (the final claim the loan's end writes) are added to
 * and taken from only inside `src/libraries/LibLenderSide.sol`. That library
 * books an open advance's part of every arrival at the moment it arrives, so
 * interest on the advance stops then, and every taker settles the advance
 * first. A write anywhere else would credit or empty a store around the order
 * of payment, so this check fails on any write to either store in src/
 * outside that library, additions and subtractions alike, unless the site is
 * LISTED below with its reason. Reads stay open. The library's host,
 * `src/facets/LenderSideFacet.sol`, is the library's own runtime half (the
 * advance booking it self-calls, kept out of the facets that inline the
 * library for EIP-170 room), so it is home too.
 *
 * A write is, as the compiler resolved it, an assignment (`=`, `+=`, ...),
 * `++`, `--` or `delete` whose target is reached from
 *   - `<Storage>.heldForLender[...]` or `<Storage>.lenderClaims[...]` (the
 *     element, or a member of it such as `.claimed` or `.amount`), or
 *   - a local storage pointer whose declaration was initialised from
 *     `<Storage>.lenderClaims[...]` (`ClaimInfo storage claim = s.lenderClaims[id];
 *     claim.claimed = true;`).
 * And a storage reference to either store passed to a function (where the
 * callee could write through it) counts as a write at the call. A memory copy
 * is not storage and is not counted. Inline assembly is outside what the AST
 * shows; none touches either store in src/ today.
 *
 * It reads the compiler's AST from the artifacts the measured-delivery guard
 * builds (`out-measured-delivery/`), like the loan-terms writer check.
 *
 * CLI: node contracts/script/check-lender-side-writer.mjs [--out <dir>]
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONTRACTS_DIR, loadBuild } from './storage-layout-guard.mjs';
import { BUILD_OUT_DIR } from './check-measured-delivery.mjs';
import { walk, enclosingName, lineOf } from './check-loan-terms-writer.mjs';

/** The library every write to either store goes through. */
export const HOME = 'src/libraries/LibLenderSide.sol';
/** The library's host facet: the booking LibLenderSide self-calls. Home too. */
export const HOST = 'src/facets/LenderSideFacet.sol';
export const STORES = new Set(['heldForLender', 'lenderClaims']);
const STORAGE = /^struct LibVaipakam\.Storage storage\b/;

/**
 * The sites outside {HOME} and {HOST} that may write either store, with why. None: the
 * library is the one writer (settled with the design, 2026-11-19).
 */
export const ALLOWED = [];

const typeOf = (n) => n?.typeDescriptions?.typeString ?? '';

/** The store `node` is an element of, or undefined. */
function storeIndex(node) {
  if (node?.nodeType !== 'IndexAccess') return undefined;
  const base = node.baseExpression;
  if (base?.nodeType === 'MemberAccess' && STORES.has(base.memberName) && STORAGE.test(typeOf(base.expression))) {
    return base.memberName;
  }
  return undefined;
}

/** What `target` writes, or undefined. `pointers` maps declaration ids to stores. */
export function storeTarget(target, pointers) {
  let n = target;
  while (n) {
    const store = storeIndex(n);
    if (store) return store;
    if (n.nodeType === 'Identifier' && pointers.has(n.referencedDeclaration)) {
      return `${pointers.get(n.referencedDeclaration)} (through a storage pointer)`;
    }
    if (n.nodeType === 'MemberAccess') n = n.expression;
    else if (n.nodeType === 'IndexAccess') n = n.baseExpression;
    else if (n.nodeType === 'TupleExpression') {
      const parts = (n.components ?? []).map((c) => storeTarget(c, pointers)).filter(Boolean);
      return parts.length ? parts.join(' + ') : undefined;
    } else return undefined;
  }
  return undefined;
}

/**
 * Every write to either store in src/ outside {HOME} and {HOST}. Pure over the ASTs;
 * `sourceText(path)` is used only for line numbers.
 *
 * @returns {Map<string, {writes: number, refs: {label: string, line: number}[]}>}
 */
export function storeWriteSites(units, { homes = [HOME, HOST], sourceText = () => undefined } = {}) {
  const sites = new Map();
  for (const unit of units) {
    const path = unit.absolutePath;
    if (typeof path !== 'string' || !path.startsWith('src/') || homes.includes(path)) continue;
    const text = sourceText(path);
    // Storage pointers into a store, by declaration id (first pass).
    const pointers = new Map();
    walk(unit, (node) => {
      if (node.nodeType !== 'VariableDeclarationStatement' || !node.initialValue) return;
      const store = storeIndex(node.initialValue);
      if (!store) return;
      for (const d of node.declarations ?? []) {
        if (d && d.storageLocation === 'storage') pointers.set(d.id, store);
      }
    });
    const add = (label, node, ancestors) => {
      const key = `${path}:${enclosingName(ancestors)}`;
      const site = sites.get(key) ?? { writes: 0, refs: [] };
      site.writes += 1;
      site.refs.push({ label, line: lineOf(node.src, text) });
      sites.set(key, site);
    };
    walk(unit, (node, ancestors) => {
      let label;
      if (node.nodeType === 'Assignment') label = storeTarget(node.leftHandSide, pointers);
      else if (node.nodeType === 'UnaryOperation' && ['++', '--', 'delete'].includes(node.operator)) {
        label = storeTarget(node.subExpression, pointers);
      } else if (node.nodeType === 'FunctionCall') {
        for (const arg of node.arguments ?? []) {
          const store = storeIndex(arg);
          if (store && / storage\b/.test(typeOf(arg)) && /^struct /.test(typeOf(arg))) {
            add(`${store} (storage reference passed to a call)`, arg, ancestors);
          }
          if (arg?.nodeType === 'Identifier' && pointers.has(arg.referencedDeclaration)) {
            add(`${pointers.get(arg.referencedDeclaration)} (storage pointer passed to a call)`, arg, ancestors);
          }
        }
        return;
      }
      if (label) add(label, node, ancestors);
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
      problems.push(`${key}: ${site.writes} write(s) to a lender-side store outside LibLenderSide (${where}) — use addHeld / takeHeld / subHeld / capHeld / setFinal / setFinalAmount / settleFinalInKind / markFinalClaimed / subFinal / clearFinal`);
    } else if (entry.writes !== site.writes) {
      problems.push(`${key}: listed with ${entry.writes} write(s), found ${site.writes} (${where}) — a changed count is a new write to justify`);
    }
  }
  for (const e of allowed) {
    if (!sites.has(e.site)) problems.push(`${e.site}: listed, but writes neither store any more — remove the entry`);
  }
  return problems;
}

export function main(argv = process.argv.slice(2)) {
  let outDir = BUILD_OUT_DIR;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out' && argv[i + 1]) outDir = argv[++i];
    else {
      console.error(`check-lender-side-writer: unknown argument ${argv[i]}`);
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
  for (const home of [HOME, HOST]) {
    if (!units.some((u) => u.absolutePath === home)) {
      console.error(`  ✗ ${home} is not among the compiled sources — the check would see nothing`);
      return 1;
    }
  }
  const sites = storeWriteSites(units, {
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
  console.log(`  ✓ heldForLender and lenderClaims are written only through LibLenderSide (${sites.size} listed sites)`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main();
}
