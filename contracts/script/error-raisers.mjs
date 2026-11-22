#!/usr/bin/env node
/**
 * error-raisers.mjs — which entry functions can raise each error (#3916).
 *
 * The error catalogue (`packages/contracts/src/errorCatalogue.json`, built by
 * `packages/contracts/scripts/build-error-catalogue.mjs`) lists, for every
 * error the platform ships, every entry function whose reachable code can
 * raise it. This module derives that list from the compiler's AST, never from
 * source text, and writes it to `packages/contracts/src/errorRaisers.json`.
 *
 * ── The bounded rule ────────────────────────────────────────────────────
 *
 * The question asked is "does the code reachable from this entry function
 * contain a raise of this error", never "does some path raise it". The second
 * has no end (RefactorRulesDesign §4), so a listed entry is a place to look,
 * not a proof that some input reaches the raise.
 *
 * An entry function is an external or public function of a contract named in
 * `diamond-facets.json` (facets, proxy, standalone), inherited ones included,
 * views too: a preview refuses with the same errors its action does. The
 * Diamond proxy's own `fallback` is an entry of its own, and every call to the
 * Diamond passes through it.
 *
 * A RAISE is, inside a function or a modifier:
 *   - `revert E(...)`;
 *   - `require(cond, E(...))`;
 *   - `E.selector` passed as an argument to a call. That is how the shared
 *     revert helpers raise a typed error when the inner call returned no
 *     reason (`LibRevert.bubbleOnFailureTyped(ok, data, E.selector)`), and how
 *     an encoded skip or fallback reason is built. A `.selector` compared
 *     with something (`bytes4(reason) == E.selector`) is a decode, not a
 *     raise, and is not counted;
 *   - `revert("text")` / `require(cond, "text")`, recorded as `Error(string)`;
 *   - `revert()` / `require(cond)`, recorded as the empty revert.
 *
 * REACHABLE code is followed through:
 *   - internal and library calls, and modifiers, with a virtual function or
 *     modifier resolved to the most-derived override in the contract the
 *     entry belongs to;
 *   - SELF-CALLS: a typed call on `address(this)` or `this`. From a facet it
 *     is followed into every facet that routes the selector; from a
 *     standalone contract, into that contract;
 *   - ENCODED calls: `abi.encodeWithSelector(F.selector, ...)`,
 *     `abi.encodeCall(F, ...)` and `F.selector` passed to a call. The bytes
 *     can go anywhere, so the target is taken from F's DECLARATION, by the
 *     same rule as a typed external call below (a facet's function reaches
 *     the Diamond's routing; `VaipakamVaultImplementation.grantAllowance`
 *     reaches the vault), plus F in the encoding contract itself when it is
 *     standalone. A low-level call whose failure the caller catches is still
 *     followed: this map states presence, not path feasibility;
 *   - typed external calls to an interface or contract DECLARED IN `src/`
 *     (the protocol's own interfaces), followed into each shipped contract
 *     that implements it: inherits it, or has every function it declares (a
 *     price read reaches `PriceGuard`, a vault step the vault implementation,
 *     an `IPositionNFTCore.mint` the `PositionNFT`, which does not inherit
 *     that interface). The Diamond counts as a contract that answers its
 *     whole routed surface, so an interface every function of which some
 *     facet hosts reaches the Diamond, and each call goes to the facet that
 *     routes it (the aggregator adapter's `fundLenderIntent` reaches
 *     `LenderIntentFacet`). Calls through standard interfaces
 *     declared in `lib/` (IERC20, IERC721, ...) are not followed: they reach
 *     tokens the platform does not ship, and following them into the
 *     platform's own token contracts would list those contracts' errors under
 *     every transfer.
 *
 * What it cannot see, and says so in the catalogue's header:
 *   - inline assembly (a revert written in assembly, or a call made there);
 *   - a `catch` that swallows a reached raise (the raise is still listed);
 *   - a call to a contract the platform does not ship.
 *
 * Pure over the ASTs: `raisersFrom(units, manifest)` returns the map; `main`
 * reads the AST build the measured-delivery guard makes
 * (`out-measured-delivery/`, `forge build --force --ast`, quick profile).
 *
 * CLI: node contracts/script/error-raisers.mjs [--out <dir>] [--write <file>] [--build] [--check] [--abi-dir <dir>]
 *   --out      read artifacts already built with `forge build --force --ast`
 *   --build    build them first (FOUNDRY_PROFILE=quick)
 *   --write    where to write the map (default packages/contracts/src/errorRaisers.json)
 *   --check    compare with that file instead of writing it (the pre-deploy gate, step 1f)
 *   --abi-dir  the exported interfaces to compare declarations with (the ABI
 *              export passes its staged set; default packages/contracts/src/abis)
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CONTRACTS_DIR, REPO_ROOT, FACETS_FILE, loadBuild } from './storage-layout-guard.mjs';
import { BUILD_OUT_DIR, oneJobProblems } from './check-measured-delivery.mjs';
import { indexNodes } from './check-permissionless-steps.mjs';

export const RAISERS_FILE = join(REPO_ROOT, 'packages', 'contracts', 'src', 'errorRaisers.json');

/** The selector solc gives `Error(string)` and the key used for an empty revert. */
export const ERROR_STRING = '0x08c379a0';
export const EMPTY_REVERT = '0x';

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

