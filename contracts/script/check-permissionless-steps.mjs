#!/usr/bin/env node
/**
 * check-permissionless-steps.mjs — every entry point anyone may call is
 * classified, and every liveness step names the keeper pass behind it (#2984).
 *
 * The owner's rule (2026-10-27): every permissionless step that keeps the
 * protocol moving has the platform keeper as its backstop. Anyone may call it,
 * and if nobody does, the keeper does. Before this check nothing recorded
 * which open entry point was which, so a new step could ship with no caller
 * and stall the protocol silently. The ledger is
 * `contracts/permissionless-steps.json`; this script keeps it exact.
 *
 * ── What it derives, from the compiler's AST ────────────────────────────
 *
 * For every contract the Diamond is built from (the `facets` list of
 * packages/contracts/scripts/diamond-facets.json) and every standalone
 * contract the protocol ships beside it (`standalone`), it lists each
 * external or public function that can change state (not `view`, not
 * `pure`), inherited ones included. A function is CALLER-GATED, and left out
 * of the ledger, when it reverts unless the caller is a particular address or
 * holds a particular role. That is decided from the code, never claimed:
 *
 *   - a top-level statement of its body, or of a modifier it carries (before
 *     the modifier's `_`), is a caller test:
 *       `if (<cond>) revert ...;` where <cond> is true for every caller but
 *         the allowed ones: `sender != X`, `!<check of sender>` (a role or
 *         set membership), `<check local> == 0`, an `||` with one such side,
 *         or an `&&` of such sides; or
 *       `require(<cond>, ...)` where <cond> holds only for the allowed ones:
 *         `sender == X`, a positive check of sender, a check local, an `&&`
 *         with one such side, or an `||` of such sides; or
 *   - a top-level statement is an INTERNAL call (a statement of its own, the
 *     right side of an assignment, or a local's initial value) to a function
 *     whose own body is caller-gated by the same rules, with any argument
 *     that is the sender standing for the sender inside it. A call by bare
 *     name and a modifier both resolve to the most-derived override in the
 *     contract analyzed, so UUPS's `_authorizeUpgrade` is the subclass's.
 *     An external call (`other.f()`, `this.f()`) is never followed: inside
 *     it the sender is this contract, not the caller; or
 *   - a top-level `if/else` whose every branch gates or reverts, or a nested
 *     block that gates.
 *
 * "Sender" is `msg.sender`, `_msgSender()`, a parameter the caller bound to
 * either, or a local initialized from one. A comparison of the sender with a
 * value the CALLER chose (a parameter of the entry point, passed on to a
 * helper or modifier, or a `cond ? x : param` with such a branch) is no gate:
 * every caller can pass its own address. A "check local" is a `bool` local
 * initialized to a check of the sender, or a mapping read keyed by it
 * (`channelOf[msg.sender]`, non-zero only for registered senders). No
 * statement before the gate may `return`, so every path that completes
 * passes the test; the one exception is `if (<cond>) return;` where <cond>
 * admits only allowed callers. What the condition compares the sender WITH is
 * not judged: a function only its signer, its holder, the messenger or the
 * Diamond itself may call is caller-gated alike, and none of them is a step
 * anyone may take. A KYC requirement (`SCREENS`) is a screen, not a gate: it
 * admits everyone while enforcement is off, which it is on the retail
 * deploy. Inline assembly is outside what the AST shows, and none gates a
 * caller in src/ today.
 *
 * Every other state-changing function is OPEN: anyone may call it. Each open
 * function must have exactly one ledger row, keyed `Contract.name(types)`,
 * and every row must name an open function that still exists.
 *
 * ── What each row says, and what is checked ─────────────────────────────
 *
 *   class "keeper"          a liveness step the keeper backs. `pass` is a
 *                           pass in apps/keeper/src/passSchedule.ts, `flag`
 *                           the arming flag it reads (apps/keeper/src/env.ts),
 *                           and `evidence` the keeper-side file that sends the
 *                           call; that file must carry the function's name as
 *                           a string literal in code (`sendsCall`): a comment,
 *                           a backticked mention or an ABI fragment's `name:`
 *                           does not count.
 *   class "keeper-pending"  the same, with the pass still in an open PR
 *                           (`pr`). Refused once the keeper already sends it:
 *                           the row then becomes "keeper".
 *   class "service"         a liveness step another committed service backs
 *                           (`service`, e.g. the sanctions delister);
 *                           `evidence` is the file that sends the call and
 *                           must name it, as for "keeper".
 *   class "alternative"     another route to a step a backed row already
 *                           covers (a liquidator choosing the match route);
 *                           `of` names that row, which must be "keeper",
 *                           "keeper-pending" or "service".
 *   class "gap"             a liveness step with no keeper yet; `issue` is the
 *                           card that builds it. Recorded gaps pass, because
 *                           the failure this prevents is an UNRECORDED one.
 *   class "user"            called by the party it serves (its own offer, its
 *                           own vault, its own claim, its own signature); `why`
 *                           says which party, and why no keeper is owed.
 *   class "init"            a one-shot initializer the deploy runs; it must
 *                           carry an `initializer`/`reinitializer` modifier.
 *   class "gated"           caller-gated in a way the rules above cannot see
 *                           (a signature, a pin consumed by the caller). `gate`
 *                           says how. These rows are claims a reviewer audits;
 *                           extend the rules rather than add to them.
 *
 * The keeper-side checks need no compiler, so `--ledger-only` runs them alone
 * (the keeper's typecheck runs it); a keeper change that drops a call or
 * renames a pass or flag then fails there, not only in the contracts gate.
 *
 * The AST comes from the artifacts the measured-delivery guard builds
 * (`out-measured-delivery/`, one `forge build --force --ast` job), as the
 * loan-terms writer guard reads them, so the pre-deploy gate pays for one AST
 * build. AST ids are resolved across files, which only one job makes sound.
 *
 * CLI: node contracts/script/check-permissionless-steps.mjs [--out <dir>] [--ledger-only] [--suggest] [--list]
 *   --out          read artifacts already built with `forge build --force --ast`
 *   --ledger-only  check the rows' keeper references only (no AST)
 *   --suggest      print a skeleton row for each open function with none
 *   --list         print every entry point with its gate, or its row's class
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONTRACTS_DIR, REPO_ROOT, FACETS_FILE, loadBuild } from './storage-layout-guard.mjs';
import { BUILD_OUT_DIR, oneJobProblems } from './check-measured-delivery.mjs';

export const LEDGER_FILE = join(CONTRACTS_DIR, 'permissionless-steps.json');
export const KEEPER_SRC = join(REPO_ROOT, 'apps', 'keeper', 'src');
export const PASS_SCHEDULE = join(KEEPER_SRC, 'passSchedule.ts');
export const KEEPER_ENV = join(KEEPER_SRC, 'env.ts');

export const CLASSES = {
  keeper: ['pass', 'flag', 'evidence'],
  'keeper-pending': ['pass', 'flag', 'pr'],
  service: ['service', 'evidence', 'why'],
  alternative: ['of', 'why'],
  gap: ['issue', 'why'],
  user: ['why'],
  init: ['why'],
  gated: ['gate'],
};

const MAX_DEPTH = 8;

// ─── AST helpers ─────────────────────────────────────────────────────────

function walk(node, visit) {
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

/** Every node with an id, across all units. */
export function indexNodes(units) {
  const byId = new Map();
  for (const u of units) walk(u, (n) => { if (typeof n.id === 'number') byId.set(n.id, n); });
  return byId;
}

