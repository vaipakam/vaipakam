#!/usr/bin/env node
/**
 * refactor-reports.mjs — four reports for the refactor's rules (#3914,
 * docs/DesignsAndPlans/RefactorRulesDesign.md sections 3 and 4).
 *
 *   silent-functions    every external or public function that can change
 *                       state and whose reachable code contains no emit
 *   swallowed-failures  every `catch` clause, and every branch taken when a
 *                       low-level call reports failure, that neither reverts
 *                       nor emits
 *   ambiguous-errors    every pair of an entry function and a parameterless
 *                       error it can raise from more than one place; every
 *                       text revert and reasonless revert; every error with
 *                       no catalogue entry
 *   write-only-storage  every stored field that contract code writes and
 *                       that only code no state-changing entry point reaches
 *                       reads (a candidate list, judged by hand)
 *   event-categories    every violation of the event category lint
 *                       (`lint-event-categories.js`, EventSourcingAudit
 *                       §1.6): an event with no tag, a malformed tag or a
 *                       leaf outside the closed list
 *
 * Every report reads the compiler's AST, never source text, from the
 * artifacts the measured-delivery guard builds (`out-measured-delivery/`, one
 * `forge build --force --ast` job, so AST ids resolve across files). The
 * pre-deploy gate already pays for that build, so these reports add no
 * compile.
 *
 * ── Reachable code ──────────────────────────────────────────────────────
 *
 * The code an entry function reaches is its body, its modifiers' bodies, and
 * the same for every function it calls, followed transitively:
 *
 *   - an internal call (`f()`, `Lib.f()`, `super.f()`), the virtual ones
 *     resolved to the most-derived override in the contract analyzed;
 *   - a self-call through the Diamond: every function selector the reachable
 *     code names (`X.f.selector`, `abi.encodeCall(X.f, ...)`, or a call
 *     `X(address(this)).f(...)`) that the Diamond routes, resolved to the
 *     facet function that carries it. A selector reference is followed
 *     whether or not it is actually called (a comparison counts too), which
 *     can only make a function look less silent, never more.
 *   - A low-level call on `address(this)` (`call`, `delegatecall`,
 *     `staticcall`) whose arguments name no selector cannot be resolved. It
 *     is reported as UNKNOWN, never assumed to emit, and must be listed.
 *
 * External calls to other contracts (tokens, vaults, the price guard) are
 * not followed: their events are their own.
 *
 * ── What the reports do NOT prove ───────────────────────────────────────
 *
 * The tests are bounded on purpose (design section 4):
 *
 *   - "the reachable code contains an emit", never "every path emits". A
 *     function that emits on one path and is silent on another passes.
 *   - A catch clause or a failure branch is judged by its own statements and
 *     the code they reach. A failure the branch hands back to its caller (a
 *     `return false` the caller then tests) is listed: the report cannot see
 *     what the caller does with it.
 *   - A low-level call's failure flag is followed only within the block that
 *     declares it, and only when the call's result is DECLARED there
 *     (`(bool ok, ) = x.call(...)`); a result assigned to existing variables
 *     is not read. A flag passed on or returned is taken as handled.
 *   - Inline assembly: a `log0`..`log4` counts as an emit and a `revert` as a
 *     revert. Nothing else in assembly is read.
 *   - The parameterless-error count is per entry function, over distinct
 *     raise sites in its reachable code. Two sites on paths that can never
 *     both be reached from that entry still count as two.
 *   - Write-only storage reads a field as read by contract code when a
 *     function some state-changing entry point reaches reads it. A read
 *     that only feeds an event or a return value still counts as a read.
 *     The list is a set of candidates, not a verdict.
 *
 * ── Results, ledger, and the warn-then-block rule ───────────────────────
 *
 * Each report's result is committed under `contracts/refactor-reports/`
 * (`<report>.json`): its current entries, sorted, with the counts. The
 * ledger (`ledger.json`) lists entries that are accepted, each with a reason
 * of at least 20 characters; a listed entry is not counted as a finding.
 *
 * `check` compares the tree with the committed results. An entry that is in
 * neither the result nor the ledger makes the report WORSE. Until the
 * refactor pass ends (`config.json` "blocking": false) that is a warning and
 * the check passes; afterwards it fails. An entry that has gone is reported
 * as improved, and `write` refreshes the results. `write` is what a change
 * that legitimately moves a count commits.
 *
 * CLI: node contracts/script/refactor-reports.mjs check|write|list [--out <dir>] [--report <name>]
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONTRACTS_DIR, FACETS_FILE, keccak256, loadBuild } from './storage-layout-guard.mjs';
import { BUILD_OUT_DIR, oneJobProblems } from './check-measured-delivery.mjs';
import { entryPoints, indexNodes } from './check-permissionless-steps.mjs';

export const REPORTS_DIR = join(CONTRACTS_DIR, 'refactor-reports');
export const REPORTS = ['silent-functions', 'swallowed-failures', 'ambiguous-errors', 'write-only-storage', 'event-categories'];
const { lintEvents } = createRequire(import.meta.url)('./lint-event-categories.js');
/** The error catalogue the export writes, keyed by selector, each row naming its `signature`. */
const CATALOGUE_FILE = join(CONTRACTS_DIR, '..', 'packages', 'contracts', 'src', 'errorCatalogue.json');

