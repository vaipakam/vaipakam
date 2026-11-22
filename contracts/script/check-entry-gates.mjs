#!/usr/bin/env node
/**
 * The mechanical gate check (#3944, ReviewCoveragePassDesign §3.4, §10.18).
 *
 * Some rules belong to no one facet: every entry point of a certain kind must
 * carry a certain check (refuse a flagged wallet, refuse under a pause, hold
 * the re-entry guard, ask the Terms rule, be callable only by the Diamond).
 * Those rules are written down ONCE, in a rules file the Security thread
 * keeps, and used twice: as the checklist in every review-only pull request
 * (`checklist`) and here, where the compiler's syntax tree is read to list
 * the checks each entry point carries and compare them with the file.
 *
 * ── The rules file ───────────────────────────────────────────────────────
 *
 *   { "rules": [ {
 *       "id": "sanctions-entry",                 // unique, kebab-case
 *       "statement": "plain words: what every such entry must do",
 *       "appliesTo": {                           // every field optional, ANDed
 *         "contracts": ["*"] | ["OfferCreateFacet", ...],   // "*" = every shipped contract
 *         "excludeContracts": ["..."],
 *         "caller": "open" | "gated" | "any",    // the caller gate check-permissionless-steps reads
 *         "mutability": ["payable", "nonpayable"],
 *         "match": "<regex over Contract.name(types)>",
 *         "reaches": ["LibX.fn", "Facet.fn"]     // the entry's code reaches one of these
 *       },
 *       "check": { "anyOf": [                    // one is enough
 *         { "modifier": "nonReentrant" },
 *         { "call": "LibVaipakam._assertNotSanctioned" },   // before the first state change
 *         { "call": "LegalFacet.requireCurrentTerms" }      // a self-call through the Diamond counts
 *       ] },
 *       "exempt": { "Contract.name(types)": "why this entry is exempt, at least twenty characters" }
 *   } ] }
 *
 * ── What "carries a check" means, and what it cannot see ─────────────────
 *
 * An entry carries a modifier when the modifier is on the entry itself. It
 * carries a call when the call is reached BEFORE THE ENTRY FIRST CHANGES
 * STATE and on EVERY path to that point: the modifiers' bodies (up to their
 * `_`), then the body in source order, following internal and library calls
 * in place (to depth 8). A call under an `if`, a loop, a ternary, a `try` or
 * the right side of `&&` / `||` is conditional and does not count. Reading
 * stops at the first state change:
 *   - a write to storage (an assignment, `++`/`--`, `delete`, `push`/`pop`,
 *     whose target is a state variable or reached through a storage
 *     reference), or an `sstore` in assembly;
 *   - an external call that is not a view, including a low-level call; a call
 *     back into the Diamond counts as a state change unless its target is a
 *     view or is itself named as a check by some rule.
 * A modifier's own writes before its `_` (the re-entry lock) do not stop the
 * reading: a modifier is the entry's preamble.
 *
 * Bounded, not a proof: a check reached only through a function pointer, an
 * assembly block or a call deeper than the bound is not seen (reported, not
 * passed), and a state change inside assembly other than `sstore` is not seen
 * (a check placed after it would be passed). The rules say WHICH checks; the
 * review reads whether each one is correct.
 *
 * ── Where it runs ────────────────────────────────────────────────────────
 *
 * While the check still reports findings, the rules file and its output stay
 * in the private review repository: pass the file with `--rules`. Once it
 * reports nothing, the file moves to contracts/entry-gate-rules.json and the
 * pre-deploy gate runs this check there and blocks: a new entry point is
 * refused until it carries each check its kind requires or is exempt with a
 * reason.
 *
 * CLI: node contracts/script/check-entry-gates.mjs [--rules <file>] [--out <dir>] [--list] [--json <path>]
 *   --rules  the rules file (default contracts/entry-gate-rules.json; absent → nothing to check)
 *   --out    read artifacts already built with `forge build --force --ast`
 *   --list   print every entry point with the modifiers and the checks it carries
 *   --json   also write the findings as JSON
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { relative, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONTRACTS_DIR, FACETS_FILE, loadBuild } from './storage-layout-guard.mjs';
import { BUILD_OUT_DIR } from './check-measured-delivery.mjs';
import { entryPoints } from './check-permissionless-steps.mjs';
import { makeContext, mostDerived, reach, routedCallAt } from './refactor-reports.mjs';

export const RULES_FILE = join(CONTRACTS_DIR, 'entry-gate-rules.json');
const MAX_DEPTH = 8;
const MIN_REASON = 20;
const RULE_FIELDS = new Set(['id', 'statement', 'appliesTo', 'check', 'exempt']);
const APPLIES_FIELDS = new Set(['contracts', 'excludeContracts', 'caller', 'mutability', 'match', 'reaches']);

// ─── Reading what an entry carries ───────────────────────────────────────

const srcStart = (n) => Number((n?.src ?? '0:0').split(':')[0]);

/** A node's child nodes, in source order. */
function children(n) {
  const out = [];
  for (const [k, v] of Object.entries(n)) {
    if (k === 'typeDescriptions' || k === 'documentation') continue;
    if (Array.isArray(v)) for (const x of v) if (x && typeof x === 'object' && x.nodeType) out.push(x);
    if (v && typeof v === 'object' && !Array.isArray(v) && v.nodeType) out.push(v);
  }
  return out.sort((a, b) => srcStart(a) - srcStart(b));
}