const unwrap = (e) => (e?.nodeType === 'TupleExpression' && e.components?.length === 1 ? unwrap(e.components[0]) : e);

/** Is `e` the sender: `msg.sender`, `_msgSender()`, or a parameter bound to it? */
export function isSender(e, bound) {
  e = unwrap(e);
  if (!e) return false;
  if (e.nodeType === 'MemberAccess' && e.memberName === 'sender' && e.expression?.nodeType === 'Identifier' && e.expression.name === 'msg') return true;
  if (e.nodeType === 'FunctionCall' && (e.arguments ?? []).length === 0 && e.expression?.nodeType === 'Identifier' && e.expression.name === '_msgSender') return true;
  if (e.nodeType === 'Identifier' && bound.has(e.referencedDeclaration)) return true;
  return false;
}

function mentionsSender(e, bound) {
  let hit = false;
  walk(e, (n) => {
    if (hit) return false;
    if (isSender(n, bound)) {
      hit = true;
      return false;
    }
    return undefined;
  });
  return hit;
}

/**
 * Compliance screens of the sender. Each admits every caller the deploy's
 * compliance switches admit (KYC enforcement is off on the retail deploy, so
 * it admits everyone), which makes it a screen, not a caller gate: a function
 * behind one is still a step anyone may take.
 */
