/**
 * Regions of the drive's source, for the source tests — cut by PARSING
 * the JavaScript, not by scanning its characters.
 *
 * WHY THIS EXISTS. `live-position-observe.mjs` runs the whole drive on
 * import, so several of its branches cannot be executed from a unit test
 * and are asserted against the source text instead (extraction is
 * tracked in #2120). Every such test needs the same thing: the region
 * under a given header, and NOTHING past its close.
 *
 * The tempting way to get one is a fixed character window —
 * `src.slice(start, start + 1600)` — and it is wrong in two directions,
 * both of which #2144 has paid for:
 *
 *   - TOO SHORT, silently. The slice stops inside the region, so a rule
 *     asserted over it is blind to the tail. `confirmTrial.test.mjs`
 *     counted the assignments that record the trial's outcome and found
 *     two, over a block that has three — the third sat 137 characters
 *     past the window. It had been asserting `toBe(2)` and calling it
 *     exact, so deleting the unguarded arm's assignment — precisely the
 *     regression the test exists to catch — would have left it green.
 *   - TOO LONG, eventually. The slice runs past the region into whatever
 *     follows, and a rule "about" it starts matching its neighbours.
 *
 * Both failure modes move with unrelated edits, which is the tell: a
 * test that fails because the file GREW teaches nothing, and trains the
 * next reader to widen the number rather than ask what it bounds.
 *
 * WHY A PARSER, AND NOT A SCANNER (#2144 round 3). The first three
 * versions of this module found region boundaries by walking characters
 * and counting brackets, and every review round found another construct
 * the walk was wrong about: brackets inside string anchors, a semicolon
 * inside a comment, a template's `${…}` holes, then a regex literal
 * whose `/;/` ends a statement early and whose unmatched `)` makes the
 * helper report no statement at all. Each fix was correct and the next
 * construct was already waiting — because "where does this construct
 * end" is the question a JavaScript grammar answers, and a hand-rolled
 * scanner is a worse implementation of it every time.
 *
 * So the boundaries come from `acorn`. Strings, template holes,
 * comments, regex literals and division all stop being special cases:
 * a node's `start` and `end` are the region, by construction. The
 * helpers below keep their old signatures — callers name an anchor in
 * the code and get the region that anchor introduces — so this is a
 * change of mechanism, not of contract.
 *
 * Extracted rather than copied. Several files need it, and a second copy
 * of a helper is how `notClipped` / `paintsText` / `shownBox` /
 * `visibleTextOf` ended up with one fixed site and one stale one
 * (#2102).
 */
import { parse } from 'acorn';
import { analyze } from 'eslint-scope';

const PARSE_OPTIONS = { ecmaVersion: 'latest', sourceType: 'module', ranges: true };

// Parsing is not free and the suites read the same few files dozens of
// times. Keyed by the source text itself, so a changed file is a
// different key and no staleness is possible.
const trees = new Map();

function astOf(src, label) {
  if (typeof src !== 'string') throw new Error(`${label} needs source text, got ${typeof src}`);
  const cached = trees.get(src);
  if (cached) return cached;
  let tree;
  // Comments are collected, not discarded. Two rules need them: a marker
  // has to BE a comment (round 5 — the token in a string excused a real
  // window), and a textual anchor must not match code quoted in prose,
  // which these suites do constantly.
  const comments = [];
  try {
    tree = parse(src, { ...PARSE_OPTIONS, onComment: comments });
  } catch (e) {
    // A region asked for out of unparseable text is not a region. Say so
    // rather than falling back to a character scan, which is the whole
    // class of failure this module stopped doing.
    throw new Error(`${label}: source does not parse as a module — ${e.message}`);
  }
  const nodes = [];
  const parents = new Map();
  walk(tree, (n, parent) => {
    nodes.push(n);
    parents.set(n, parent);
  });
  // Innermost-first for containment queries: a later start, or an equal
  // start with an earlier end, is the more specific node.
  nodes.sort((a, b) => a.start - b.start || a.end - b.end);
  // Scope analysis by the library that implements the specification
  // (#2144 round 15). `variableOf` maps each identifier USE to the
  // binding it resolves to, so no rule here has to know what a
  // declaration looks like.
  const manager = analyze(tree, { ecmaVersion: 2024, sourceType: 'module' });
  const variableOf = new Map();
  const collect = (scope) => {
    for (const ref of scope.references) {
      if (ref.resolved) variableOf.set(ref.identifier, ref.resolved);
    }
    scope.childScopes.forEach(collect);
  };
  collect(manager.globalScope);
  const built = { tree, nodes, parents, comments, manager, variableOf };
  trees.set(src, built);
  return built;
}

function walk(node, visit, parent = null) {
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit, parent);
    return;
  }
  if (typeof node.type !== 'string') return;
  visit(node, parent);
  for (const key of Object.keys(node)) {
    if (key === 'type' || key === 'start' || key === 'end' || key === 'range') continue;
    walk(node[key], visit, node);
  }
}