// ─── AST helpers ─────────────────────────────────────────────────────────

export function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const n of node) walk(n, visit);
    return;
  }
  if (typeof node.nodeType === 'string' && visit(node) === false) return;
  for (const [k, v] of Object.entries(node)) {
    if (k !== 'nodeType' && v && typeof v === 'object') walk(v, visit);
  }
}

function typeList(fn) {
  return (fn.parameters?.parameters ?? [])
    .map((p) => (p.typeDescriptions?.typeString ?? '?')
      .replace(/ (memory|calldata|storage)( pointer| ref)?/g, '')
      .replace(/^contract /, 'contract:')
      .replace(/^enum /, 'enum:')
      .replace(/^struct /, 'struct:')
      .replace(/ payable$/, ''))
    .join(',');
}

const isThis = (e) => e?.nodeType === 'Identifier' && e.name === 'this';
/** `address(this)` or `this`, possibly wrapped in a type conversion such as `IFoo(address(this))`. */
function isSelf(e) {
  if (!e) return false;
  if (isThis(e)) return true;
  if (e.nodeType === 'FunctionCall' && e.kind === 'typeConversion' && e.arguments?.length === 1) return isSelf(e.arguments[0]);
  return false;
}

const LOW_LEVEL = new Set(['call', 'delegatecall', 'staticcall']);

/**
 * Keccak-256 of a UTF-8 string, as a hex string without 0x. Used only to
 * resolve a selector constant written as `bytes4(keccak256("f(uint256)"))`.
 * The one Keccak in this tree's scripts is the storage-layout guard's.
 */
export function keccak256Hex(text) {
  return keccak256(new TextEncoder().encode(text)).slice(2);
}

/**
 * The 4-byte selector (8 hex chars, no 0x) a `bytes4` constant holds, when it
 * is written as a hex literal or as `bytes4(keccak256("<signature>"))`.
 * Anything else (an `X.f.selector` value is resolved separately) is undefined.
 */
function constantSelectorHex(decl) {
  if (decl?.nodeType !== 'VariableDeclaration' || !decl.constant || !decl.value) return undefined;
  const v = decl.value;
  if (v.nodeType === 'Literal' && /^0x[0-9a-fA-F]{8}$/.test(v.value ?? '')) return v.value.slice(2).toLowerCase();
  const callee = v.expression?.nodeType === 'ElementaryTypeNameExpression' ? v.expression.typeName?.name : v.expression?.name;
  if (v.nodeType === 'FunctionCall' && callee === 'bytes4' && v.arguments?.length === 1) {
    const k = v.arguments[0];
    if (k.nodeType === 'FunctionCall' && k.expression?.name === 'keccak256' && k.arguments?.length === 1) {
      const lit = k.arguments[0];
      if (lit.nodeType === 'Literal' && lit.kind === 'string' && typeof lit.value === 'string') return keccak256Hex(lit.value).slice(0, 8);
    }
  }
  return undefined;
}

/**
 * The analysis context over one build: every node by id, every contract by
 * name, and the Diamond's routing (selector → facet function).
 */
export function makeContext(units, facetNames) {
  const byId = indexNodes(units);
  const contracts = new Map();
  const contractOf = new Map(); // node id of a function/modifier → its ContractDefinition
  for (const u of units) {
    for (const n of u.nodes ?? []) {
      if (n.nodeType !== 'ContractDefinition') continue;
      if (typeof u.absolutePath === 'string' && u.absolutePath.startsWith('src/')) contracts.set(n.name, n);
      for (const m of n.nodes ?? []) contractOf.set(m.id, n);
    }
  }
  const routes = new Map();
  for (const name of facetNames) {
    const c = contracts.get(name);
    if (!c) continue;
    for (const baseId of c.linearizedBaseContracts ?? [c.id]) {
      for (const n of byId.get(baseId)?.nodes ?? []) {
        if (n.nodeType !== 'FunctionDefinition' || !n.implemented || !n.functionSelector) continue;
        if (n.visibility !== 'external' && n.visibility !== 'public') continue;
        if (!routes.has(n.functionSelector)) routes.set(n.functionSelector, { fn: n, contract: c });
      }
    }
  }
  return { byId, contracts, contractOf, routes };
}

export function mostDerived(decl, lineage, ctx) {
  if (!decl?.virtual || !lineage) return decl;
  const sig = typeList(decl);
  for (const baseId of lineage) {
    for (const n of ctx.byId.get(baseId)?.nodes ?? []) {
      if (n.nodeType === decl.nodeType && n.name === decl.name && n.body && typeList(n) === sig) return n;
    }
  }
  return decl;
}