export const SCREENS = new Set(['meetsKYCRequirement', 'isKYCVerified']);

const calledName = (e) => (e?.nodeType === 'FunctionCall' ? e.expression?.memberName ?? e.expression?.name : undefined);

/** A check that holds only for some callers: a role or membership test of the sender. */
function isSenderCheck(e, bound) {
  e = unwrap(e);
  if (SCREENS.has(calledName(e))) return false;
  return ['FunctionCall', 'IndexAccess', 'MemberAccess'].includes(e?.nodeType) && !isSender(e, bound) && mentionsSender(e, bound);
}

/**
 * A local that holds a check of the sender (`bool byOwner = msg.sender ==
 * owner();`, `bytes32 ch = channelOf[msg.sender];`) is true or non-zero only
 * for the allowed callers. It is recorded in `bound` under `check:<id>`.
 */
const checkKey = (id) => `check:${id}`;
const isCheckLocal = (e, bound) => {
  e = unwrap(e);
  return e?.nodeType === 'Identifier' && bound.has(checkKey(e.referencedDeclaration));
};

/**
 * Whether a local's initial value is a check of the sender: a `bool` that
 * admits only the allowed callers, or a mapping read keyed by the sender
 * (non-zero only for registered senders). A number a call happens to compute
 * from the sender (a claimable amount, a fee) is not a check.
 */
function holdsCheck(init, bound) {
  init = unwrap(init);
  if (!init) return false;
  if (init.typeDescriptions?.typeString === 'bool') return admitsOnly(init, bound);
  return init.nodeType === 'IndexAccess' && isSender(init.indexExpression, bound);
}

/** A zero or false literal, or a conversion of one (`bytes32(0)`, `address(0)`). */
function isZero(e) {
  e = unwrap(e);
  if (e?.nodeType === 'Literal') return e.value === '0' || e.value === 'false';
  return e?.nodeType === 'FunctionCall' && e.kind === 'typeConversion' && e.arguments?.length === 1 && isZero(e.arguments[0]);
}

/** `local == 0` (or `0 == local`) for a check local: true for every caller but the allowed ones. */
const checkLocalIsZero = (l, r, bound) => (isCheckLocal(l, bound) && isZero(r)) || (isCheckLocal(r, bound) && isZero(l));

/**
 * A value the caller chose: a parameter of the entry point, or a callee or
 * modifier parameter bound to one. `bound` holds it as `free:<id>`. Comparing
 * the sender with such a value restricts no one, since every caller can pass
 * its own address (`renounceRole(role, account)`'s confirmation is the case).
 */
const freeKey = (id) => `free:${id}`;
const isFree = (e, bound) => {
  e = unwrap(e);
  // `retired ? controller : account` lets the caller pick `account` whenever that branch runs.
  if (e?.nodeType === 'Conditional') return isFree(e.trueExpression, bound) || isFree(e.falseExpression, bound);
  return e?.nodeType === 'Identifier' && bound.has(freeKey(e.referencedDeclaration));
};

/** `sender` on one side, and on the other a value the caller did not choose. */
const senderVsFixed = (l, r, bound) => (isSender(l, bound) && !isFree(r, bound)) || (isSender(r, bound) && !isFree(l, bound));

/** Bind each parameter of a callee or modifier: to the sender, or as caller-chosen. */
function bindParams(params, args, bound) {
  const inner = new Set();
  params.forEach((p, i) => {
    if (isSender(args[i], bound)) inner.add(p.id);
    else if (isFree(args[i], bound)) inner.add(freeKey(p.id));
  });
  return inner;
}