const unwrap = (e) => (e?.nodeType === 'TupleExpression' && e.components?.length === 1 ? unwrap(e.components[0]) : e);
const hex4 = (s) => `0x${String(s).replace(/^0x/, '').toLowerCase()}`;

/** `address(this)`, `this`, or a contract conversion of either (`IFoo(address(this))`). */
function isSelf(e) {
  e = unwrap(e);
  if (!e) return false;
  if (e.nodeType === 'Identifier' && e.name === 'this') return true;
  if (e.nodeType === 'FunctionCall' && e.kind === 'typeConversion' && e.arguments?.length === 1) return isSelf(e.arguments[0]);
  return false;
}

/**
 * The contracts named in the manifest, with each one's entry functions and
 * the Diamond's routing (selector → facet functions).
 */
function describe(c, role, byId) {
  const lineage = c.linearizedBaseContracts ?? [c.id];
  const bySelector = new Map();
  // Every selector the contract answers, public state-variable getters
  // included (they raise nothing, but they count when matching an interface).
  const answers = new Set();
  let fallback;
  for (const baseId of lineage) {
    for (const n of byId.get(baseId)?.nodes ?? []) {
      if (n.nodeType === 'VariableDeclaration' && n.functionSelector) answers.add(n.functionSelector);
      if (n.nodeType !== 'FunctionDefinition' || !n.implemented) continue;
      if (n.kind === 'fallback' || n.kind === 'receive') {
        if (n.kind === 'fallback' && !fallback) fallback = n;
        continue;
      }
      if (n.kind !== 'function') continue;
      if (n.visibility !== 'external' && n.visibility !== 'public') continue;
      if (!bySelector.has(n.functionSelector)) bySelector.set(n.functionSelector, n);
      answers.add(n.functionSelector);
    }
  }
  return { name: c.name, role, node: c, lineage, bySelector, answers, fallback };
}

/**
 * The contracts named in the manifest (the entries), and every other
 * concrete contract in src/ (reached only through a call: a contract the
 * shipped ones deploy or delegate to, such as the price guard's reader).
 */
function shippedContracts(units, manifest, byId) {
  const contracts = new Map();
  for (const u of units) {
    if (typeof u.absolutePath !== 'string' || !u.absolutePath.startsWith('src/')) continue;
    for (const n of u.nodes ?? []) if (n.nodeType === 'ContractDefinition') contracts.set(n.name, n);
  }
  const roles = [
    ...manifest.facets.map((n) => [n, 'facet']),
    ...(manifest.proxy ?? []).map((n) => [n, 'proxy']),
    ...(manifest.standalone ?? []).map((n) => [n, 'standalone']),
  ];
  const shipped = [];
  const missing = [];
  const named = new Set();
  for (const [name, role] of roles) {
    const c = contracts.get(name);
    named.add(name);
    if (!c) {
      missing.push(name);
      continue;
    }
    shipped.push(describe(c, role, byId));
  }
  const reachedOnly = [];
  for (const [name, c] of contracts) {
    if (named.has(name) || c.contractKind !== 'contract' || c.abstract) continue;
    reachedOnly.push(describe(c, 'reached', byId));
  }
  return { shipped, reachedOnly, missing };
}

/**
 * Contracts that answer some of their entry functions by DELEGATING the call
 * to another contract whose address is a constructor input, so the AST cannot
 * name the target. Each pair is stated here, with the reason, and is applied
 * only to a function of the first that has a same-selector function in the
 * second. Keep it short: a delegate the AST can name needs no entry.
 */