/** The function a selector expression names, when the Diamond routes it. */
function routedTarget(declId, ctx) {
  const d = ctx.byId.get(declId);
  if (d?.nodeType !== 'FunctionDefinition' || !d.functionSelector) return undefined;
  return ctx.routes.get(d.functionSelector);
}

/**
 * The routed function a selector CONSTANT names: an identifier that refers to
 * a `bytes4` constant whose value is `X.f.selector`, a hex literal, or
 * `bytes4(keccak256("<signature>"))`. Returns `{ known, target }`: `known` is
 * true when the constant's value could be read, whether or not it is routed.
 */
function constantTarget(declId, ctx) {
  const d = ctx.byId.get(declId);
  if (d?.nodeType !== 'VariableDeclaration' || !d.constant || !d.value) return { known: false };
  const v = d.value;
  if (v.nodeType === 'MemberAccess' && v.memberName === 'selector') {
    return { known: true, target: routedTarget(v.expression?.referencedDeclaration, ctx) };
  }
  const hex = constantSelectorHex(d);
  if (hex === undefined) return { known: false };
  return { known: true, target: ctx.routes.get(hex) };
}

/**
 * The routed function one AST node names as a call through the Diamond, or
 * undefined. The one rule for "this code reaches that facet function", shared
 * by `reach` and the review-coverage unit tool: a call on `this` to an
 * external function, `abi.encodeCall(X.f, ...)`,
 * `abi.encodeWithSignature("f(...)")`, `X.f.selector`, or a selector constant
 * (see {constantTarget}). Returns `{ fn, contract }`.
 */
export function routedCallAt(n, ctx) {
  if (n.nodeType === 'FunctionCall') {
    let e = n.expression;
    while (e?.nodeType === 'FunctionCallOptions') e = e.expression; // `this.f{value: v}(...)`
    if (e?.nodeType === 'MemberAccess' && isSelf(e.expression)) {
      const d = ctx.byId.get(e.referencedDeclaration);
      if (d?.nodeType === 'FunctionDefinition' && ['external', 'public'].includes(d.visibility)) return routedTarget(d.id, ctx);
    }
    if (e?.nodeType === 'MemberAccess' && e.expression?.name === 'abi') {
      const a = n.arguments?.[0];
      if (e.memberName === 'encodeCall' && (a?.nodeType === 'MemberAccess' || a?.nodeType === 'Identifier')) {
        return routedTarget(a.referencedDeclaration, ctx);
      }
      if (e.memberName === 'encodeWithSignature' && a?.nodeType === 'Literal' && a.kind === 'string') {
        return ctx.routes.get(keccak256Hex(a.value).slice(0, 8));
      }
    }
    return undefined;
  }
  if (n.nodeType === 'MemberAccess' && n.memberName === 'selector') return routedTarget(n.expression?.referencedDeclaration, ctx);
  if ((n.nodeType === 'Identifier' || n.nodeType === 'MemberAccess') && n.referencedDeclaration !== undefined) {
    return constantTarget(n.referencedDeclaration, ctx).target;
  }
  return undefined;
}

/**
 * Walk the code one function reaches. Calls `visitNode(node, fnFrame)` for
 * every node of every reached body, where `fnFrame` is the reached function.
 * Returns `{ functions: Set<id>, unknown: string[] }`.
 */