function anchorAt(src, anchor, label, { skipStrings = false } = {}) {
  if (typeof anchor !== 'string' || anchor === '') {
    throw new Error(`${label} needs a non-empty anchor`);
  }
  // Comments are skipped here for the same reason `between` skips them,
  // and round 8 is why it had to be BOTH: these suites quote code in
  // prose constantly, and a header matched inside a comment sent
  // `blockFrom` through to the first unrelated braced node after it. The
  // parser makes that worse rather than better — the old brace counter
  // would usually run off the end and throw, where this returns a
  // plausible, complete, wrong block.
  // Comments are always skipped. STRINGS are skipped only where the
  // caller says its anchor is CODE (round 14), and the three callers
  // differ on purpose:
  //
  //   - `blockFrom` / `statementFrom` anchor on a HEADER or a
  //     declaration. `const note = "if (target) {"` made `blockFrom`
  //     return text ending at whatever braced node followed the string.
  //   - `callContaining` anchors on a string INSIDE the call it wants —
  //     that is its whole design, since `console.log(` appears dozens of
  //     times and nothing about the opening identifies which one.
  //   - `between` anchors on a LANDMARK, and one of its landmarks is a
  //     message the drive actually prints.
  //
  // Same search, three different questions.
  const at = anchorIn(src, anchor, 0, { skipStrings });
  if (at === -1) throw new Error(`${anchor} was renamed or removed`);
  return at;
}

// A `{ … }` in the grammar, whichever form. `blockFrom`'s contract is
// "the header through the close of the brace it opens", and that brace
// may belong to a function body, a control-flow block, a class, a switch
// or an object literal — including a `= {}` default in a signature,
// which is the documented caveat those callers take `between` for.
const BRACED = new Set([
  'BlockStatement',
  'ClassBody',
  'ObjectExpression',
  'ObjectPattern',
  'StaticBlock',
  'SwitchStatement',
]);

const STATEMENT = /(?:Statement|Declaration)$/;

/**
 * The source of the block introduced by `header`, from the header
 * through the close of the first brace it opens.
 *
 * Throws rather than returning an empty string if the header is gone: a
 * rule asserted over `''`, or over a slice taken from `-1`, passes by
 * measuring nothing, which is the vacuous shape this suite has been
 * caught by four times.
 *
 * The brace is located in the parse tree, so a brace inside a string, a
 * comment, a template hole or a regex literal is not a brace — which is
 * what the character-counting version got wrong four times running.
 */
export function blockFrom(src, header) {
  const start = anchorAt(src, header, 'blockFrom', { skipStrings: true });
  const { nodes } = astOf(src, 'blockFrom');
  const brace = nodes.find((n) => BRACED.has(n.type) && n.start >= start);
  if (!brace) throw new Error(`${header} opens no block`);
  return src.slice(start, brace.end);
}

/**
 * The source of the STATEMENT introduced by `header`, from the header
 * through the end of that statement.
 *
 * For the region a declaration owns — `const x = a && b && c;` spread
 * over several lines — which is neither a brace block nor a call, and
 * which `between` can only bound by naming whatever happens to follow
 * it. That "whatever follows" is the weakness: it is a real anchor in
 * the file but it means nothing ABOUT the region, so it moves when an
 * unrelated declaration is inserted after this one, and a rule about
 * this statement silently starts reading the insertion too.
 *
 * Every fixed-length window #2144 set out to retire was over exactly
 * this shape — a multi-line initializer with no closing brace to match —
 * which is why they survived two passes of conversion: there was nothing
 * to convert them TO. This is that missing bound.
 *
 * Where the statement ENDS is the parser's answer, so a semicolon inside
 * a string, a comment, a template hole or a regex literal ends nothing,
 * and an ASI-terminated statement with no semicolon at all still has an
 * end. The hand-written version was wrong about the last two.
 */
export function statementFrom(src, header) {
  const start = anchorAt(src, header, 'statementFrom', { skipStrings: true });
  const { nodes } = astOf(src, 'statementFrom');
  const stmt = nodes.find((n) => STATEMENT.test(n.type) && n.start === start);
  if (!stmt) {
    throw new Error(`${header} does not begin a statement — check the anchor starts at one`);
  }
  return src.slice(start, stmt.end);
}

/**
 * The source BETWEEN two anchors — from `from` up to (not including) the
 * next occurrence of `to` after it.
 *
 * Purely textual, and deliberately so: it bounds a NEIGHBOURHOOD that is
 * not a grammatical unit — a declaration and the few lines that belong
 * with it — so there is no node to ask for. The anchors are the meaning.
 *
 * Throws if either anchor is gone, and if `to` does not follow `from`.
 * The empty-slice failure is the one worth naming: a rule asserted over
 * `''` passes by measuring nothing, and a `to` that only appears BEFORE
 * `from` would produce exactly that — silently, and for as long as the
 * rename survived.
 */
export function between(src, from, to) {
  // An EMPTY anchor matches at position 0 and would hand back `''` from
  // `between(src, '', anything)` — the vacuous region this helper exists
  // to refuse, produced by the helper itself. Rejected before searching.
  if (typeof from !== 'string' || from === '') throw new Error('between() needs a non-empty `from`');
  if (typeof to !== 'string' || to === '') throw new Error('between() needs a non-empty `to`');
  const start = anchorIn(src, from, 0);
  if (start === -1) throw new Error(`${from} was renamed or removed`);
  const end = anchorIn(src, to, start + from.length);
  if (end === -1) {
    throw new Error(`${to} does not follow ${from} — it was renamed, removed, or moved above it`);
  }
  return src.slice(start, end);
}

/**
 * The first occurrence of `anchor` at or after `at` that is CODE rather
 * than a mention of it in a COMMENT.
 *
 * Round 5, and it is specific to what these suites are: they quote code
 * in prose constantly, naming the declaration a rule is about, the call a
 * fix replaced, the key that was retired. A closing anchor mentioned in
 * such a comment ended the region THERE — silently, and a shortened
 * region can still satisfy the assertions over it, which is the exact
 * failure the whole #2144 family exists to refuse. `stripLineComments`
 * had already been added for the same reason on a different helper.
 *
 * STRING LITERALS ARE NOT SKIPPED, and that is not an oversight. A string
 * in the drive is code: `between(src, …, 'Unreachable, non-JSON, or timed
 * out')` anchors on a message the drive actually emits, and skipping
 * literals broke it. Comments are the vector here — they are the only
 * text in a file that is guaranteed not to be the thing a rule is about.
 *
 * Only spans the PARSER identifies are skipped, so this cannot disagree
 * with the language about what a comment is.
 */