/** True when `cond` is true for every caller except the allowed ones (an `if (cond) revert` gate). */
export function rejectsOthers(cond, bound) {
  cond = unwrap(cond);
  if (!cond) return false;
  if (cond.nodeType === 'BinaryOperation') {
    if (cond.operator === '==') return checkLocalIsZero(cond.leftExpression, cond.rightExpression, bound);
    if (cond.operator === '!=') return senderVsFixed(cond.leftExpression, cond.rightExpression, bound);
    if (cond.operator === '||') return rejectsOthers(cond.leftExpression, bound) || rejectsOthers(cond.rightExpression, bound);
    if (cond.operator === '&&') return rejectsOthers(cond.leftExpression, bound) && rejectsOthers(cond.rightExpression, bound);
    return false;
  }
  if (cond.nodeType === 'UnaryOperation' && cond.operator === '!') return admitsOnly(cond.subExpression, bound);
  return false;
}

/** True when `cond` holds only for the allowed callers (a `require(cond)` gate). */
export function admitsOnly(cond, bound) {
  cond = unwrap(cond);
  if (!cond) return false;
  if (cond.nodeType === 'BinaryOperation') {
    if (cond.operator === '==') return senderVsFixed(cond.leftExpression, cond.rightExpression, bound);
    if (cond.operator === '!=') return checkLocalIsZero(cond.leftExpression, cond.rightExpression, bound);
    if (cond.operator === '&&') return admitsOnly(cond.leftExpression, bound) || admitsOnly(cond.rightExpression, bound);
    if (cond.operator === '||') return admitsOnly(cond.leftExpression, bound) && admitsOnly(cond.rightExpression, bound);
    return false;
  }
  if (cond.nodeType === 'UnaryOperation' && cond.operator === '!') return rejectsOthers(cond.subExpression, bound);
  return isCheckLocal(cond, bound) || isSenderCheck(cond, bound);
}

function reverts(stmt) {
  if (!stmt) return false;
  if (stmt.nodeType === 'RevertStatement') return true;
  if (stmt.nodeType === 'ExpressionStatement') {
    const c = stmt.expression;
    return c?.nodeType === 'FunctionCall' && c.expression?.nodeType === 'Identifier' && c.expression.name === 'revert';
  }
  if (stmt.nodeType === 'Block') return reverts(stmt.statements?.[0]);
  return false;
}

function returnsAtOnce(stmt) {
  if (stmt?.nodeType === 'Return') return true;
  return stmt?.nodeType === 'Block' && stmt.statements?.[0]?.nodeType === 'Return';
}

function containsReturn(stmt) {
  let hit = false;
  walk(stmt, (n) => {
    if (hit) return false;
    if (n.nodeType === 'Return') hit = true;
    return undefined;
  });
  return hit;
}

/**
 * The most-derived definition of a virtual function or modifier in the
 * contract being analyzed. An internal call by bare name and a modifier
 * invocation both dispatch virtually, so `_authorizeUpgrade(...)` inside
 * UUPSUpgradeable runs the override the analyzed contract carries, not the
 * bodiless base declaration the AST references.
 */
function mostDerived(decl, ctx) {
  if (!decl?.virtual || !ctx.lineage) return decl;
  const sig = decl.nodeType === 'FunctionDefinition' ? typeList(decl) : undefined;
  for (const baseId of ctx.lineage) {
    for (const n of ctx.byId.get(baseId)?.nodes ?? []) {
      if (n.nodeType !== decl.nodeType || n.name !== decl.name || !n.body) continue;
      if (sig !== undefined && typeList(n) !== sig) continue;
      return n;
    }
  }
  return decl;
}

/**
 * The declaration a call resolves to, when it is an INTERNAL call to a
 * function defined in the sources. An external call (`other.f()`,
 * `this.f()`) runs with this contract as its sender, so a gate inside it
 * tests this contract, not the caller, and is never followed.
 */
function calleeOf(call, ctx) {
  const e = call.expression;
  if (/\bexternal\b/.test(e?.typeDescriptions?.typeString ?? '')) return undefined;
  const id = e?.nodeType === 'Identifier' || e?.nodeType === 'MemberAccess' ? e.referencedDeclaration : undefined;
  let d = id === undefined ? undefined : ctx.byId.get(id);
  if (d?.nodeType === 'FunctionDefinition' && e.nodeType === 'Identifier') d = mostDerived(d, ctx);
  return d?.nodeType === 'FunctionDefinition' && d.body ? d : undefined;
}