export function reach(rootFn, rootContract, ctx, visitNode, { selfCalls = true } = {}) {
  const seen = new Set();
  const functions = new Set();
  const unknown = [];
  const queue = [{ fn: rootFn, lineage: rootContract?.linearizedBaseContracts }];
  while (queue.length) {
    const { fn, lineage } = queue.shift();
    if (!fn || seen.has(fn.id)) continue;
    seen.add(fn.id);
    functions.add(fn.id);
    const bodies = [fn.body];
    for (const m of fn.modifiers ?? []) {
      const md = ctx.byId.get(m.modifierName?.referencedDeclaration);
      if (md?.nodeType === 'ModifierDefinition') {
        const derived = mostDerived(md, lineage, ctx);
        if (!seen.has(derived.id)) {
          seen.add(derived.id);
          functions.add(derived.id);
          bodies.push(derived.body);
        }
      }
    }
    for (const body of bodies) {
      walk(body, (n) => {
        if (visitNode) visitNode(n, fn);
        if (n.nodeType === 'FunctionCall') {
          const e = n.expression;
          // Internal call.
          const typeString = e?.typeDescriptions?.typeString ?? '';
          const refId = e?.nodeType === 'Identifier' || e?.nodeType === 'MemberAccess' ? e.referencedDeclaration : undefined;
          const d = refId === undefined ? undefined : ctx.byId.get(refId);
          if (d?.nodeType === 'FunctionDefinition') {
            const external = /\bexternal\b/.test(typeString) || (e.nodeType === 'MemberAccess' && d.visibility === 'external');
            const library = ctx.contractOf.get(d.id)?.contractKind === 'library';
            if (!external || library) {
              const target = e.nodeType === 'Identifier' ? mostDerived(d, lineage, ctx) : d;
              if (target.body) queue.push({ fn: target, lineage: library ? undefined : lineage });
            }
          }
          // A low-level call on this contract whose data names no selector.
          const ll = e?.nodeType === 'FunctionCallOptions' ? e.expression : e;
          if (ll?.nodeType === 'MemberAccess' && LOW_LEVEL.has(ll.memberName) && isSelf(ll.expression)) {
            let named = false;
            walk(n.arguments, (x) => {
              if (x.nodeType === 'MemberAccess' && x.memberName === 'selector') named = true;
              if (x.nodeType === 'MemberAccess' && x.memberName === 'encodeCall') named = true;
              if (x.nodeType === 'FunctionCall' && x.expression?.memberName === 'encodeWithSignature' && x.arguments?.[0]?.nodeType === 'Literal') named = true;
              if ((x.nodeType === 'Identifier' || x.nodeType === 'MemberAccess') && constantTarget(x.referencedDeclaration, ctx).known) named = true;
              // Data handed in by the caller (`crossFacetCall(bytes data, ...)`):
              // the caller's own selector expression is what gets followed.
              // Only an internal helper's: an external entry's caller is outside.
              if (x.nodeType === 'Identifier' && ['internal', 'private'].includes(fn.visibility) && (fn.parameters?.parameters ?? []).some((p) => p.id === x.referencedDeclaration)) named = true;
            });
            if (!named) unknown.push(`a low-level ${ll.memberName} on this contract in ${fn.name} names no selector`);
          }
        }
        if (selfCalls) {
          const r = routedCallAt(n, ctx);
          if (r) queue.push({ fn: r.fn, lineage: r.contract.linearizedBaseContracts });
        }
        return undefined;
      });
    }
  }
  return { functions, unknown };
}

const isEmit = (n) => n.nodeType === 'EmitStatement' || (n.nodeType === 'YulFunctionCall' && /^log[0-4]$/.test(n.functionName?.name ?? ''));

function isRevertNode(n) {
  if (n.nodeType === 'RevertStatement') return true;
  if (n.nodeType === 'YulFunctionCall' && n.functionName?.name === 'revert') return true;
  if (n.nodeType === 'FunctionCall' && n.expression?.nodeType === 'Identifier' && ['revert', 'require'].includes(n.expression.name)) return true;
  return false;
}

// ─── The shipped contracts ───────────────────────────────────────────────

export function shippedNames(manifest) {
  return [...manifest.facets, ...manifest.standalone];
}

/** Every function and modifier with a body in a src/ file, with its contract. */
function srcFunctions(units) {
  const out = [];
  for (const u of units) {
    if (typeof u.absolutePath !== 'string' || !u.absolutePath.startsWith('src/')) continue;
    for (const c of u.nodes ?? []) {
      if (c.nodeType !== 'ContractDefinition') continue;
      for (const n of c.nodes ?? []) {
        if ((n.nodeType === 'FunctionDefinition' || n.nodeType === 'ModifierDefinition') && n.body) out.push({ fn: n, contract: c, path: u.absolutePath });
      }
    }
  }
  return out;
}

const fnKey = (contract, fn) => `${contract.name}.${fn.name || fn.kind}(${typeList(fn)})`;

// ─── Report 1: silent functions ──────────────────────────────────────────

export function silentFunctions(units, manifest, ctx = makeContext(units, manifest.facets)) {
  const { entries } = entryPoints(units, shippedNames(manifest), ctx.byId);
  const out = [];
  for (const e of entries) {
    const c = ctx.contracts.get(e.contract);
    let emits = false;
    const { unknown } = reach(e.fn, c, ctx, (n) => { if (isEmit(n)) emits = true; });
    if (!emits) out.push(unknown.length ? `${e.key} (unknown self-call: ${unknown[0]})` : e.key);
  }
  return { entries: [...new Set(out)].sort(), checked: entries.length };
}

// ─── Report 2: swallowed failures ────────────────────────────────────────

/** Whether the statements, and the code they reach, revert or emit. */
let syntheticId = -1;
function handles(stmts, contract, ctx) {
  let hit = false;
  const root = { nodeType: 'FunctionDefinition', id: syntheticId--, name: '(branch)', body: { nodeType: 'Block', statements: [stmts] }, modifiers: [] };
  reach(root, contract, ctx, (n) => { if (isEmit(n) || isRevertNode(n)) hit = true; });
  return hit;
}

/**
 * How a condition reads the flag a low-level call declared: 'ok' when the
 * branch runs only if the call succeeded, 'failed' when it runs whenever the
 * call failed. `!ok || x` is a failure test (it holds whenever the call
 * failed), `ok && x` a success test; parentheses are looked through.
 */