function anchorIn(src, anchor, at, { skipStrings = false } = {}) {
  const { comments, nodes } = astOf(src, 'anchorIn');
  const skipped = [...comments.map((c) => [c.start, c.end])];
  if (skipStrings) {
    for (const n of nodes) {
      // LITERAL TEXT only (round 15). Skipping a whole `TemplateLiteral`
      // also skipped its `${…}` holes, which are executable code — a real
      // header written inside one was reported missing. And a REGEX body
      // is literal text too: `/if (target) {/` was being matched, binding
      // `blockFrom` to an unrelated brace after it.
      if (n.type === 'Literal' && typeof n.value === 'string') skipped.push([n.start, n.end]);
      else if (n.type === 'Literal' && n.regex) skipped.push([n.start, n.end]);
      else if (n.type === 'TemplateLiteral') {
        for (const q of n.quasis) skipped.push([q.start, q.end]);
      }
    }
  }
  for (let i = src.indexOf(anchor, at); i !== -1; i = src.indexOf(anchor, i + 1)) {
    if (!skipped.some(([a, b]) => i >= a && i < b)) return i;
  }
  return -1;
}

/**
 * The source of the call that CONTAINS `needle`.
 *
 * For regions whose boundary is a call rather than a block — a report
 * built as one long `console.log(...)` of concatenated template
 * literals, which is the case this was written for. The anchor is a
 * string inside the call rather than the call's own opening, because
 * `console.log(` appears dozens of times in the drive and nothing about
 * the opening identifies WHICH call is the report.
 *
 * Scoping matters more here than the tidiness of it. A rule that asks
 * "is this field read by the report?" over the whole file is answered by
 * any other reader — a later predicate consulting the same field keeps
 * it looking consumed while its report line is gone, so the evidence
 * disappears from the operator's output with every test green.
 *
 * `callee` names the call to look for and keeps its old spelling, with
 * the trailing `(` optional; it is matched against the callee's own
 * source text.
 */
export function callContaining(src, needle, callee = 'console.log(') {
  const inside = anchorAt(src, needle, 'callContaining');
  const want = callee.endsWith('(') ? callee.slice(0, -1) : callee;
  const { nodes } = astOf(src, 'callContaining');
  // Innermost first: `nodes` is sorted so more specific containers come
  // later, and the LAST match is the tightest call around the anchor.
  const calls = nodes.filter(
    (n) =>
      (n.type === 'CallExpression' || n.type === 'NewExpression') &&
      n.start <= inside &&
      n.end >= inside + needle.length &&
      src.slice(n.callee.start, n.callee.end) === want,
  );
  if (calls.length === 0) throw new Error(`${needle} is not inside a ${callee} call`);
  return src.slice(calls[calls.length - 1].start, calls[calls.length - 1].end);
}

/**
 * Every `.slice(…)` call in `src`, as `{ line, args }` — `args` being
 * the argument NODES, for a caller that needs to judge the bounds.
 *
 * The #2144 guard needs exactly this and must not obtain it by reading
 * text: a bound hidden by a comment, a regex literal or a line break is
 * a bound the guard would silently skip, which recreates the defect it
 * exists to refuse. Finding a call is this module's job, so the guard
 * asks rather than scanning — otherwise it would be narrowing source by
 * hand in order to forbid narrowing source by hand.
 */
const TRUNCATORS = new Set(['slice', 'substring', 'substr']);
// A computed method name this cannot read. Inspected rather than
// skipped: silently dropping a call is how `src[`slice`](…)` escaped.
const UNREADABLE = Symbol('unreadable method name');

export function sliceCallsIn(src) {
  const { nodes } = astOf(src, 'sliceCallsIn');
  const out = [];
  for (const n of nodes) {
    if (n.type !== 'CallExpression') continue;
    const c = n.callee;
    // `f.bind(src)(a, b)` — the receiver sits on the INNER call and the
    // bounds on the outer one, so neither filter saw it (round 15).
    if (c && c.type === 'CallExpression') {
      const inner = c.callee;
      if (
        inner &&
        inner.type === 'MemberExpression' &&
        !inner.computed &&
        inner.property.name === 'bind'
      ) {
        const method = borrowedTruncator(src, inner, 'bind');
        if (method) {
          out.push({
            method,
            line: lineOf(src, n.start),
            receiver: c.arguments[0] ? src.slice(c.arguments[0].start, c.arguments[0].end) : '',
            args: n.arguments,
            text: src.slice(n.start, n.end),
            node: n,
            receiverNode: c.arguments[0] ?? null,
          });
        }
      }
      continue;
    }
    if (!c || c.type !== 'MemberExpression') continue;
    // `String.prototype.slice.call(src, a, b)` is the same operation with
    // the receiver moved into the arguments (round 8). Recognised, and
    // the shifted receiver dropped so the bounds line up.
    const borrowed = borrowedTruncator(src, c);
    if (borrowed) {
      out.push({
        method: borrowed,
        line: lineOf(src, n.start),
        receiver: n.arguments[0] ? src.slice(n.arguments[0].start, n.arguments[0].end) : '',
        args: n.arguments.slice(1),
        text: src.slice(n.start, n.end),
        node: n,
        receiverNode: n.arguments[0] ?? null,
      });
      continue;
    }
    // A computed name may be a string, a no-substitution template, or
    // something this cannot read. The first two resolve; the third is
    // INSPECTED ANYWAY rather than skipped (round 7) — `src[`slice`](…)`
    // was dropping out of enforcement entirely, and a call nobody can
    // name is not a reason to stop looking at it.
    const name = !c.computed
      ? c.property.name
      : c.property.type === 'Literal'
        ? c.property.value
        : c.property.type === 'TemplateLiteral' && c.property.expressions.length === 0
          ? c.property.quasis.map((q) => q.value.cooked).join('')
          : UNREADABLE;
    // `substring` and `substr` truncate identically; the invariant is
    // about source REGIONS, not one spelling of the String API (round 5).
    if (name !== UNREADABLE && !TRUNCATORS.has(name)) continue;
    out.push({
      method: name,
      line: lineOf(src, n.start),
      receiver: src.slice(c.object.start, c.object.end),
      args: n.arguments,
      text: src.slice(n.start, n.end),
      // The call itself, so a caller can ask which STATEMENT it belongs
      // to. A marker keyed to nearby LINES excused a neighbour (#2144
      // round 4); keyed to the statement, it cannot.
      node: n,
      receiverNode: c.object,
    });
  }
  return out;
}