/**
 * Whether the statement list gates the caller before it ends or reaches `_`
 * (for a modifier). Returns the gate it found, as a short label, or undefined.
 */
function gateIn(statements, bound, ctx, depth, seen) {
  return scan(statements, new Set(bound), ctx, depth, seen).gate;
}

/** A call's gate, when the call is to a source function whose own body is caller-gated. */
function callGate(call, bound, ctx, depth, seen) {
  if (call?.nodeType !== 'FunctionCall') return undefined;
  if (call.expression?.nodeType === 'Identifier' && call.expression.name === 'require') {
    return admitsOnly(call.arguments?.[0], bound) ? 'caller test' : undefined;
  }
  const callee = calleeOf(call, ctx);
  const via = callee && calleeGate(callee, call, bound, ctx, depth, seen);
  return via ? `${callee.name} → ${via}` : undefined;
}

/** A branch of an if/else gates when it always reverts or its own statements gate. */
function branchGate(b, bound, ctx, depth, seen) {
  if (reverts(b)) return 'reverts';
  const list = b?.nodeType === 'Block' || b?.nodeType === 'UncheckedBlock' ? b.statements : [b];
  return scan(list, new Set(bound), ctx, depth, seen).gate;
}

/**
 * Walk the top-level statements in order. `{gate}` when one is a caller gate;
 * `{stop}` when control can leave (a `return`, or a modifier's `_`) first.
 * `bound` is extended in place by `address sender = msg.sender;`.
 */
function scan(statements, bound, ctx, depth, seen) {
  for (const s of statements ?? []) {
    if (s.nodeType === 'PlaceholderStatement') return { stop: true };
    if (s.nodeType === 'VariableDeclarationStatement') {
      // `address sender = _msgSender();` makes the local a name for the sender.
      if (s.declarations?.length === 1 && s.declarations[0] && isSender(s.initialValue, bound)) {
        bound.add(s.declarations[0].id);
        continue;
      }
      // `Storage storage s = _gates(...);` runs a gating callee as it declares.
      const g = callGate(s.initialValue, bound, ctx, depth, seen);
      if (g) return { gate: g };
      // `bool byOwner = msg.sender == owner();` holds a check of the sender.
      if (s.declarations?.length === 1 && s.declarations[0] && holdsCheck(s.initialValue, bound)) {
        bound.add(checkKey(s.declarations[0].id));
        continue;
      }
    }
    if (s.nodeType === 'IfStatement') {
      if (!s.falseBody && reverts(s.trueBody) && rejectsOthers(s.condition, bound)) return { gate: 'caller test' };
      // `if (msg.sender == principal) return;` lets only an allowed caller out early.
      if (!s.falseBody && returnsAtOnce(s.trueBody) && admitsOnly(s.condition, bound)) continue;
      if (s.falseBody) {
        const t = branchGate(s.trueBody, bound, ctx, depth, seen);
        const f = t && branchGate(s.falseBody, bound, ctx, depth, seen);
        if (t && f) return { gate: `every branch (${t}; ${f})` };
      }
    }
    if (s.nodeType === 'Block' || s.nodeType === 'UncheckedBlock') {
      const r = scan(s.statements, new Set(bound), ctx, depth, seen);
      if (r.gate || r.stop) return r;
      continue;
    }
    if (s.nodeType === 'ExpressionStatement') {
      const e = s.expression;
      const g = callGate(e?.nodeType === 'Assignment' ? e.rightHandSide : e, bound, ctx, depth, seen);
      if (g) return { gate: g };
    }
    if (containsReturn(s)) return { stop: true };
  }
  return {};
}

function calleeGate(callee, call, bound, ctx, depth, seen) {
  if (depth >= MAX_DEPTH) return undefined;
  const params = callee.parameters?.parameters ?? [];
  // A bound receiver (`using L for address` → `msg.sender.f()`) is the first parameter.
  const args = [...(call.arguments ?? [])];
  if (call.expression?.nodeType === 'MemberAccess' && params.length === args.length + 1) args.unshift(call.expression.expression);
  const inner = bindParams(params, args, bound);
  const key = `${callee.id}:${[...inner].sort().join(',')}`;
  if (seen.has(key)) return undefined;
  seen.add(key);
  return functionGate(callee, inner, ctx, depth + 1, seen);
}