function flagTest(cond, flagId) {
  while (cond?.nodeType === 'TupleExpression' && cond.components?.length === 1) cond = cond.components[0];
  if (cond?.nodeType === 'Identifier' && cond.referencedDeclaration === flagId) return 'ok';
  if (cond?.nodeType === 'UnaryOperation' && cond.operator === '!') {
    const inner = flagTest(cond.subExpression, flagId);
    return inner === 'ok' ? 'failed' : inner === 'failed' ? 'ok' : undefined;
  }
  if (cond?.nodeType === 'BinaryOperation' && (cond.operator === '||' || cond.operator === '&&')) {
    const sides = [flagTest(cond.leftExpression, flagId), flagTest(cond.rightExpression, flagId)];
    if (cond.operator === '||' && sides.includes('failed')) return 'failed';
    if (cond.operator === '&&' && sides.includes('ok')) return 'ok';
  }
  return undefined;
}

export function swallowedFailures(units, ctx) {
  const out = [];
  for (const { fn, contract, path } of srcFunctions(units)) {
    const key = fnKey(contract, fn);
    let tryIndex = 0;
    let callIndex = 0;
    walk(fn.body, (n) => {
      if (n.nodeType === 'TryStatement') {
        tryIndex++;
        (n.clauses ?? []).slice(1).forEach((clause, i) => {
          if (!handles(clause.block, contract, ctx)) out.push(`${key} try#${tryIndex} catch#${i + 1} (${path})`);
        });
      }
      if (n.nodeType === 'Block' || n.nodeType === 'UncheckedBlock') {
        const stmts = n.statements ?? [];
        stmts.forEach((s, i) => {
          if (s.nodeType !== 'VariableDeclarationStatement') return;
          const init = s.initialValue;
          let callee = init?.nodeType === 'FunctionCall' ? init.expression : undefined;
          if (callee?.nodeType === 'FunctionCallOptions') callee = callee.expression; // x.call{value: v}(...)
          const isLowLevel = callee?.nodeType === 'MemberAccess' && LOW_LEVEL.has(callee.memberName);
          if (!isLowLevel) return;
          const flag = s.declarations?.[0];
          if (!flag || flag.typeDescriptions?.typeString !== 'bool') return;
          callIndex++;
          const label = `${key} lowlevel#${callIndex} (${path})`;
          let used = false;
          let judged = false;
          for (const later of stmts.slice(i + 1)) {
            walk(later, (x) => {
              if (x.nodeType === 'Identifier' && x.referencedDeclaration === flag.id) used = true;
            });
            if (later.nodeType === 'IfStatement') {
              const t = flagTest(later.condition, flag.id);
              if (t === 'failed') {
                judged = true;
                if (!handles(later.trueBody, contract, ctx)) out.push(label);
              } else if (t === 'ok') {
                judged = true;
                if (!later.falseBody || !handles(later.falseBody, contract, ctx)) out.push(label);
              }
            }
            if (judged) break;
          }
          if (!used) out.push(`${label} (flag never read)`);
        });
      }
      return undefined;
    });
  }
  return { entries: [...new Set(out)].sort() };
}

// ─── Report 3: ambiguous errors ──────────────────────────────────────────

function errorOf(call, ctx) {
  const d = ctx.byId.get(call?.expression?.referencedDeclaration);
  return d?.nodeType === 'ErrorDefinition' ? d : undefined;
}

function errorSig(err) {
  return `${err.name}(${typeList(err)})`;
}

/**
 * A parameter's canonical ABI type, as the catalogue (and the selector) spell
 * it: an enum is `uint8`, a contract `address`, a struct a tuple of its
 * members, a user-defined value type its underlying type.
 */
export function abiType(t, byId) {
  if (!t) return '?';
  if (t.nodeType === 'ArrayTypeName') return `${abiType(t.baseType, byId)}[${t.length?.value ?? ''}]`;
  if (t.nodeType === 'FunctionTypeName') return 'function';
  if (t.nodeType === 'UserDefinedTypeName') {
    const d = byId.get(t.referencedDeclaration);
    if (d?.nodeType === 'EnumDefinition') return 'uint8';
    if (d?.nodeType === 'ContractDefinition') return 'address';
    if (d?.nodeType === 'StructDefinition') return `(${d.members.map((m) => abiType(m.typeName, byId)).join(',')})`;
    if (d?.nodeType === 'UserDefinedValueTypeDefinition') return abiType(d.underlyingType, byId);
    return '?';
  }
  return (t.typeDescriptions?.typeString ?? t.name ?? '?').replace(/ payable$/, '');
}

/** An error's ABI signature (the catalogue's `signature`). */
export const errorAbiSig = (err, byId) => `${err.name}(${(err.parameters?.parameters ?? []).map((p) => abiType(p.typeName, byId)).join(',')})`;