// `bind` returns the bound function rather than calling it, so
// `String.prototype.slice.bind(src)(a, b)` slipped through both filters —
// the outer call's callee is a call, the inner one's method is `bind`
// (round 15).
const BORROWERS = new Set(['call', 'apply']);

/**
 * The truncator a `.call`/`.apply`/`.bind` is borrowing, or `null`.
 *
 * `String.prototype.slice.call(src, start, start + 320)` is an ordinary
 * way to write the same truncation, and a filter keyed to direct method
 * calls omitted it entirely — the guard reporting green having never
 * looked (round 8).
 */
function borrowedTruncator(src, callee, only) {
  if (callee.computed) return null;
  const via = callee.property.name;
  if (only ? via !== only : !BORROWERS.has(via)) return null;
  const inner = callee.object;
  if (!inner || inner.type !== 'MemberExpression' || inner.computed) return null;
  return TRUNCATORS.has(inner.property.name) ? inner.property.name : null;
}

/**
 * What the name at `node` is bound to, answered by a REAL scope analyser.
 *
 * WHY A LIBRARY, AND WHY THIS IS THE SAME LESSON AS THE PARSER (#2144
 * round 15). Round 6 stopped this module lexing JavaScript by hand,
 * because every review round found another construct the scanner was
 * wrong about. Underneath that it went on doing SCOPE ANALYSIS by hand —
 * a list of scope-introducing node types, a list of declaration shapes, a
 * hoisting pass, a write search — and the same thing happened for nine
 * more rounds: pattern-bound names, `switch` cases, defaulted parameters,
 * hoisted `var`s, class declarations, named function expressions, named
 * class expressions, `var` redeclarations, exported declarations, import
 * bindings. Each fix was right and the next shape was already waiting.
 *
 * "What does this name mean here" is a question the language specifies
 * and `eslint-scope` implements. A hand-written list of declaration forms
 * is a worse implementation of it every time, and the list has no end.
 *
 * Returns, for an identifier used as a bound:
 *   - `found`    — whether it resolves to a binding in this file at all;
 *   - `init`     — the initializer of the definition that reaches it, or
 *                  `null` when there is none or it cannot be known;
 *   - `notText`  — the binding is a function, a class, or an import, so
 *                  it cannot hold source text;
 *   - `writes`   — the write references, for the ordering rule.
 */
export function bindingOf(src, node) {
  const { variableOf } = astOf(src, 'bindingOf');
  const variable = variableOf.get(node);
  if (!variable) return { found: false, init: null, notText: false, writes: [] };
  const defs = variable.defs;
  if (defs.length === 0) return { found: true, init: null, notText: false, writes: [] };
  const notText = defs.some((d) => NOT_TEXT_DEFS.has(d.type));
  // The LAST definition carrying an initializer is the one that stands:
  // `var end; var end = s.indexOf('e');` declares one binding twice, and
  // taking the first left a real landmark looking unknown (round 15).
  // Ordering against the use is the write rule's job, not this one's.
  // The LAST definition carrying an initializer is the one that stands:
  // `var end; var end = s.indexOf('e');` declares one binding twice, and
  // taking the first left a real landmark looking unknown (round 15).
  // It is trusted only if it DEFINITELY runs on the way to the use — an
  // initializer inside a branch the use is outside of leaves the name
  // undefined when that branch did not run (round 8).
  const withInit = defs.filter((d) => d.node?.init);
  // A definition that MIGHT have run and might not — one inside a branch
  // the use is outside of — poisons the binding rather than being
  // skipped: `var e = t.indexOf('e'); if (on) { var { e } = obj; }` may
  // leave `e` holding either (round 12, restated here).
  const uncertain = withInit.some(
    (d) => !alwaysRunsBefore(src, d.node, node) && !definitelyAfter(src, d.node, node),
  );
  const initialised = uncertain
    ? undefined
    : [...withInit].reverse().find((d) => alwaysRunsBefore(src, d.node, node));
  return {
    found: true,
    init: initialised ? initialised.node.init : null,
    notText,
    // A declaration's OWN initialiser counts as a write reference, and
    // it is not one for this purpose — `const at = s.indexOf(…)` would
    // otherwise report itself as reassigned. `ref.init` marks it.
    writes: variable.references
      .filter((r) => r.isWrite() && !r.init)
      .map((r) => r.identifier),
  };
}