export const DELEGATES = {
  // PriceGuard forwards every price read to READER by `delegatecall` of
  // `msg.data` (#3437), so the read's refusals are the reader's.
  PriceGuard: 'PriceGuardReader',
};

/**
 * Most-derived override of a virtual function or modifier, within `lineage`.
 * A non-virtual declaration, or one with no override, is returned as is.
 */
function mostDerived(decl, lineage, byId) {
  if (!decl?.virtual || !lineage) return decl;
  const params = (d) => (d.parameters?.parameters ?? []).map((p) => p.typeDescriptions?.typeString ?? '?').join(',');
  const sig = params(decl);
  for (const baseId of lineage) {
    for (const n of byId.get(baseId)?.nodes ?? []) {
      if (n.nodeType !== decl.nodeType || n.name !== decl.name || !n.body) continue;
      if (params(n) !== sig) continue;
      return n;
    }
  }
  return decl;
}

/** The function a `.selector` member names, when it names one (not an error). */
function functionOfSelector(e, byId) {
  e = unwrap(e);
  if (e?.nodeType !== 'MemberAccess' || e.memberName !== 'selector') return undefined;
  const d = byId.get(e.expression?.referencedDeclaration);
  return d?.nodeType === 'FunctionDefinition' ? d : undefined;
}

/** The error a `.selector` member names, when it names one. */
function errorOfSelector(e, byId) {
  e = unwrap(e);
  if (e?.nodeType !== 'MemberAccess' || e.memberName !== 'selector') return undefined;
  const d = byId.get(e.expression?.referencedDeclaration);
  return d?.nodeType === 'ErrorDefinition' ? d : undefined;
}

/** The error a raise's call names (`E(...)` in `revert E(...)` or `require(c, E(...))`). */
function errorOfCall(call, byId) {
  call = unwrap(call);
  if (call?.nodeType !== 'FunctionCall') return undefined;
  const d = byId.get(call.expression?.referencedDeclaration);
  return d?.nodeType === 'ErrorDefinition' ? d : undefined;
}


/** An ABI parameter (`{name, type, components?}`) from an AST variable declaration. */
export function abiParam(v, byId) {
  const conv = (t) => {
    if (!t) return { type: '?' };
    if (t.nodeType === 'ElementaryTypeName') return { type: (t.name ?? t.typeDescriptions?.typeString ?? '?').replace(/ payable$/, '') === 'byte' ? 'bytes1' : (t.name ?? t.typeDescriptions?.typeString).replace(/ payable$/, '') };
    if (t.nodeType === 'ArrayTypeName') {
      const base = conv(t.baseType);
      const len = t.length?.value ?? '';
      return { ...base, type: `${base.type}[${len}]` };
    }
    if (t.nodeType === 'UserDefinedTypeName') {
      const d = byId.get(t.referencedDeclaration ?? t.pathNode?.referencedDeclaration);
      if (d?.nodeType === 'EnumDefinition') return { type: 'uint8' };
      if (d?.nodeType === 'ContractDefinition') return { type: 'address' };
      if (d?.nodeType === 'UserDefinedValueTypeDefinition') return conv(d.underlyingType);
      if (d?.nodeType === 'StructDefinition') return { type: 'tuple', components: (d.members ?? []).map((m) => abiParam(m, byId)) };
    }
    return { type: '?' };
  };
  return { name: v.name ?? '', ...conv(v.typeName) };
}

const abiTypeOf = (p) => (p.type.startsWith('tuple') ? `(${(p.components ?? []).map(abiTypeOf).join(',')})${p.type.slice(5)}` : p.type);

/** `{signature, inputs}` of an AST error definition. */
export function errorDeclaration(d, byId) {
  const inputs = (d.parameters?.parameters ?? []).map((v) => abiParam(v, byId));
  return { signature: `${d.name}(${inputs.map(abiTypeOf).join(',')})`, inputs };
}

/** The selector of an error definition, from solc's own field. */
function errorSelector(d) {
  if (typeof d.errorSelector === 'string') return hex4(d.errorSelector);
  return undefined;
}

/**
 * The direct facts of one function or modifier body: the errors it raises,
 * the internal calls and modifiers it reaches, the Diamond selectors it
 * self-calls and the external declarations it calls.
 */
