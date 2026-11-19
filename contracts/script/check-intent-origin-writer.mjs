#!/usr/bin/env node
/**
 * check-intent-origin-writer.mjs — a loan is recorded as made by a lender
 * intent slot in ONE place.
 *
 * Every fill from a lender intent slot runs the slot's checks (its terms,
 * exposure, funding and the calm-price check) before the loan is recorded
 * as the slot's. The origin (`Storage.intentOrigin`) is written in ONE
 * helper, `LibIntentFill.recordSlotLoan`, which also adds the loan to the
 * roll index and the market ledger, and that helper is called only from
 * the listed fill steps, each of which runs the slot rule first: the match
 * of a standing intent (`OfferMatchIntentFacet.matchIntent`, which
 * Auto-lend, the keeper's fills, the backstop vault and the aggregator
 * adapters reach), an instant-market fill from a slot
 * (`InstantFillFacet.fillInstant`, through `_drawSlot`) and the instant
 * takeover (`InstantTakeoverFacet`, through its admission). A second writer,
 * or a new caller of the helper, would open intent loans the checks never
 * saw, so this fails on either. A `delete` (the origin released at a loan's
 * close) opens nothing and is not counted.
 *
 * A write is, as the compiler resolved it, an assignment whose left side is
 * a `LibVaipakam.IntentOrigin` in storage or a member of one (so a write
 * through a storage pointer counts too).
 *
 * Reads the AST artifacts the measured-delivery guard builds
 * (`out-measured-delivery/`), like check-loan-terms-writer.mjs.
 *
 * CLI: node contracts/script/check-intent-origin-writer.mjs [--out <dir>]
 */
import { fileURLToPath } from 'node:url';
import { loadBuild } from './storage-layout-guard.mjs';
import { BUILD_OUT_DIR } from './check-measured-delivery.mjs';

const ORIGIN_STORAGE = /^struct LibVaipakam\.IntentOrigin storage\b/;

/** The one site that records an intent origin, with its write count. */
export const ALLOWED = [
  {
    site: 'src/libraries/LibIntentFill.sol:LibIntentFill.recordSlotLoan',
    writes: 1,
    reason: 'The one origin writer; its callers are pinned in CALLERS below.',
  },
];

/** The fill steps that may call the writer, with their call counts. */
export const CALLERS = [
  {
    site: 'src/facets/OfferMatchIntentFacet.sol:OfferMatchIntentFacet.matchIntent',
    calls: 1,
    reason: 'The standing-intent match: LibIntentFill.admitFill runs every slot check first.',
  },
  {
    site: 'src/facets/InstantFillFacet.sol:InstantFillFacet.fillInstant',
    calls: 1,
    reason: 'An instant-market fill from a slot: _drawSlot runs the consent, the price limit and the slot rule first.',
  },
  {
    site: 'src/facets/InstantTakeoverFacet.sol:InstantTakeoverFacet._takeover',
    calls: 1,
    reason: 'The instant takeover: the incoming slot\'s terms, exposure, calm-price check and the new-loan risk check run first.',
  },
];

const typeOf = (n) => n?.typeDescriptions?.typeString ?? '';

/** Whether assigning to `target` writes an intent origin in storage. */
export function writesOrigin(target) {
  if (!target) return false;
  if (target.nodeType === 'TupleExpression') return (target.components ?? []).some(writesOrigin);
  if (target.nodeType !== 'Identifier' && ORIGIN_STORAGE.test(typeOf(target))) return true;
  if (target.nodeType === 'MemberAccess') return ORIGIN_STORAGE.test(typeOf(target.expression));
  return false;
}

function walk(node, visit, ancestors = []) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const n of node) walk(n, visit, ancestors);
    return;
  }
  if (typeof node.nodeType === 'string') visit(node, ancestors);
  const next = typeof node.nodeType === 'string' ? [...ancestors, node] : ancestors;
  for (const [k, v] of Object.entries(node)) if (k !== 'nodeType' && v && typeof v === 'object') walk(v, visit, next);
}