export function ambiguousErrors(units, manifest, ctx = makeContext(units, manifest.facets), catalogue = undefined) {
  const { entries } = entryPoints(units, shippedNames(manifest), ctx.byId);
  // View entry points can raise too; the rule is per entry function.
  const viewEntries = [];
  for (const name of shippedNames(manifest)) {
    const c = ctx.contracts.get(name);
    if (!c) continue;
    const seenSel = new Set(entries.filter((e) => e.contract === name).map((e) => e.selector));
    for (const baseId of c.linearizedBaseContracts ?? [c.id]) {
      for (const n of ctx.byId.get(baseId)?.nodes ?? []) {
        if (n.nodeType !== 'FunctionDefinition' || !n.implemented || (n.visibility !== 'external' && n.visibility !== 'public')) continue;
        if (seenSel.has(n.functionSelector)) continue;
        seenSel.add(n.functionSelector);
        viewEntries.push({ key: `${name}.${n.name}(${typeList(n)})`, contract: name, fn: n });
      }
    }
  }
  const ambiguous = [];
  for (const e of [...entries, ...viewEntries]) {
    const sites = new Map();
    reach(e.fn, ctx.contracts.get(e.contract), ctx, (n) => {
      let err;
      if (n.nodeType === 'RevertStatement') err = errorOf(n.errorCall, ctx);
      else if (n.nodeType === 'FunctionCall' && n.expression?.name === 'require' && n.arguments?.[1]?.nodeType === 'FunctionCall') err = errorOf(n.arguments[1], ctx);
      if (!err || (err.parameters?.parameters ?? []).length) return;
      // Grouped by what the caller receives (the ABI signature, so the
      // selector), not by declaration: two `Bad()` errors declared in
      // different places revert with the same data.
      const sig = errorAbiSig(err, ctx.byId);
      if (!sites.has(sig)) sites.set(sig, { err, ids: new Set() });
      sites.get(sig).ids.add(n.id);
    });
    for (const { err, ids } of sites.values()) if (ids.size > 1) ambiguous.push(`${e.key} :: ${errorSig(err)} x${ids.size}`);
  }

  const textReverts = [];
  const reasonless = [];
  for (const { fn, contract, path } of srcFunctions(units)) {
    let t = 0;
    let r = 0;
    walk(fn.body, (n) => {
      if (n.nodeType !== 'FunctionCall' || n.expression?.nodeType !== 'Identifier') return;
      const name = n.expression.name;
      if (name !== 'require' && name !== 'revert') return;
      const reasonArg = name === 'require' ? n.arguments?.[1] : n.arguments?.[0];
      if (reasonArg?.nodeType === 'Literal' || reasonArg?.typeDescriptions?.typeString?.startsWith('literal_string') || reasonArg?.typeDescriptions?.typeString === 'string memory') {
        t++;
        textReverts.push(`${fnKey(contract, fn)} text#${t} (${path})`);
      } else if (!reasonArg) {
        r++;
        reasonless.push(`${fnKey(contract, fn)} reasonless#${r} (${path})`);
      }
    });
  }

  // Every error a shipped contract's interface carries.
  const declared = new Set();
  for (const name of shippedNames(manifest)) {
    const c = ctx.contracts.get(name);
    if (!c) continue;
    for (const id of c.usedErrors ?? []) {
      const d = ctx.byId.get(id);
      if (d?.nodeType === 'ErrorDefinition') declared.add(errorAbiSig(d, ctx.byId));
    }
  }
  // Rows are keyed by selector; the signature is in the row.
  const catalogued = new Set(Object.values(catalogue?.errors ?? {}).map((row) => row?.signature).filter(Boolean));
  const uncatalogued = [...declared].filter((s) => !catalogued.has(s));

  return {
    entries: [
      ...ambiguous.map((x) => `ambiguous ${x}`),
      ...textReverts.map((x) => `text ${x}`),
      ...reasonless.map((x) => `reasonless ${x}`),
      ...uncatalogued.map((x) => `uncatalogued ${x}`),
    ].sort(),
    counts: { ambiguous: ambiguous.length, text: textReverts.length, reasonless: reasonless.length, errors: declared.size, uncatalogued: uncatalogued.length },
  };
}

// ─── Report 4: write-only storage ────────────────────────────────────────

/** The field a storage access chain names: `s.f`, `s.f[k]`, `s.f[k].g` → each MemberAccess on a storage base. */
function storageField(n, ctx) {
  if (n.nodeType === 'MemberAccess') {
    const d = ctx.byId.get(n.referencedDeclaration);
    const base = n.expression?.typeDescriptions?.typeString ?? '';
    if (d?.nodeType === 'VariableDeclaration' && /storage/.test(base) && ctx.structMembers.has(d.id)) return d;
  }
  if (n.nodeType === 'Identifier') {
    const d = ctx.byId.get(n.referencedDeclaration);
    if (d?.nodeType === 'VariableDeclaration' && d.stateVariable && !d.constant && d.mutability !== 'immutable' && d.mutability !== 'constant') return d;
  }
  return undefined;
}