/**
 * The gate a function definition carries, from its modifiers (in order) or its
 * own body, with `bound` naming the parameters that stand for the sender.
 */
function functionGate(fn, bound, ctx, depth, seen) {
  for (const m of fn.modifiers ?? []) {
    const def = mostDerived(ctx.byId.get(m.modifierName?.referencedDeclaration), ctx);
    if (def?.nodeType !== 'ModifierDefinition' || !def.body) continue;
    const inner = bindParams(def.parameters?.parameters ?? [], m.arguments ?? [], bound);
    const g = gateIn(def.body.statements, inner, ctx, depth + 1, seen);
    if (g) return `modifier ${def.name} → ${g}`;
  }
  return gateIn(fn.body?.statements, bound, ctx, depth, seen);
}

/** The gate a function carries, from its modifiers or its own body, or undefined when it is open. */
export function gateOf(fn, byId, lineage) {
  const free = new Set((fn.parameters?.parameters ?? []).map((p) => freeKey(p.id)));
  return functionGate(fn, free, { byId, lineage }, 0, new Set());
}

function typeList(fn) {
  return (fn.parameters?.parameters ?? []).map((p) => canonicalType(p.typeDescriptions?.typeString ?? '?')).join(',');
}

/** An ABI type from a solc type string (`struct X.S memory` → its tuple is not expanded; the name is kept). */
function canonicalType(ts) {
  return ts
    .replace(/ (memory|calldata|storage)( pointer| ref)?/g, '')
    .replace(/^contract /, 'contract:')
    .replace(/^enum /, 'enum:')
    .replace(/^struct /, 'struct:')
    .replace(/ payable$/, '');
}

/**
 * Every state-changing external or public function of each named contract,
 * with its gate (undefined when open). Inherited functions are included; an
 * override hides what it overrides. Pure over the ASTs.
 *
 * @returns {{key: string, contract: string, name: string, selector: string, mutability: string, modifiers: string[], gate?: string, fn: object}[]}
 */
export function entryPoints(units, names, byId = indexNodes(units)) {
  const contracts = new Map();
  for (const u of units) {
    if (typeof u.absolutePath !== 'string' || !u.absolutePath.startsWith('src/')) continue;
    for (const n of u.nodes ?? []) if (n.nodeType === 'ContractDefinition') contracts.set(n.name, n);
  }
  const out = [];
  const missing = [];
  for (const name of names) {
    const c = contracts.get(name);
    if (!c) {
      missing.push(name);
      continue;
    }
    const bySelector = new Map();
    for (const baseId of c.linearizedBaseContracts ?? [c.id]) {
      const base = byId.get(baseId);
      for (const n of base?.nodes ?? []) {
        if (n.nodeType !== 'FunctionDefinition' || n.kind !== 'function' || !n.implemented) continue;
        if (n.visibility !== 'external' && n.visibility !== 'public') continue;
        if (n.stateMutability === 'view' || n.stateMutability === 'pure') continue;
        if (!bySelector.has(n.functionSelector)) bySelector.set(n.functionSelector, n);
      }
    }
    for (const fn of bySelector.values()) {
      out.push({
        key: `${name}.${fn.name}(${typeList(fn)})`,
        contract: name,
        name: fn.name,
        selector: fn.functionSelector,
        mutability: fn.stateMutability,
        modifiers: (fn.modifiers ?? []).map((m) => m.modifierName?.name ?? ''),
        gate: gateOf(fn, byId, c.linearizedBaseContracts),
        fn,
      });
    }
  }
  return { entries: out, missing };
}

// ─── Ledger ──────────────────────────────────────────────────────────────

export function readLedger(text) {
  const doc = JSON.parse(text);
  if (!doc || typeof doc.steps !== 'object') throw new Error('permissionless-steps.json: expected an object with a `steps` map');
  return doc.steps;
}