function enclosingName(ancestors) {
  let contract = '<file>';
  let fn = '<top-level>';
  for (const a of ancestors) {
    if (a.nodeType === 'ContractDefinition') contract = a.name;
    if (a.nodeType === 'FunctionDefinition') fn = a.kind === 'function' || a.kind === 'freeFunction' ? a.name : `<${a.kind}>`;
    if (a.nodeType === 'ModifierDefinition') fn = `modifier ${a.name}`;
  }
  return `${contract}.${fn}`;
}

/** Every intent-origin write site in src/. Pure over the ASTs. */
export function originWriteSites(units) {
  const sites = new Map();
  for (const unit of units) {
    const path = unit.absolutePath;
    if (typeof path !== 'string' || !path.startsWith('src/')) continue;
    walk(unit, (node, ancestors) => {
      if (node.nodeType !== 'Assignment' || !writesOrigin(node.leftHandSide)) return;
      const key = `${path}:${enclosingName(ancestors)}`;
      sites.set(key, (sites.get(key) ?? 0) + 1);
    });
  }
  return sites;
}

/** Every call of the origin writer in src/, by enclosing function. Pure. */
export function writerCallSites(units) {
  const sites = new Map();
  for (const unit of units) {
    const path = unit.absolutePath;
    if (typeof path !== 'string' || !path.startsWith('src/')) continue;
    walk(unit, (node, ancestors) => {
      if (node.nodeType !== 'FunctionCall') return;
      const e = node.expression;
      if (e?.nodeType !== 'MemberAccess' || e.memberName !== 'recordSlotLoan') return;
      if (e.expression?.name !== 'LibIntentFill') return;
      const key = `${path}:${enclosingName(ancestors)}`;
      sites.set(key, (sites.get(key) ?? 0) + 1);
    });
  }
  return sites;
}

/** Problems with the writer's call sites against `callers`. Pure. */
export function callerVerdict(sites, callers = CALLERS) {
  const problems = [];
  const listed = new Map(callers.map((e) => [e.site, e]));
  for (const [key, n] of [...sites].sort(([a], [b]) => a.localeCompare(b))) {
    const entry = listed.get(key);
    if (!entry) problems.push(`${key}: ${n} call(s) of LibIntentFill.recordSlotLoan from an unlisted step — record a slot loan only from a fill step that runs the slot's checks, and list it with its reason`);
    else if (entry.calls !== n) problems.push(`${key}: listed with ${entry.calls} call(s), found ${n} — a changed count is a new caller to justify`);
  }
  for (const e of callers) if (!sites.has(e.site)) problems.push(`${e.site}: listed, but no longer calls LibIntentFill.recordSlotLoan — remove the entry`);
  return problems;
}

/** Problems with `sites` against `allowed`. Pure. */
export function verdict(sites, allowed = ALLOWED) {
  const problems = [];
  const listed = new Map(allowed.map((e) => [e.site, e]));
  for (const [key, n] of [...sites].sort(([a], [b]) => a.localeCompare(b))) {
    const entry = listed.get(key);
    if (!entry) problems.push(`${key}: ${n} write(s) to an intent origin outside LibIntentFill.recordSlotLoan — record a slot loan only through that helper`);
    else if (entry.writes !== n) problems.push(`${key}: listed with ${entry.writes} write(s), found ${n} — a changed count is a new write to justify`);
  }
  for (const e of allowed) if (!sites.has(e.site)) problems.push(`${e.site}: listed, but writes no intent origin any more — remove the entry`);
  return problems;
}

export function main(argv = process.argv.slice(2)) {
  let outDir = BUILD_OUT_DIR;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out' && argv[i + 1]) outDir = argv[++i];
    else {
      console.error(`check-intent-origin-writer: unknown argument ${argv[i]}`);
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
  if (!units.some((u) => u.absolutePath === 'src/libraries/LibIntentFill.sol')) {
    console.error('  ✗ LibIntentFill is not among the compiled sources — the check would see nothing');
    return 1;
  }
  const problems = [...verdict(originWriteSites(units)), ...callerVerdict(writerCallSites(units))];
  if (problems.length) {
    for (const p of problems) console.error(`  ✗ ${p}`);
    return 1;
  }
  console.log(`  ✓ an intent origin is recorded only by LibIntentFill.recordSlotLoan, called from the ${CALLERS.length} listed fill steps`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main();
}