const isStorageType = (n) => /\bstorage\b/.test(n?.typeDescriptions?.typeString ?? '');

/** Whether an lvalue reaches storage: a state variable, or anything through a storage reference. */
function storageTarget(lhs, ctx) {
  let e = lhs;
  while (e) {
    if (e.nodeType === 'Identifier') {
      const d = ctx.byId.get(e.referencedDeclaration);
      return Boolean(d?.stateVariable && !d.constant && d.mutability !== 'immutable') || d?.storageLocation === 'storage' || isStorageType(e);
    }
    if (e.nodeType === 'MemberAccess' || e.nodeType === 'IndexAccess' || e.nodeType === 'IndexRangeAccess') {
      const base = e.nodeType === 'MemberAccess' ? e.expression : e.baseExpression;
      if (isStorageType(base)) return true;
      e = base;
      continue;
    }
    if (e.nodeType === 'TupleExpression') return (e.components ?? []).some((c) => c && storageTarget(c, ctx));
    return isStorageType(e);
  }
  return false;
}

const label = (fn, ctx) => `${ctx.contractOf.get(fn.id)?.name ?? '?'}.${fn.name}`;

const CONDITIONAL = new Set(['IfStatement', 'ForStatement', 'WhileStatement', 'DoWhileStatement', 'Conditional', 'TryStatement']);

/**
 * Read one function (with its modifiers) in order up to its first state
 * change. Returns `{ calls: Map<label, {conditional}>, modifiers: string[],
 * stoppedAt: string|undefined, unseen: string[] }`.
 * `gateLabels` are the call checks some rule names: a self-call to one of
 * them is a check, not a state change.
 */