/**
 * Whether `decl` definitely executes on the way to `use`.
 *
 * A declaration inside a branch the use sits OUTSIDE of may not have run
 * at all, which leaves the name `undefined` and the region running to the
 * end of the text (round 8, restated here now that the language's own
 * scope rules do the resolving). Crossing a conditional construct that
 * does not also contain the use is the test; everything else is ordinary
 * straight-line position.
 */
function alwaysRunsBefore(src, decl, use) {
  const { parents } = astOf(src, 'alwaysRunsBefore');
  const contains = (n) => n.start <= use.start && n.end >= use.end;
  for (let p = parents.get(decl); p; p = parents.get(p)) {
    if (CONDITIONAL.has(p.type) && !contains(p)) return false;
  }
  return decl.start < use.start;
}

/**
 * Whether `decl` definitely runs only AFTER `use`, so it cannot affect
 * it. A declaration inside anything deferred is never in this class,
 * because a function body runs whenever it is called.
 */
function definitelyAfter(src, decl, use) {
  if (decl.start < use.end) return false;
  const { parents } = astOf(src, 'definitelyAfter');
  for (let p = parents.get(decl); p; p = parents.get(p)) {
    if (DEFERRABLE.has(p.type)) return false;
  }
  return true;
}

// Constructs whose body may be skipped entirely.
const CONDITIONAL = new Set([
  'IfStatement',
  'ForStatement',
  'ForOfStatement',
  'ForInStatement',
  'WhileStatement',
  'DoWhileStatement',
  'SwitchCase',
  'TryStatement',
  'CatchClause',
  'ConditionalExpression',
  'LogicalExpression',
]);

// Definition kinds that cannot hold source text, whichever syntax
// introduced them — `function f(){}`, `class C{}`, `export class C{}`,
// `import x from …` all land here.
const NOT_TEXT_DEFS = new Set(['FunctionName', 'ClassName', 'ImportBinding']);

/**
 * The DECLARATORS `node` sits inside, innermost first — the units a
 * marker may be attached to, paired with the statement a marker would
 * sit above.
 *
 * Declarators rather than declarations, because one statement can
 * declare several names: with a marker above
 * `const label = t.slice(0, 40), region = src.slice(start, start + 320);`
 * both calls shared a `VariableDeclaration`, so one reason excused the
 * other binding (round 7). A marker excuses the declarator it names, and
 * a marked statement declaring more than one name excuses NONE of them —
 * the reason cannot say which it is about.
 *
 * Declarations rather than any statement, because an `it(...)` is a
 * statement containing every bound in its callback, so a marker above one
 * excused the lot (round 6). And the whole chain rather than the nearest,
 * because a block-bodied helper puts the call inside a `return` while the
 * marker sits on the declaration above it (round 5).
 */
export function markableStatementsOf(src, node) {
  const { parents } = astOf(src, 'markableStatementsOf');
  const out = [];
  for (let n = node; n; n = parents.get(n)) {
    if (n.type === 'FunctionDeclaration') out.push(n);
    if (n.type !== 'VariableDeclarator') continue;
    const stmt = parents.get(n);
    // One name per marked statement, or the reason is ambiguous.
    if (stmt && stmt.type === 'VariableDeclaration' && stmt.declarations.length === 1) {
      out.push(stmt);
    }
  }
  return out;
}

/**
 * Whether a COMMENT carrying `marker` is attached to `stmt` — on its own
 * line above it, with no code in between.
 *
 * Two corrections live here. The marker must BE a comment the parser
 * identifies (round 5), since testing raw line text let
 * `const reason = 'not-a-source-region', bad = src.slice(start, start + 320);`
 * excuse itself with a string. And nothing may precede it ON ITS OWN LINE
 * (round 6): a trailing comment on an unrelated statement has only
 * whitespace between it and whatever follows, so it was attaching to the
 * next declaration and excusing a window it says nothing about.
 */
/**
 * Whether a comment's text IS the marker directive — the token at the
 * start, a colon, and a non-empty reason after it.
 *
 * A substring match accepted `// not-a-source-region` with nothing said,
 * and `// never add not-a-source-region here`, which means the opposite
 * (round 7). The marker asserts "this really does count characters, and
 * here is what it counts"; a mention of the token is not that assertion,
 * and an assertion with no reason is not one either.
 */
function isDirective(text, marker) {
  const t = text.trim();
  if (!t.startsWith(`${marker}:`)) return false;
  return t.slice(marker.length + 1).trim() !== '';
}

export function markedStatement(src, stmt, marker) {
  const { comments } = astOf(src, 'markedStatement');
  return comments.some((c) => {
    if (c.end > stmt.start || !isDirective(c.value, marker)) return false;
    if (src.slice(c.end, stmt.start).trim() !== '') return false;
    const lineStart = src.lastIndexOf('\n', c.start - 1) + 1;
    return src.slice(lineStart, c.start).trim() === '';
  });
}

// Constructs whose body may run at a time position cannot express — a
// loop repeats, a function runs whenever it is called. A write inside one
// is treated as reaching any use, which refuses rather than certifies.
const DEFERRABLE = new Set([
  // A class FIELD initializer runs at construction, not where it is
  // written (round 15), so a write below the class can execute first.
  'PropertyDefinition',
  'ForStatement',
  'ForOfStatement',
  'ForInStatement',
  'WhileStatement',
  'DoWhileStatement',
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
]);