/** Problems with the rows' own shape. Pure. */
export function rowProblems(steps) {
  const problems = [];
  for (const [key, row] of Object.entries(steps)) {
    const need = CLASSES[row?.class];
    if (!need) {
      problems.push(`${key}: class must be one of ${Object.keys(CLASSES).join(', ')}`);
      continue;
    }
    for (const f of need) if (row[f] === undefined || row[f] === '') problems.push(`${key}: class "${row.class}" needs \`${f}\``);
    for (const f of ['pr', 'issue']) if (row[f] !== undefined && !/^#\d+$/.test(String(row[f]))) problems.push(`${key}: \`${f}\` must read #<number>`);
  }
  return problems;
}

/** Problems with the open set against the ledger. Pure. */
export function coverageProblems(entries, steps) {
  const problems = [];
  const open = new Map(entries.filter((e) => !e.gate).map((e) => [e.key, e]));
  const gated = new Map(entries.filter((e) => e.gate).map((e) => [e.key, e]));
  for (const [key, e] of [...open].sort(([a], [b]) => a.localeCompare(b))) {
    const row = steps[key];
    if (!row) {
      problems.push(`${key}: anyone may call this ${e.mutability === 'payable' ? 'payable ' : ''}entry point and the ledger does not classify it — add a row (keeper, keeper-pending, gap, user, init or gated)`);
      continue;
    }
    if (row.class === 'init' && !e.modifiers.some((m) => m === 'initializer' || m === 'reinitializer')) {
      problems.push(`${key}: class "init" needs an initializer or reinitializer modifier, and the function carries neither`);
    }
  }
  for (const key of Object.keys(steps).sort()) {
    if (open.has(key)) continue;
    if (gated.has(key)) problems.push(`${key}: the row is stale — the function is caller-gated (${gated.get(key).gate}); remove the row`);
    else problems.push(`${key}: the row names no state-changing entry point of a shipped contract — remove or rename it`);
  }
  return problems;
}

/** The keeper's pass names, from passSchedule.ts. */
export function passNames(text) {
  return new Set([...text.matchAll(/^\s*name: '([A-Za-z0-9_]+)',/gm)].map((m) => m[1]));
}

/** The keeper's configuration keys, from env.ts's PLAIN_VAR_KEYS. */
export function envKeys(text) {
  const block = text.match(/export const PLAIN_VAR_KEYS = \[([\s\S]*?)\]/);
  if (!block) return new Set();
  return new Set([...block[1].matchAll(/'([A-Z0-9_]+)'/g)].map((m) => m[1]));
}

/**
 * TypeScript / JavaScript source with its comments blanked out. String and
 * template literals are kept (a comment marker inside one is not a comment).
 */
export function stripComments(text) {
  let out = '';
  for (let i = 0; i < text.length; ) {
    const c = text[i];
    const d = text[i + 1];
    if (c === '/' && d === '/') {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (c === '/' && d === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end < 0 ? text.length : end + 2;
      out += text.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
    } else if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < text.length && text[j] !== c) j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/**
 * Does the source send `name`? It must appear as a plain string literal in
 * CODE: not in a comment, not as a backticked mention, and not as the `name:`
 * of an ABI fragment (which declares a function without calling it). The
 * keeper's senders take the function name as such a literal
 * (`functionName: 'x'`, `sender.call(label, subject, 'x', args)`).
 */
export function sendsCall(name, text) {
  const code = stripComments(text);
  const re = new RegExp(`(['"])${name}\\1`, 'g');
  for (const m of code.matchAll(re)) {
    if (!/\bname\s*:\s*$/.test(code.slice(Math.max(0, m.index - 40), m.index))) return true;
  }
  return false;
}

/** Does any keeper source send `name`? */
function keeperSendsAnywhere(name, files) {
  return files.some((f) => sendsCall(name, f.text));
}

function sourceFiles(dir) {
  const out = [];
  const visit = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) visit(p);
      else if (/\.ts$/.test(e.name) && !/\.test\.ts$/.test(e.name)) out.push({ path: p, text: readFileSync(p, 'utf8') });
    }
  };
  visit(dir);
  return out;
}