export function readEntry(fn, contract, ctx, gateLabels = new Set()) {
  const lineage = contract?.linearizedBaseContracts;
  const calls = new Map();
  const unseen = [];
  let stoppedAt;
  const seen = new Set();
  const note = (l, conditional) => {
    const prev = calls.get(l);
    if (!prev || (prev.conditional && !conditional)) calls.set(l, { conditional });
  };

  // `visit` returns true once a state change is found.
  const visit = (n, conditional, depth, inModifier) => {
    if (stoppedAt) return true;
    if (!n || typeof n !== 'object') return false;
    const t = n.nodeType;
    if (t === 'PlaceholderStatement') return 'placeholder';
    if (t === 'FunctionDefinition' || t === 'ModifierDefinition') return false;
    if (t === 'InlineAssembly') {
      let store = false;
      const scan = (y) => {
        if (!y || typeof y !== 'object') return;
        if (y.nodeType === 'YulFunctionCall' && y.functionName?.name === 'sstore') store = true;
        for (const v of Object.values(y)) if (Array.isArray(v)) v.forEach(scan);
        else if (v && typeof v === 'object') scan(v);
      };
      scan(n.AST);
      if (store && !inModifier) {
        stoppedAt = 'an sstore in assembly';
        return true;
      }
      return false;
    }
    // Writes.
    if (!inModifier) {
      if (t === 'Assignment' && storageTarget(n.leftHandSide, ctx)) {
        // The right side is evaluated first.
        if (visit(n.rightHandSide, conditional, depth, inModifier) === true) return true;
        stoppedAt = 'a storage write';
        return true;
      }
      if (t === 'UnaryOperation' && ['++', '--', 'delete'].includes(n.operator) && storageTarget(n.subExpression, ctx)) {
        stoppedAt = `a storage ${n.operator === 'delete' ? 'delete' : 'write'}`;
        return true;
      }
    }
    if (t === 'BinaryOperation' && (n.operator === '&&' || n.operator === '||')) {
      if (visit(n.leftExpression, conditional, depth, inModifier) === true) return true;
      return visit(n.rightExpression, true, depth, inModifier) === true;
    }
    if (CONDITIONAL.has(t)) {
      // The condition (or the call tried) runs on every path; the branches do not.
      const head = t === 'IfStatement' || t === 'Conditional' ? n.condition : t === 'TryStatement' ? n.externalCall : undefined;
      if (head && visit(head, conditional, depth, inModifier) === true) return true;
      for (const c of children(n)) {
        if (c === head) continue;
        if (visit(c, true, depth, inModifier) === true) return true;
      }
      return false;
    }
    if (t === 'FunctionCall') {
      // Arguments are evaluated before the call.
      for (const a of n.arguments ?? []) if (visit(a, conditional, depth, inModifier) === true) return true;
      const e = n.expression;
      if (e?.nodeType === 'MemberAccess' && visit(e.expression, conditional, depth, inModifier) === true) return true;
      const routed = routedCallAt(n, ctx);
      const d = ctx.byId.get(e?.referencedDeclaration);
      const typeString = e?.typeDescriptions?.typeString ?? '';
      if (routed && e?.nodeType === 'MemberAccess' && /\bexternal\b/.test(typeString)) {
        const l = `${routed.contract.name}.${routed.fn.name}`;
        note(l, conditional);
        const view = ['view', 'pure'].includes(routed.fn.stateMutability);
        if (!view && !gateLabels.has(l) && !inModifier) {
          stoppedAt = `a call back into the Diamond (${l})`;
          return true;
        }
        return false;
      }
      if (d?.nodeType === 'FunctionDefinition') {
        const external = /\bexternal\b/.test(typeString) && ctx.contractOf.get(d.id)?.contractKind !== 'library';
        if (external) {
          note(label(d, ctx), conditional);
          if (!['view', 'pure'].includes(d.stateMutability) && !inModifier) {
            stoppedAt = `an external call (${label(d, ctx)})`;
            return true;
          }
          return false;
        }
        const target = e.nodeType === 'Identifier' ? mostDerived(d, lineage, ctx) : d;
        note(label(target, ctx), conditional);
        if (!target.body) return false;
        if (depth >= MAX_DEPTH) {
          unseen.push(`${label(target, ctx)} (deeper than ${MAX_DEPTH})`);
          return false;
        }
        if (seen.has(target.id)) return false;
        seen.add(target.id);
        const r = visitAll(target.body.statements, conditional, depth + 1, inModifier);
        seen.delete(target.id);
        return r === true;
      }
      if (!inModifier && e?.nodeType === 'MemberAccess' && ['push', 'pop'].includes(e.memberName) && isStorageType(e.expression)) {
        stoppedAt = `a storage ${e.memberName}`;
        return true;
      }
      if (!inModifier && e?.nodeType === 'MemberAccess' && ['call', 'delegatecall', 'send', 'transfer'].includes(e.memberName)) {
        stoppedAt = `a low-level ${e.memberName}`;
        return true;
      }
      if (e?.nodeType === 'FunctionCallOptions' && e.expression?.nodeType === 'MemberAccess' && e.expression.memberName === 'call' && !inModifier) {
        stoppedAt = 'a low-level call';
        return true;
      }
      if (typeString.startsWith('function') && !d && e?.nodeType === 'Identifier') unseen.push('a call through a function pointer');
      return false;
    }
    for (const c of children(n)) {
      const r = visit(c, conditional, depth, inModifier);
      if (r === true) return true;
      if (r === 'placeholder') return 'placeholder';
    }
    return false;
  };
  const visitAll = (stmts, conditional, depth, inModifier) => {
    for (const s of stmts ?? []) {
      const r = visit(s, conditional, depth, inModifier);
      if (r === true || r === 'placeholder') return r;
    }
    return false;
  };

  const modifiers = [];
  for (const m of fn.modifiers ?? []) {
    const md = ctx.byId.get(m.modifierName?.referencedDeclaration);
    modifiers.push(m.modifierName?.name ?? md?.name ?? '?');
    if (md?.nodeType !== 'ModifierDefinition') continue;
    const derived = mostDerived(md, lineage, ctx);
    for (const a of m.arguments ?? []) visit(a, false, 0, true);
    if (derived?.body) visitAll(derived.body.statements, false, 1, true);
  }
  visitAll(fn.body?.statements, false, 0, false);
  return { calls, modifiers, stoppedAt, unseen };
}