function bodyFacts(fn, byId) {
  const raises = new Set();
  const internal = []; // {decl, dispatch}: dispatch = resolve virtually at walk time
  const selfSelectors = new Set();
  const externalDecls = [];
  // Functions named by an encoding (`F.selector` passed to a call,
  // `abi.encodeCall(F, ...)`): the bytes may go to the Diamond, to this
  // contract or to another platform contract, so the target is resolved from
  // F's declaration at walk time, the same way as a typed external call.
  const encodedDecls = [];
  const unknownErrors = [];

  const raiseError = (d) => {
    const sel = errorSelector(d);
    if (sel) raises.add(sel);
    else unknownErrors.push(d.name);
  };

  for (const m of fn.modifiers ?? []) {
    const d = byId.get(m.modifierName?.referencedDeclaration);
    if (d?.nodeType === 'ModifierDefinition') internal.push({ decl: d, dispatch: true });
  }

  walk(fn.body, (n) => {
    if (n.nodeType === 'RevertStatement') {
      const d = errorOfCall(n.errorCall, byId);
      if (d) raiseError(d);
      return undefined;
    }
    if (n.nodeType !== 'FunctionCall') return undefined;
    // `f{gas: g}(...)` / `f{value: v}(...)` wrap the called member in call options.
    const e = n.expression?.nodeType === 'FunctionCallOptions' ? n.expression.expression : n.expression;
    const callee = e?.nodeType === 'Identifier' || e?.nodeType === 'MemberAccess' ? byId.get(e.referencedDeclaration) : undefined;
    const args = n.arguments ?? [];

    // require / revert builtins.
    if (e?.nodeType === 'Identifier' && (e.name === 'require' || e.name === 'revert') && !callee) {
      const reason = e.name === 'require' ? args[1] : args[0];
      if (!reason) raises.add(EMPTY_REVERT);
      else {
        const d = errorOfCall(reason, byId);
        if (d) raiseError(d);
        else if (unwrap(reason)?.typeDescriptions?.typeString?.startsWith('literal_string') || unwrap(reason)?.typeDescriptions?.typeString?.startsWith('string')) raises.add(ERROR_STRING);
      }
    }

    // `E.selector` passed to a call is a typed raise; `F.selector` names F.
    for (const a of args) {
      const err = errorOfSelector(a, byId);
      if (err) raiseError(err);
      const f = functionOfSelector(a, byId);
      if (f?.functionSelector) encodedDecls.push(f);
    }
    // abi.encodeCall(F, (...)) names F directly.
    if (e?.nodeType === 'MemberAccess' && e.memberName === 'encodeCall' && unwrap(e.expression)?.name === 'abi') {
      const f = byId.get(unwrap(args[0])?.referencedDeclaration);
      if (f?.nodeType === 'FunctionDefinition' && f.functionSelector) encodedDecls.push(f);
    }

    if (callee?.nodeType === 'FunctionDefinition') {
      const external = /\bexternal\b/.test(e?.typeDescriptions?.typeString ?? '');
      if (external) {
        if (e.nodeType === 'MemberAccess' && isSelf(e.expression)) {
          if (callee.functionSelector) selfSelectors.add(hex4(callee.functionSelector));
        } else {
          externalDecls.push(callee);
        }
      } else {
        // Only a call by bare name dispatches virtually. `super.f()` and
        // `Base.f()` name the exact declaration solc resolved, and
        // re-dispatching `super.f()` would loop back into the override.
        internal.push({ decl: callee, dispatch: e.nodeType === 'Identifier' });
      }
    }
    return undefined;
  });

  return { raises, internal, selfSelectors, externalDecls, encodedDecls, unknownErrors };
}

/**
 * Every shipped contract's entry functions, with the errors their reachable
 * code can raise.
 *
 * @returns {{ raisers: Record<string, string[]>, entries: number, missing: string[], unknownErrors: string[] }}
 *   raisers: error selector (or `0x` for the empty revert) → sorted entry keys
 *   `Contract.name(selector)`; the proxy's fallback is `VaipakamDiamond.fallback`.
 */