/**
 * Whether a write to `variable` could reach the use at `useAt`.
 *
 * Position means something only when BOTH ends sit in straight-line code
 * (round 14). A write inside a function or a loop runs at a time position
 * cannot express, and so does a USE inside one — a region taken inside a
 * function runs whenever it is called, so a write below it may execute
 * first. Unknown order refuses rather than certifies.
 */
function writeReaches(src, writes, useAt) {
  if (writes.length === 0) return false;
  const { nodes, parents } = astOf(src, 'writeReaches');
  const deferred = (n) => {
    for (let p = n; p; p = parents.get(p)) if (DEFERRABLE.has(p.type)) return true;
    return false;
  };
  let useNode = null;
  for (const n of nodes) if (n.start <= useAt && n.end >= useAt) useNode = n;
  if (useNode && deferred(useNode)) return true;
  return writes.some((w) => w.start < useAt || deferred(w));
}


/** Every identifier a write reaches, through patterns and defaults. */
function writtenNames(target) {
  const out = new Set();
  const visit = (n) => {
    if (!n || typeof n.type !== 'string') return;
    switch (n.type) {
      case 'Identifier':
        out.add(n.name);
        return;
      case 'ArrayPattern':
        n.elements.forEach(visit);
        return;
      case 'ObjectPattern':
        n.properties.forEach((p) => visit(p.type === 'RestElement' ? p.argument : p.value));
        return;
      case 'AssignmentPattern':
        visit(n.left);
        return;
      case 'RestElement':
        visit(n.argument);
        return;
      case 'VariableDeclaration':
        n.declarations.forEach((d) => visit(d.id));
        return;
      default:
    }
  };
  visit(target);
  return out;
}

// The calls that FIND something in text. A bound produced by one of
// these is a POSITION: it moves with the code, which is the property
// #2144 is about.
const FINDERS = new Set(['indexOf', 'lastIndexOf', 'search']);

/**
 * What a bound expression DENOTES, or `null` when nothing recognisable:
 *
 *   - `'position'` — a place in the text. The only thing a region bound
 *     may be.
 *   - `'offset'` — a DISTANCE. Valid inside a bound and never as one.
 *
 * WHY THE DISTINCTION EXISTS (round 7). An earlier version called any
 * sum or difference of two landmarks a landmark, and
 * `src.indexOf('end') - src.indexOf('begin')` is not one — it is the
 * WIDTH between two places, and using a width as an end is the fixed
 * window again with the number computed instead of typed. The same
 * confusion let a bare `.length` stand as a bound, which measures
 * something and points at nothing.
 *
 * So positions and distances are kept apart, and the arithmetic says
 * which combinations mean anything:
 *
 *   position + offset → position     "just past the landmark"
 *   position − offset → position     "just before it"
 *   position − position → offset     a width; NOT a bound
 *   offset ± offset → offset
 *   position + position → nothing    two places do not add
 *
 * WHY THE WHOLE RULE IS THIS WAY ROUND (round 6). The classifier before
 * it asked "can a number be reached in this bound?", and every review
 * answered with another way to write one: a quoted number, a named
 * constant, an alias, arithmetic, a defaulted parameter, a switch-case
 * binding, a template, an immediately-invoked function, a late
 * assignment, a default nested in a destructuring pattern. "Every way to
 * write a number in JavaScript" is an open set, and a guard whose
 * correctness depends on having enumerated an open set is wrong and does
 * not know it. What a LANDMARK looks like is closed and small — it is
 * what this suite actually writes — so that is what is enumerated, and
 * everything unrecognised is a character count that must say what it
 * counts. A new evasion cannot be invented, because unrecognised is
 * refused.
 *
 * Over-flagging is the cost to watch, and is treated as seriously as a
 * gap: the answer to a legitimate shape this does not know is to ADD THE
 * SHAPE, never to mark the code. A marker asserts "this really does
 * count characters", and putting one on a correct landmark is a lie the
 * next reader inherits.
 */
export function kindOf(src, node, seen = new Set()) {
  if (!node || typeof node.type !== 'string') return null;
  switch (node.type) {
    case 'CallExpression':
      return callKind(src, node, seen);

    case 'Identifier': {
      const key = `${node.name}@${node.start}`;
      if (seen.has(key)) return null;
      seen.add(key);
      const bound = bindingOf(src, node);
      if (!bound.found || !bound.init || bound.notText) return null;
      // A name that is WRITTEN TO after it is declared cannot be trusted
      // to still hold what it was declared with (round 7):
      // `let end = s.indexOf('x'); end = start + 320;` had the window
      // inheriting the declaration's classification.
      if (writeReaches(src, bound.writes, node.start)) return null;
      return kindOf(src, bound.init, seen);
    }

    case 'MemberExpression': {
      // A MEASURED length — `needle.length` — which is why
      // `s.indexOf(x) + x.length` is a position while `+ 320` is not.
      // Only off a plain NAME: `({ length: start + 320 }).length` is a
      // number wearing the spelling (round 7).
      if (!node.computed && node.property.name === 'length') {
        return measurable(node.object) ? 'offset' : null;
      }
      // SELECTING A LANDMARK OUT OF A COLLECTION IS NO LONGER RECOGNISED,
      // and that is a deliberate retreat rather than an omission. It was
      // added in round 6 to avoid over-flagging `anchors[0]` — a shape
      // that appears NOWHERE in this suite. Keeping it honest then cost
      // rounds 9, 10 and 11: the index had to be proved canonical and in
      // range, the collection unmutated, the mutation reachable, the
      // mutator name resolved through computed spellings, and the
      // collection followed through aliases. The holes left after all
      // that need escape analysis and a call graph — precisely the
      // analyses this module has four times refused to build, for being
      // unbounded and for certifying confidently from partial
      // information.
      //
      // A capability with no user, whose correctness needs machinery that
      // has been declined on principle, is not worth the surface it
      // presents. Unrecognised is refused, as everywhere else. If a real
      // selection appears one day, recognise it THEN, with its own case
      // and its own reasoning — and never by marking the code.
      return null;
    }

    case 'BinaryExpression': {
      if (node.operator !== '+' && node.operator !== '-') return null;
      const l = kindOf(src, node.left, seen);
      const r = kindOf(src, node.right, seen);
      if (l === 'position' && r === 'offset') return 'position';
      if (node.operator === '+' && l === 'offset' && r === 'position') return 'position';
      if (node.operator === '-' && l === 'position' && r === 'position') return 'offset';
      if (l === 'offset' && r === 'offset') return 'offset';
      return null;
    }

    case 'ConditionalExpression': {
      const a = kindOf(src, node.consequent, seen);
      return a !== null && a === kindOf(src, node.alternate, seen) ? a : null;
    }

    case 'LogicalExpression': {
      const a = kindOf(src, node.left, seen);
      return a !== null && a === kindOf(src, node.right, seen) ? a : null;
    }

    case 'ParenthesizedExpression':
      return kindOf(src, node.expression, seen);

    default:
      return null;
  }
}