/** Problems with the rows' keeper references. `read(path)` returns a file's text or undefined. */
export function keeperProblems(steps, { passes, flags, keeperFiles, read }) {
  const problems = [];
  const backed = new Set(['keeper', 'keeper-pending', 'service']);
  for (const [key, row] of Object.entries(steps)) {
    const name = key.slice(key.indexOf('.') + 1, key.indexOf('('));
    if (row.class === 'alternative') {
      if (!backed.has(steps[row.of]?.class)) problems.push(`${key}: \`of\` must name a keeper, keeper-pending or service row, and ${row.of} is ${steps[row.of] ? `a "${steps[row.of].class}" row` : 'not a row'}`);
      continue;
    }
    if (row.class === 'keeper' || row.class === 'service') {
      if (row.class === 'keeper') {
        if (!passes.has(row.pass)) problems.push(`${key}: pass "${row.pass}" is not in apps/keeper/src/passSchedule.ts`);
        if (!flags.has(row.flag)) problems.push(`${key}: flag ${row.flag} is not a keeper configuration key (apps/keeper/src/env.ts PLAIN_VAR_KEYS)`);
      }
      const text = read(join(REPO_ROOT, row.evidence));
      if (text === undefined) problems.push(`${key}: evidence ${row.evidence} does not exist`);
      else if (!sendsCall(name, text)) problems.push(`${key}: evidence ${row.evidence} does not send ${name} (a string literal in code, not a comment or an ABI \`name:\`) — point it at the file that sends the call`);
    } else if (row.class === 'keeper-pending' && keeperSendsAnywhere(name, keeperFiles)) {
      problems.push(`${key}: the keeper now names ${name} — if its pass has merged, make the row "keeper" with its pass, flag and evidence`);
    }
  }
  return problems;
}

function readIfPresent(p) {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return undefined;
  }
}

function suggestions(entries, steps) {
  const lines = [];
  for (const e of entries) {
    if (e.gate || steps[e.key]) continue;
    lines.push(`    ${JSON.stringify(e.key)}: { "class": "?", "why": "" },`);
  }
  return lines;
}

export function main(argv = process.argv.slice(2)) {
  let outDir = BUILD_OUT_DIR;
  let ledgerOnly = false;
  let suggest = false;
  let list = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out' && argv[i + 1]) outDir = argv[++i];
    else if (argv[i] === '--ledger-only') ledgerOnly = true;
    else if (argv[i] === '--suggest') suggest = true;
    else if (argv[i] === '--list') list = true;
    else {
      console.error(`check-permissionless-steps: unknown argument ${argv[i]}`);
      return 2;
    }
  }
  let steps;
  try {
    steps = readLedger(readFileSync(LEDGER_FILE, 'utf8'));
  } catch (e) {
    console.error(`  ✗ ${e.message}`);
    return 1;
  }
  const problems = rowProblems(steps);
  problems.push(
    ...keeperProblems(steps, {
      passes: passNames(readFileSync(PASS_SCHEDULE, 'utf8')),
      flags: envKeys(readFileSync(KEEPER_ENV, 'utf8')),
      keeperFiles: sourceFiles(KEEPER_SRC),
      read: readIfPresent,
    }),
  );
  let summary = '';
  if (!ledgerOnly) {
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
    const { entries, missing } = entryPoints(units, [...manifest.facets, ...manifest.standalone]);
    for (const m of missing) problems.push(`${m}: named in diamond-facets.json but not among the compiled src/ contracts — the check would not see it`);
    if (list) {
      for (const e of entries) console.log(e.gate ? `gated  ${e.key}  <${e.gate}>` : `open   ${e.key}  [${steps[e.key]?.class ?? 'NO ROW'}]`);
      return 0;
    }
    if (suggest) {
      console.log(suggestions(entries, steps).join('\n'));
      return 0;
    }
    problems.push(...coverageProblems(entries, steps));
    const open = entries.filter((e) => !e.gate).length;
    summary = `${entries.length} state-changing entry points, ${entries.length - open} caller-gated, ${open} open and classified`;
  }
  if (problems.length) {
    for (const p of problems) console.error(`  ✗ ${p}`);
    return 1;
  }
  const counts = {};
  for (const r of Object.values(steps)) counts[r.class] = (counts[r.class] ?? 0) + 1;
  const tally = Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ');
  console.log(`  ✓ permissionless steps: ${summary ? `${summary} (${tally})` : `ledger keeper references hold (${tally})`}`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main();
}