/** Every field node on the left-side chain of a write target. */
function lvalueFields(e, ctx, out) {
  if (!e) return;
  const f = storageField(e, ctx);
  if (f) out.push({ node: e, field: f });
  if (e.nodeType === 'IndexAccess') lvalueFields(e.baseExpression, ctx, out);
  else if (e.nodeType === 'MemberAccess') lvalueFields(e.expression, ctx, out);
  else if (e.nodeType === 'TupleExpression') for (const c of e.components ?? []) lvalueFields(c, ctx, out);
}

export function writeOnlyStorage(units, manifest, ctx = makeContext(units, manifest.facets)) {
  ctx.structMembers = new Set();
  const memberOwner = new Map();
  for (const u of units) {
    if (typeof u.absolutePath !== 'string' || !u.absolutePath.startsWith('src/')) continue;
    walk(u, (n) => {
      if (n.nodeType === 'StructDefinition') for (const m of n.members ?? []) {
        ctx.structMembers.add(m.id);
        memberOwner.set(m.id, `${n.canonicalName ?? n.name}.${m.name}`);
      }
      if (n.nodeType === 'ContractDefinition') for (const v of n.nodes ?? []) {
        if (v.nodeType === 'VariableDeclaration' && v.stateVariable) memberOwner.set(v.id, `${n.name}.${v.name}`);
      }
    });
  }
  // Functions a state-changing entry point reaches.
  const { entries } = entryPoints(units, shippedNames(manifest), ctx.byId);
  const live = new Set();
  for (const e of entries) for (const id of reach(e.fn, ctx.contracts.get(e.contract), ctx).functions) live.add(id);
  // Modifiers reached are bodies too: include them by marking their ids.
  // Code in scope: the shipped contracts with their bases, and every library
  // a shipped entry reaches. A contract outside the manifest has no entry
  // points here, so its reads would never count and every field it writes
  // would be listed; it is left out instead of reported wrongly.
  const scope = new Set();
  for (const name of shippedNames(manifest)) for (const b of ctx.contracts.get(name)?.linearizedBaseContracts ?? []) scope.add(b);
  for (const id of live) { const c = ctx.contractOf.get(id); if (c) scope.add(c.id); }
  const writes = new Map();
  const reads = new Map();
  const bump = (m, id) => m.set(id, (m.get(id) ?? 0) + 1);
  for (const { fn } of srcFunctions(units)) {
    if (!scope.has(ctx.contractOf.get(fn.id)?.id)) continue;
    const lv = new Set();
    walk(fn.body, (n) => {
      let targets = [];
      if (n.nodeType === 'Assignment') {
        lvalueFields(n.leftHandSide, ctx, targets);
        // `x += 1` reads x only to update it: not a read by contract code.
      } else if (n.nodeType === 'UnaryOperation' && ['++', '--', 'delete'].includes(n.operator)) {
        lvalueFields(n.subExpression, ctx, targets);
      } else if (n.nodeType === 'FunctionCall' && n.expression?.nodeType === 'MemberAccess' && ['push', 'pop'].includes(n.expression.memberName)) {
        lvalueFields(n.expression.expression, ctx, targets);
      }
      for (const t of targets) {
        lv.add(t.node.id);
        bump(writes, t.field.id);
      }
      return undefined;
    });
    walk(fn.body, (n) => {
      if (lv.has(n.id)) return undefined;
      const f = storageField(n, ctx);
      if (f && live.has(fn.id)) bump(reads, f.id);
      return undefined;
    });
  }
  const out = [];
  for (const [id, w] of writes) {
    if (!(w > 0) || reads.get(id) || !memberOwner.has(id)) continue;
    // A public state variable has a getter: no contract code reads it, but
    // something outside may. Listed, and marked, so the ledger can say which.
    const d = ctx.byId.get(id);
    out.push(d?.stateVariable && d.visibility === 'public' ? `${memberOwner.get(id)} (public getter)` : memberOwner.get(id));
  }
  return { entries: [...new Set(out)].sort(), fieldsWritten: writes.size };
}

// ─── Results and ledger ──────────────────────────────────────────────────

export function readJson(p, fallback) {
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : fallback;
}

/** Problems in the ledger itself. */
export function ledgerProblems(ledger) {
  const problems = [];
  for (const r of REPORTS) {
    for (const [entry, reason] of Object.entries(ledger[r] ?? {})) {
      if (typeof reason !== 'string' || reason.length < 20) problems.push(`ledger ${r}: "${entry}" needs a reason of at least 20 characters`);
    }
  }
  for (const k of Object.keys(ledger)) if (!REPORTS.includes(k) && k !== '_readme') problems.push(`ledger: unknown report ${k}`);
  return problems;
}

/** Compare current entries with the committed result and the ledger. Pure. */
export function compare(current, committed, listed) {
  const base = new Set(committed);
  const ok = new Set(Object.keys(listed ?? {}));
  const now = new Set(current);
  return {
    worse: current.filter((e) => !base.has(e) && !ok.has(e)),
    improved: committed.filter((e) => !now.has(e)),
    staleListed: [...ok].filter((e) => !now.has(e)),
  };
}