/**
 * Whether `node` is text that is ALREADY a bounded region — a call to one
 * of the structural helpers here, or a name holding one.
 *
 * This is what makes a one-argument slice honest. `s.slice(at(x))` on raw
 * file text runs to the end of the file, and a rule over it can be
 * satisfied by matching text anywhere later — the too-long half of the
 * defect (round 7). But `block.slice(…)` where `block` came from
 * `blockFrom` ends at the end of `block`, which was bounded by meaning
 * when it was taken. Same spelling, different region.
 */
export function isBoundedRegion(src, node, seen = new Set()) {
  if (!node || typeof node.type !== 'string') return false;
  if (node.type === 'CallExpression') {
    // Spelled like a structural helper AND not shadowed. A parameter or
    // local named `blockFrom` may return anything at all, including the
    // raw file, and trusting the spelling let a one-argument slice run to
    // the end of it again (round 8). No local binding means the import.
    if (
      node.callee.type === 'Identifier' &&
      REGION_HELPERS.has(node.callee.name) &&
      importedFromThisModule(src, node.callee)
    ) {
      return true;
    }
    // A local helper that returns one — `const branch = () => blockFrom(…)`
    // in `confirmTrial`. Expression bodies only, for the reason
    // `helperKind` gives: a block body needs to prove every path returns,
    // and a path that returns nothing hands back the whole file.
    if (node.callee.type !== 'Identifier') return false;
    const key = `regionFn:${node.callee.name}@${node.callee.start}`;
    if (seen.has(key)) return false;
    seen.add(key);
    const fn = bindingOf(src, node.callee);
    return fn.found &&
      !writeReaches(src, fn.writes, node.callee.start) &&
      fn.init &&
      fn.init.type === 'ArrowFunctionExpression' &&
      fn.init.body.type !== 'BlockStatement'
      ? isBoundedRegion(src, fn.init.body, seen)
      : false;
  }
  if (node.type !== 'Identifier') return false;
  const key = `region:${node.name}@${node.start}`;
  if (seen.has(key)) return false;
  seen.add(key);
  const bound = bindingOf(src, node);
  return bound.found && !writeReaches(src, bound.writes, node.start) && bound.init
    ? isBoundedRegion(src, bound.init, seen)
    : false;
}

const REGION_HELPERS = new Set(['blockFrom', 'between', 'statementFrom', 'callContaining']);

/**
 * Whether `node` names a helper IMPORTED FROM THIS MODULE.
 *
 * Round 15: trusting "no binding found" as proof of the canonical import
 * was only ever true while imports were invisible to the resolver. With
 * real scope analysis they are visible, so the question can be asked
 * properly — `import { raw as blockFrom } from './fixture.mjs'` resolves
 * to an import from somewhere else and is refused, and a local of the
 * same name is refused too.
 */
function importedFromThisModule(src, node) {
  if (node.type !== 'Identifier') return false;
  const { variableOf } = astOf(src, 'importedFromThisModule');
  const variable = variableOf.get(node);
  if (!variable) return false;
  return variable.defs.some(
    (d) =>
      d.type === 'ImportBinding' &&
      typeof d.parent?.source?.value === 'string' &&
      d.parent.source.value.endsWith('sourceBlock.mjs'),
  );
}

/** Whether `node` is a bound that may end a source region. */
export function isAnchored(src, node, seen = new Set()) {
  return kindOf(src, node, seen) === 'position';
}

function callKind(src, node, seen) {
  const callee = node.callee;
  // `s.indexOf('x')`. Its ARGUMENTS are not inspected: a number in one
  // selects or offsets the search, and the result is still wherever the
  // text was found.
  //
  // The RECEIVER is checked, because the property name alone proves
  // nothing — `({ indexOf: () => start + 320 }).indexOf()` is a fixed
  // window spelled like a search (round 7). A plain name is required.
  // The honest limit: a name holding an ARRAY has an `indexOf` too, and
  // this does not tell the two apart.
  if (
    callee.type === 'MemberExpression' &&
    FINDERS.has(propertyName(callee)) &&
    isPlainName(callee.object) &&
    !suspectReceiver(src, callee.object, seen)
  ) {
    return 'position';
  }
  return helperKind(src, callee, seen);
}