// ─── Rules ───────────────────────────────────────────────────────────────

/** Problems with the rules file itself. */
export function rulesProblems(doc) {
  const p = [];
  if (!doc || !Array.isArray(doc.rules)) return ['the rules file must be an object with a `rules` array'];
  const ids = new Set();
  for (const [i, r] of doc.rules.entries()) {
    const at = `rule ${r?.id ?? `#${i + 1}`}`;
    if (!r || typeof r !== 'object') {
      p.push(`${at}: not an object`);
      continue;
    }
    for (const k of Object.keys(r)) if (!RULE_FIELDS.has(k)) p.push(`${at}: unknown field ${k}`);
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(r.id ?? '')) p.push(`${at}: id must be kebab-case`);
    if (ids.has(r.id)) p.push(`${at}: id used twice`);
    ids.add(r.id);
    if (typeof r.statement !== 'string' || r.statement.trim().length < MIN_REASON) p.push(`${at}: statement must say the rule in plain words`);
    const a = r.appliesTo ?? {};
    for (const k of Object.keys(a)) if (!APPLIES_FIELDS.has(k)) p.push(`${at}: appliesTo has unknown field ${k}`);
    if (a.caller !== undefined && !['open', 'gated', 'any'].includes(a.caller)) p.push(`${at}: appliesTo.caller must be open, gated or any`);
    if (a.match !== undefined) {
      try {
        new RegExp(a.match);
      } catch {
        p.push(`${at}: appliesTo.match is not a regular expression`);
      }
    }
    const any = r.check?.anyOf;
    if (!Array.isArray(any) || !any.length) p.push(`${at}: check.anyOf must list at least one check`);
    else for (const c of any) if (!c || (typeof c.modifier !== 'string') === (typeof c.call !== 'string') || Object.keys(c).length !== 1) p.push(`${at}: each check is { "modifier": name } or { "call": "Contract.fn" }`);
    for (const [k, why] of Object.entries(r.exempt ?? {})) {
      if (typeof why !== 'string' || why.trim().length < MIN_REASON) p.push(`${at}: the exemption of ${k} needs a reason of at least ${MIN_REASON} characters`);
    }
  }
  return p;
}

const callChecks = (doc) => new Set((doc.rules ?? []).flatMap((r) => (r.check?.anyOf ?? []).map((c) => c.call).filter(Boolean)));