export function eventCategories(outDir) {
  const { violations } = lintEvents(outDir);
  const counts = {};
  for (const v of violations) counts[v.kind] = (counts[v.kind] ?? 0) + 1;
  // One entry per event signature: an untagged event is one fix wherever it is inherited.
  return { entries: [...new Set(violations.map((v) => `${v.kind} ${v.event}${v.tag ? ` <${v.tag}>` : ''}`))].sort(), counts: { ...counts, events: new Set(violations.map((v) => v.event)).size } };
}

export function runReports(units, manifest, catalogue, outDir) {
  const ctx = makeContext(units, manifest.facets);
  return {
    'event-categories': outDir ? eventCategories(outDir) : { entries: [] },
    'silent-functions': silentFunctions(units, manifest, ctx),
    'swallowed-failures': swallowedFailures(units, ctx),
    'ambiguous-errors': ambiguousErrors(units, manifest, ctx, catalogue),
    'write-only-storage': writeOnlyStorage(units, manifest, ctx),
  };
}

export function main(argv = process.argv.slice(2)) {
  const [cmd, ...rest] = argv;
  let outDir = BUILD_OUT_DIR;
  let only;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--out' && rest[i + 1]) outDir = rest[++i];
    else if (rest[i] === '--report' && rest[i + 1]) only = rest[++i];
    else {
      console.error(`refactor-reports: unknown argument ${rest[i]}`);
      return 2;
    }
  }
  if (only !== undefined && !REPORTS.includes(only)) {
    console.error(`refactor-reports: unknown report ${only} (one of ${REPORTS.join(', ')})`);
    return 2;
  }
  if (!['check', 'write', 'list'].includes(cmd)) {
    console.error('usage: refactor-reports.mjs check|write|list [--out <dir>] [--report <name>]');
    return 2;
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
  const infos = readdirSync(join(outDir, 'build-info')).filter((n) => n.endsWith('.json')).map((n) => JSON.parse(readFileSync(join(outDir, 'build-info', n), 'utf8')));
  const jobProblems = oneJobProblems(units, infos);
  if (jobProblems.length) {
    for (const p of jobProblems.slice(0, 5)) console.error(`  ✗ ${p}`);
    return 1;
  }
  const manifest = JSON.parse(readFileSync(FACETS_FILE, 'utf8'));
  if (!existsSync(CATALOGUE_FILE)) {
    console.error(`  ✗ the error catalogue ${relative(process.cwd(), CATALOGUE_FILE)} is missing: without it every error would read as uncatalogued`);
    return 1;
  }
  const results = runReports(units, manifest, readJson(CATALOGUE_FILE, undefined), outDir);
  const config = readJson(join(REPORTS_DIR, 'config.json'), { blocking: false });
  const ledger = readJson(join(REPORTS_DIR, 'ledger.json'), {});
  const problems = ledgerProblems(ledger);
  const names = only ? [only] : REPORTS;

  if (cmd === 'list') {
    for (const r of names) for (const e of results[r].entries) console.log(`${r}  ${e}`);
    return 0;
  }
  if (cmd === 'write') {
    mkdirSync(REPORTS_DIR, { recursive: true });
    for (const r of names) {
      const { entries, ...counts } = results[r];
      writeFileSync(join(REPORTS_DIR, `${r}.json`), `${JSON.stringify({ report: r, counts: { entries: entries.length, ...counts }, entries }, null, 2)}\n`);
      console.log(`  ✓ ${r}: ${entries.length} entries written`);
    }
    return problems.length ? (problems.forEach((p) => console.error(`  ✗ ${p}`)), 1) : 0;
  }
  let worse = 0;
  for (const r of names) {
    const committed = readJson(join(REPORTS_DIR, `${r}.json`), { entries: [] }).entries;
    const c = compare(results[r].entries, committed, ledger[r]);
    worse += c.worse.length;
    const mark = c.worse.length ? (config.blocking ? '✗' : '⚠') : '✓';
    console.log(`  ${mark} ${r}: ${results[r].entries.length} entries (committed ${committed.length}, ${c.worse.length} new, ${c.improved.length} gone)`);
    for (const e of c.worse.slice(0, 20)) console.log(`      new: ${e}`);
    if (c.worse.length > 20) console.log(`      ... and ${c.worse.length - 20} more`);
    if (c.improved.length) console.log(`      ${c.improved.length} gone: run \`node contracts/script/refactor-reports.mjs write\` and commit the results`);
    for (const e of c.staleListed) console.log(`      listed but no longer found (remove from the ledger): ${e}`);
  }
  for (const p of problems) console.error(`  ✗ ${p}`);
  if (worse && !config.blocking) console.log(`  ⚠ ${worse} new finding(s): a warning until the refactor pass ends (refactor-reports/config.json "blocking": false)`);
  return problems.length || (worse && config.blocking) ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main();
}