/**
 * The kind a locally-declared helper returns — EXPRESSION-BODIED arrows
 * only, which is a deliberate refusal rather than an omission.
 *
 * A block body needs "does every reachable path return a landmark?",
 * which is control-flow analysis, and round 7 showed the shallow version
 * failing on `() => { if (enabled) return s.indexOf('next'); }`: the one
 * explicit return is a landmark, the other path returns `undefined`, and
 * the region runs to the end of the file — the too-long half of the
 * defect, restored by the guard meant to refuse it. An expression body
 * has exactly one result and needs no analysis at all.
 *
 * This is what `at(needle)` and `trialCall()` in this suite already are.
 * A helper written with a block is reported, and the fix is to make it an
 * expression or to bound the region with one of the structural helpers —
 * never to mark it.
 */
function helperKind(src, callee, seen) {
  if (callee.type !== 'Identifier') return null;
  const key = `fn:${callee.name}@${callee.start}`;
  if (seen.has(key)) return null;
  seen.add(key);
  const bound = bindingOf(src, callee);
  if (!bound.found || writeReaches(src, bound.writes, callee.start)) return null;
  const fn = bound.init;
  if (!fn || fn.type !== 'ArrowFunctionExpression' || fn.body.type === 'BlockStatement') return null;
  return kindOf(src, fn.body, seen);
}

/**
 * Whether `node` is a receiver whose `indexOf` cannot be trusted to
 * search source text — one that resolves to an object or array written
 * out in this file, or one that is REASSIGNED.
 *
 * Round 11 on the second half: following only the initial value let
 * `let receiver = source; receiver = { indexOf: () => start + 320 };`
 * certify a fixed number as a position. A name that is written to holds
 * something unknown, which is the same rule bounds already follow.
 *
 * Round 10: `const fake = { indexOf: () => start + 320 }; s.slice(start,
 * fake.indexOf())` passed because `fake` is a plain name. Requiring a
 * plain name says something about the SPELLING; this says something
 * about the value. A receiver that resolves to neither — an import, a
 * parameter, a call result — is still accepted, which is the stated
 * interprocedural limit and not a new one.
 */
const NOT_TEXT = new Set([
  'ObjectExpression',
  'ArrayExpression',
  'ArrowFunctionExpression',
  'FunctionExpression',
  'ClassExpression',
]);

function suspectReceiver(src, node, seen) {
  if (!node || node.type !== 'Identifier') return false;
  const key = `recv:${node.name}@${node.start}`;
  if (seen.has(key)) return false;
  seen.add(key);
  const bound = bindingOf(src, node);
  if (!bound.found) return false;
  if (bound.notText || writeReaches(src, bound.writes, node.start)) return true;
  if (!bound.init) return false;
  const t = bound.init.type;
  // A function or a class is not text either, and a property can be
  // hung on one: `const fake = () => {}; fake.indexOf = () => start + 320`
  // read as a search until round 13.
  if (NOT_TEXT.has(t)) return true;
  return t === 'Identifier' ? suspectReceiver(src, bound.init, seen) : false;
}

/**
 * Something whose `.length` is a real measurement: a name, or a string
 * written out. `'x'.length` is the width of the landmark `'x'`, which is
 * how "just past it" is written. `({ length: start + 320 }).length` is a
 * number wearing the spelling and is refused (round 7).
 */
function measurable(node) {
  if (!node) return false;
  if (node.type === 'Literal' && typeof node.value === 'string') return true;
  if (node.type === 'TemplateLiteral') return true;
  return isPlainName(node);
}

/**
 * A member's property name, read through a computed spelling where that
 * is possible: `s['indexOf']` and ``s[`indexOf`]`` are the same call as
 * `s.indexOf`, and refusing them reported a correctly anchored region
 * and asked for a marker claiming a count that was not happening
 * (round 11). `sliceCallsIn` already read truncator names this way.
 */
function propertyName(member) {
  if (!member.computed) return member.property.name;
  const k = member.property;
  if (k.type === 'Literal' && typeof k.value === 'string') return k.value;
  if (k.type === 'TemplateLiteral' && k.expressions.length === 0) {
    return k.quasis[0].value.cooked;
  }
  return null;
}

/**
 * A BARE name — `src`, `block`, `mod`.
 *
 * A dotted chain is refused (round 12). `isPlainName` used to admit one,
 * and `fake.nested['indexOf']()` then read as a search because the
 * receiver check only resolves an identifier and waved a member
 * expression through. Proving what `fake.nested` holds means following
 * property writes, which is the analysis declined everywhere else here.
 * Every receiver this suite actually searches is a bare name, so refusing
 * a chain costs nothing and the alternative could not be made sound.
 */
function isPlainName(node) {
  return Boolean(node) && node.type === 'Identifier';
}

/** The 1-based line `index` falls on. */
function lineOf(src, index) {
  let n = 1;
  for (let i = 0; i < index; i += 1) if (src[i] === '\n') n += 1;
  return n;
}

/**
 * The same text with whole-line comments dropped.
 *
 * A source guard reads code, and the drive's comments QUOTE code — retired
 * report keys, the call a fix replaced — so a rule asserted over the raw
 * slice matches prose. This was found twice: the distinct-key guard
 * reported four keys the run never prints, and the malformed-envelope
 * guard found the strict reader "still called" in the sentence explaining
 * why it no longer is.
 *
 * Whole lines only. A `//` inside a string is text (a URL, say), and
 * truncating its line would shorten the very code being checked.
 */
export function stripLineComments(source) {
  return source
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('//'))
    .join('\n');
}