/** Whether a rule applies to one entry. `reached(entry)` returns the labels its code reaches. */
export function applies(rule, entry, { shipped, reached }) {
  const a = rule.appliesTo ?? {};
  const names = a.contracts ?? ['*'];
  if (!(names.includes('*') ? shipped.includes(entry.contract) : names.includes(entry.contract))) return false;
  if ((a.excludeContracts ?? []).includes(entry.contract)) return false;
  if (a.caller === 'open' && entry.gate) return false;
  if (a.caller === 'gated' && !entry.gate) return false;
  if (a.mutability && !a.mutability.includes(entry.mutability)) return false;
  if (a.match && !new RegExp(a.match).test(entry.key)) return false;
  if (a.reaches && !a.reaches.some((l) => reached(entry).has(l))) return false;
  return true;
}

/** Which of a rule's checks an entry carries, from {readEntry}'s result. */
export function satisfied(rule, carried) {
  return (rule.check?.anyOf ?? []).filter((c) =>
    c.modifier ? carried.modifiers.includes(c.modifier) : carried.calls.has(c.call) && !carried.calls.get(c.call).conditional,
  );
}

/**
 * Compare every entry with every rule (design §10.18). Returns
 * `{ findings: [{rule, entry, why}], problems: string[] }`: a finding is an
 * entry a rule applies to that carries none of its checks and is not exempt;
 * a problem is a defect of the file (a stale or needless exemption included).
 */
export function compareRules(doc, entries, { shipped, ctx }) {
  const problems = rulesProblems(doc);
  if (problems.length) return { findings: [], problems };
  const gates = callChecks(doc);
  const carriedCache = new Map();
  const carried = (e) => {
    if (!carriedCache.has(e.key)) carriedCache.set(e.key, readEntry(e.fn, ctx.contracts.get(e.contract), ctx, gates));
    return carriedCache.get(e.key);
  };
  const reachedCache = new Map();
  const reached = (e) => {
    if (!reachedCache.has(e.key)) {
      const c = ctx.contracts.get(e.contract);
      const { functions } = reach(e.fn, c, ctx);
      reachedCache.set(e.key, new Set([...functions].map((id) => ctx.byId.get(id)).filter(Boolean).map((f) => label(f, ctx))));
    }
    return reachedCache.get(e.key);
  };
  const findings = [];
  const keys = new Set(entries.map((e) => e.key));
  for (const rule of doc.rules) {
    const exempt = rule.exempt ?? {};
    for (const k of Object.keys(exempt)) if (!keys.has(k)) problems.push(`rule ${rule.id}: exempts ${k}, which is not an entry point`);
    for (const e of entries) {
      const on = applies(rule, e, { shipped, reached });
      if (!on) {
        if (exempt[e.key]) problems.push(`rule ${rule.id}: exempts ${e.key}, which the rule does not apply to`);
        continue;
      }
      const c = carried(e);
      const ok = satisfied(rule, c).length > 0;
      if (ok && exempt[e.key]) problems.push(`rule ${rule.id}: exempts ${e.key}, which carries the check: drop the exemption`);
      if (ok || exempt[e.key]) continue;
      const wanted = rule.check.anyOf.map((x) => x.modifier ? `modifier ${x.modifier}` : x.call).join(' or ');
      const conditional = rule.check.anyOf.filter((x) => x.call && c.calls.get(x.call)?.conditional).map((x) => x.call);
      const why = conditional.length
        ? `${conditional.join(', ')} is reached only on some paths`
        : c.stoppedAt
          ? `none of ${wanted} before ${c.stoppedAt}`
          : `none of ${wanted}`;
      findings.push({ rule: rule.id, entry: e.key, why: c.unseen.length ? `${why} (not read: ${[...new Set(c.unseen)].join(', ')})` : why });
    }
  }
  return { findings, problems };
}

/**
 * The checklist for a review-only pull request (design §3.4 use 1, §10.19):
 * each rule in plain words, with the given entries it applies to and, per
 * entry, whether it carries the check, is exempt (and why), or does not.
 */