export function raisersFrom(units, manifest, byId = indexNodes(units)) {
  const { shipped, reachedOnly, missing } = shippedContracts(units, manifest, byId);
  const byName = new Map([...shipped, ...reachedOnly].map((c) => [c.name, c]));

  // The Diamond's routing, and where each src/ declaration's function lives.
  const routing = new Map(); // selector → [{contract, fn}]
  for (const c of shipped) {
    if (c.role !== 'facet') continue;
    for (const [sel, fn] of c.bySelector) {
      const k = hex4(sel);
      if (!routing.has(k)) routing.set(k, []);
      routing.get(k).push({ contract: c, fn });
    }
  }
  const declaringContract = new Map(); // FunctionDefinition id → ContractDefinition
  for (const u of units) {
    for (const n of u.nodes ?? []) {
      if (n.nodeType !== 'ContractDefinition') continue;
      for (const m of n.nodes ?? []) if (m.nodeType === 'FunctionDefinition') declaringContract.set(m.id, { contract: n, path: u.absolutePath });
    }
  }
  // A contract implements a src/ interface when it inherits it, or when it has
  // every function the interface declares: a narrow interface
  // (IPositionNFTCore for PositionNFT) is often not inherited by the contract it
  // targets. Matching on the whole interface, not the one selector, keeps a call
  // through a one-off interface's `transferOwnership` from reaching every
  // Ownable contract the platform ships.
  //
  // The Diamond is one implementer like any other: it answers its whole routed
  // surface, so an interface whose every function some facet hosts (one facet
  // or several, IVaipakamIntentSurface for the aggregator adapter) reaches the
  // Diamond, and each call resolves through the routing to the facet that
  // hosts that selector. A facet is never a target by itself: nothing calls a
  // facet's address.
  const ifaceSelectors = new Map(); // interface id → [selector]
  const selectorsOf = (iface) => {
    if (!ifaceSelectors.has(iface.id)) {
      const sels = [];
      for (const m of iface.nodes ?? []) {
        if (m.nodeType === 'FunctionDefinition' && m.functionSelector) sels.push(m.functionSelector);
      }
      ifaceSelectors.set(iface.id, sels);
    }
    return ifaceSelectors.get(iface.id);
  };
  const conformance = new Map();
  const implementsDeclaring = (c, iface) => {
    if (c.lineage.includes(iface.id)) return true;
    const key = `${c.node.id}:${iface.id}`;
    if (!conformance.has(key)) {
      const sels = selectorsOf(iface);
      conformance.set(key, sels.length > 0 && sels.every((x) => c.answers.has(x)));
    }
    return conformance.get(key);
  };
  // Only an interface, or a contract some facet is built from, can be the
  // Diamond's: a concrete standalone contract (the vault implementation) is
  // that contract even when facets happen to route every one of its
  // selectors.
  const facetLineage = new Set(shipped.filter((c) => c.role === 'facet').flatMap((c) => c.lineage));
  const diamondImplements = (iface) => {
    if (iface.contractKind !== 'interface' && !facetLineage.has(iface.id)) return false;
    const sels = selectorsOf(iface);
    return sels.length > 0 && sels.every((x) => routing.has(hex4(x)));
  };
  const externalTargets = (decl) => {
    const owner = declaringContract.get(decl.id);
    if (!owner || !owner.path?.startsWith('src/') || !decl.functionSelector) return [];
    const out = [];
    for (const c of [...shipped, ...reachedOnly]) {
      if (c.role === 'facet' || c.role === 'proxy') continue;
      if (!implementsDeclaring(c, owner.contract)) continue;
      const fn = c.bySelector.get(decl.functionSelector);
      if (fn) out.push({ contract: c, fn });
    }
    if (diamondImplements(owner.contract)) out.push(...(routing.get(hex4(decl.functionSelector)) ?? []));
    return out;
  };

  // An encoded call names a function, not a target. It reaches every
  // implementation a typed call through F's declaration would reach (the
  // Diamond's routing when the Diamond implements F's contract or interface,
  // and each shipped contract that implements it, the encoding contract
  // itself included), and, from a standalone contract, F in that contract
  // when it has one. A declaration outside src/ (a token's `transfer`) is
  // followed nowhere, as for a typed call.
  const encodedTargets = (decl, from) => {
    const out = externalTargets(decl);
    if (from.role !== 'facet' && from.role !== 'proxy') {
      const own = from.bySelector.get(decl.functionSelector);
      if (own && !out.some((t) => t.fn === own && t.contract === from)) out.push({ contract: from, fn: own });
    }
    return out;
  };

  const factsCache = new Map();
  const facts = (fn) => {
    if (!factsCache.has(fn.id)) factsCache.set(fn.id, bodyFacts(fn, byId));
    return factsCache.get(fn.id);
  };
  const unknownErrors = new Set();

  /** Errors reachable from `fn` run in the context of `contract`. */
  const reach = (fn, contract) => {
    const out = new Set();
    const seen = new Set();
    const stack = [[fn, contract]];
    while (stack.length) {
      const [f, c] = stack.pop();
      const key = `${f.id}@${c.node.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const ff = facts(f);
      for (const s of ff.raises) out.add(s);
      for (const u of ff.unknownErrors) unknownErrors.add(u);
      for (const { decl: d, dispatch } of ff.internal) {
        const target = dispatch ? mostDerived(d, c.lineage, byId) : d;
        if (target?.body) stack.push([target, c]);
      }
      for (const sel of ff.selfSelectors) {
        // A self-call from a facet goes through the Diamond; from a standalone
        // contract it stays in that contract.
        if (c.role === 'facet' || c.role === 'proxy') {
          for (const r of routing.get(sel) ?? []) if (r.fn.body) stack.push([r.fn, r.contract]);
        } else {
          const own = c.bySelector.get(sel.slice(2));
          if (own?.body) stack.push([own, c]);
        }
      }
      const delegate = byName.get(DELEGATES[c.name]);
      if (delegate && f.functionSelector) {
        const g = delegate.bySelector.get(f.functionSelector);
        if (g?.body) stack.push([g, delegate]);
      }
      for (const d of ff.externalDecls) {
        for (const t of externalTargets(d)) if (t.fn.body) stack.push([t.fn, t.contract]);
      }
      for (const d of ff.encodedDecls) {
        for (const t of encodedTargets(d, c)) if (t.fn.body) stack.push([t.fn, t.contract]);
      }
    }
    return out;
  };

  const raisers = new Map();
  let entries = 0;
  const add = (sel, key) => {
    if (!raisers.has(sel)) raisers.set(sel, new Set());
    raisers.get(sel).add(key);
  };
  for (const c of shipped) {
    if (c.role === 'proxy' && c.fallback) {
      entries++;
      for (const s of reach(c.fallback, c)) add(s, `${c.name}.fallback`);
    }
    for (const [sel, fn] of c.bySelector) {
      if (!fn.body) continue;
      entries++;
      const key = `${c.name}.${fn.name}(${hex4(sel)})`;
      for (const s of reach(fn, c)) add(s, key);
    }
  }
  const out = {};
  for (const sel of [...raisers.keys()].sort()) out[sel] = [...raisers.get(sel)].sort();
  // The declaration of every raised error, so an error declared only in a
  // contract whose interface is not exported (a swap adapter, a holder the
  // Diamond deploys) still reaches the catalogue with its values.
  const declarations = {};
  for (const n of byId.values()) {
    if (n.nodeType !== 'ErrorDefinition') continue;
    const sel = errorSelector(n);
    if (sel && raisers.has(sel) && !declarations[sel]) declarations[sel] = errorDeclaration(n, byId);
  }
  return { raisers: out, declarations, entries, missing, unknownErrors: [...unknownErrors].sort() };
}

function buildArtifacts() {
  const args = ['build', '--force', '--ast', '--out', BUILD_OUT_DIR, '--cache-path', join(CONTRACTS_DIR, 'cache-measured-delivery')];
  console.log(`error-raisers: building src/ (FOUNDRY_PROFILE=quick forge ${args.map((a) => relative(CONTRACTS_DIR, a) || a).join(' ')})`);
  const r = spawnSync('forge', args, { cwd: CONTRACTS_DIR, env: { ...process.env, FOUNDRY_PROFILE: 'quick' }, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (r.error) return `could not run forge: ${r.error.message}`;
  if (r.status !== 0) return `forge build failed (exit ${r.status ?? r.signal}):\n${`${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split('\n').slice(-30).join('\n')}`;
  return undefined;
}

/** Read the AST build and derive the map. Returns `{ok, result?, problems}`. */
export function deriveFromBuild(outDir = BUILD_OUT_DIR) {
  const build = loadBuild(outDir);
  if (build.problems.length) return { ok: false, problems: build.problems };
  const units = [...build.units.values()];
  const infos = readdirSync(join(outDir, 'build-info')).filter((n) => n.endsWith('.json')).map((n) => JSON.parse(readFileSync(join(outDir, 'build-info', n), 'utf8')));
  const jobProblems = oneJobProblems(units, infos);
  if (jobProblems.length) return { ok: false, problems: jobProblems };
  const manifest = JSON.parse(readFileSync(FACETS_FILE, 'utf8'));
  const result = raisersFrom(units, manifest);
  const problems = result.missing.map((m) => `${m}: named in diamond-facets.json but not among the compiled src/ contracts`);
  if (result.unknownErrors.length) problems.push(`errors with no selector in the AST (an older solc?): ${result.unknownErrors.slice(0, 5).join(', ')}`);
  return { ok: problems.length === 0, result, problems };
}

/** The file's text: stable order, one entry per line, so a diff reads as a list. */
export function renderRaisers(raisers, declarations = {}) {
  const decl = Object.keys(declarations).sort().map((sel) => `    ${JSON.stringify(sel)}: ${JSON.stringify(declarations[sel])}`);
  const lines = Object.entries(raisers).map(([sel, keys]) => `    ${JSON.stringify(sel)}: ${JSON.stringify(keys)}`);
  const readme = 'GENERATED by contracts/script/error-raisers.mjs from the compiler\'s AST. raisers: error selector (0x = a revert with no data) -> every entry function whose reachable code can raise it, as Contract.function(selector). declarations: errors raised there that no exported interface declares. Do not edit.';
  return `{\n  "_readme": ${JSON.stringify(readme)},\n  "declarations": {\n${decl.join(',\n')}\n  },\n  "raisers": {\n${lines.join(',\n')}\n  }\n}\n`;
}

/** Signatures of every error the exported interfaces declare. */
export function exportedErrorSignatures(manifest, abiDir = join(REPO_ROOT, 'packages', 'contracts', 'src', 'abis')) {
  const out = new Set();
  for (const name of [...manifest.facets, ...(manifest.proxy ?? []), ...(manifest.standalone ?? [])]) {
    let abi;
    try {
      abi = JSON.parse(readFileSync(join(abiDir, `${name}.json`), 'utf8'));
    } catch {
      continue;
    }
    for (const e of Array.isArray(abi) ? abi : abi.abi ?? []) if (e.type === 'error') out.add(`${e.name}(${e.inputs.map(abiTypeOf).join(',')})`);
  }
  return out;
}

export function main(argv = process.argv.slice(2)) {
  let outDir = BUILD_OUT_DIR;
  let target = RAISERS_FILE;
  let build = false;
  let check = false;
  let abiDir;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out' && argv[i + 1]) outDir = argv[++i];
    else if (argv[i] === '--abi-dir' && argv[i + 1]) abiDir = argv[++i];
    else if (argv[i] === '--write' && argv[i + 1]) target = argv[++i];
    else if (argv[i] === '--build') build = true;
    else if (argv[i] === '--check') check = true;
    else {
      console.error(`error-raisers: unknown argument ${argv[i]}`);
      return 2;
    }
  }
  if (build) {
    const err = buildArtifacts();
    if (err) {
      console.error(`  ✗ ${err}`);
      return 1;
    }
  }
  let derived;
  try {
    derived = deriveFromBuild(outDir);
  } catch (e) {
    console.error(`  ✗ cannot read ${relative(process.cwd(), outDir)}: ${e.message} — pass --build, or --out with an AST build`);
    return 1;
  }
  if (!derived.ok) {
    for (const p of derived.problems) console.error(`  ✗ ${p}`);
    return 1;
  }
  const exported = exportedErrorSignatures(JSON.parse(readFileSync(FACETS_FILE, 'utf8')), abiDir);
  const declarations = Object.fromEntries(Object.entries(derived.result.declarations).filter(([, d]) => !exported.has(d.signature)));
  const text = renderRaisers(derived.result.raisers, declarations);
  const summary = `${Object.keys(derived.result.raisers).length} errors across ${derived.result.entries} entry functions`;
  if (check) {
    let committed = '';
    try {
      committed = readFileSync(target, 'utf8');
    } catch {
      /* missing reads as stale */
    }
    if (committed !== text) {
      console.error(`  ✗ ${relative(process.cwd(), target)} is stale: run node contracts/script/error-raisers.mjs, then node packages/contracts/scripts/build-error-catalogue.mjs`);
      return 1;
    }
    console.log(`  ✓ error raisers current: ${summary}`);
    return 0;
  }
  writeFileSync(target, text);
  console.log(`  ✓ error raisers: ${summary} -> ${relative(process.cwd(), target)}`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main();
}