export function checklist(doc, entries, { shipped, ctx }) {
  const gates = callChecks(doc);
  const lines = ['### Cross-cutting rules (from the rules file)', ''];
  for (const rule of doc.rules ?? []) {
    const reachedOf = (e) => new Set([...reach(e.fn, ctx.contracts.get(e.contract), ctx).functions].map((id) => ctx.byId.get(id)).filter(Boolean).map((f) => label(f, ctx)));
    const on = entries.filter((e) => applies(rule, e, { shipped, reached: reachedOf }));
    if (!on.length) continue;
    lines.push(`- **${rule.id}**: ${rule.statement}`);
    for (const e of on) {
      const why = rule.exempt?.[e.key];
      const ok = satisfied(rule, readEntry(e.fn, ctx.contracts.get(e.contract), ctx, gates)).length > 0;
      lines.push(`  - [ ] \`${e.key}\`: ${why ? `exempt: ${why}` : ok ? 'carries the check' : 'carries NONE of the checks'}`);
    }
  }
  return lines.join('\n');
}

// ─── CLI ─────────────────────────────────────────────────────────────────

export function main(argv = process.argv.slice(2)) {
  let outDir = BUILD_OUT_DIR;
  let rulesPath = RULES_FILE;
  let list = false;
  let jsonOut;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out' && argv[i + 1]) outDir = argv[++i];
    else if (argv[i] === '--rules' && argv[i + 1]) rulesPath = argv[++i];
    else if (argv[i] === '--json' && argv[i + 1]) jsonOut = argv[++i];
    else if (argv[i] === '--list') list = true;
    else {
      console.error(`check-entry-gates: unknown argument ${argv[i]}`);
      return 2;
    }
  }
  if (!list && !existsSync(rulesPath)) {
    console.log(`  · entry gates: no rules file at ${relative(process.cwd(), rulesPath)} (the rules stay in the review repository until the check reports nothing)`);
    return 0;
  }
  let build;
  try {
    build = loadBuild(outDir);
  } catch (e) {
    console.error(`  ✗ cannot read ${relative(process.cwd(), outDir)}: ${e.message} — run check-measured-delivery.mjs first, or pass --out`);
    return 1;
  }
  if (build.problems.length) {
    for (const p of build.problems) console.error(`  ✗ ${p}`);
    return 1;
  }
  const units = [...build.units.values()];
  const manifest = JSON.parse(readFileSync(FACETS_FILE, 'utf8'));
  const shipped = [...manifest.facets, ...manifest.standalone];
  const ctx = makeContext(units, manifest.facets);
  const { entries } = entryPoints(units, shipped, ctx.byId);
  if (list) {
    const doc = existsSync(rulesPath) ? JSON.parse(readFileSync(rulesPath, 'utf8')) : { rules: [] };
    const gates = callChecks(doc);
    for (const e of entries) {
      const c = readEntry(e.fn, ctx.contracts.get(e.contract), ctx, gates);
      const calls = [...c.calls].filter(([, v]) => !v.conditional).map(([k]) => k);
      console.log(`${e.key}\n  caller: ${e.gate ? 'gated' : 'open'}; modifiers: ${c.modifiers.join(', ') || 'none'}; stops at: ${c.stoppedAt ?? 'end'}\n  calls before: ${calls.join(', ') || 'none'}`);
    }
    return 0;
  }
  let doc;
  try {
    doc = JSON.parse(readFileSync(rulesPath, 'utf8'));
  } catch (e) {
    console.error(`  ✗ ${relative(process.cwd(), rulesPath)}: ${e.message}`);
    return 1;
  }
  const { findings, problems } = compareRules(doc, entries, { shipped, ctx });
  if (jsonOut) writeFileSync(jsonOut, `${JSON.stringify({ findings, problems }, null, 2)}\n`);
  for (const p of problems) console.error(`  ✗ ${p}`);
  for (const f of findings) console.error(`  ✗ ${f.rule}: ${f.entry}: ${f.why}`);
  if (problems.length || findings.length) return 1;
  console.log(`  ✓ entry gates: ${entries.length} entry points against ${doc.rules.length} rule(s), nothing to report`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main();
}
