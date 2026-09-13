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
  const built = { tree, nodes, parents, comments };
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

function anchorAt(src, anchor, label) {
  if (typeof anchor !== 'string' || anchor === '') {
    throw new Error(`${label} needs a non-empty anchor`);
  }
  const at = src.indexOf(anchor);
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
  const start = anchorAt(src, header, 'blockFrom');
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
  const start = anchorAt(src, header, 'statementFrom');
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
function anchorIn(src, anchor, at) {
  const { comments } = astOf(src, 'between');
  for (let i = src.indexOf(anchor, at); i !== -1; i = src.indexOf(anchor, i + 1)) {
    if (!comments.some((c) => i >= c.start && i < c.end)) return i;
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
    if (!c || c.type !== 'MemberExpression') continue;
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
    });
  }
  return out;
}

// Nodes that introduce a binding scope.
const SCOPES = new Set([
  'Program',
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
  'BlockStatement',
  'StaticBlock',
  'ForStatement',
  'ForOfStatement',
  'ForInStatement',
  'CatchClause',
  // A `switch` body is ONE block in the grammar, and a `const` written
  // directly in a case belongs to it (round 5).
  'SwitchStatement',
]);

// `var` hoists to the nearest FUNCTION (or the module), not to the block
// it is written in. Round 4 corrected a claim made here that block-scoping
// it could only over-find: a `var` in an inner block, used after that
// block, resolves at function scope, and a resolver that never looks
// inside the block returns nothing and lets a real fixed window through.
const FUNCTIONS = new Set([
  'Program',
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
  'StaticBlock',
]);

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

/**
 * The initializer bound to `name` where `at` stands: `{ found, init }`.
 *
 * Scope-aware ON PURPOSE, and the reason is a false positive that a
 * file-wide name table produced on the first attempt: `headSampling`
 * binds `i` to an `indexOf` result in one test and, elsewhere in the same
 * file, to `0` as a loop counter. A flat table saw a number and flagged a
 * perfectly anchored slice. A guard that cries wolf on correct code is
 * worse than one gap, because the fix people learn is to silence it.
 *
 * Resolution stops at the nearest enclosing scope that declares the name,
 * which is what the language does — with `var` collected at the function
 * it hoists to rather than the block it is written in.
 */
export function bindingAt(src, name, at) {
  const { nodes, parents } = astOf(src, 'bindingAt');
  let node = null;
  for (const n of nodes) if (n.start <= at && n.end >= at) node = n;
  for (let scope = node; scope; scope = parents.get(scope)) {
    if (!SCOPES.has(scope.type)) continue;
    for (const decl of declarationsDirectlyIn(scope)) {
      if (decl.name === name) {
        return { found: true, init: decl.init, reassigned: assignsTo(src, scope, name) };
      }
    }
    if (FUNCTIONS.has(scope.type)) {
      for (const decl of hoistedVarsIn(scope)) {
        if (decl.name === name) {
          return { found: true, init: decl.init, reassigned: assignsTo(src, scope, name) };
        }
      }
    }
  }
  return { found: false, init: null, reassigned: false };
}

/**
 * Whether `name` is WRITTEN TO anywhere inside `scope` — assigned, or
 * stepped by `++`/`--`.
 *
 * A declaration's initializer only says what a name held at the start.
 * Round 7: `let end = s.indexOf('next'); end = start + 320;` had the
 * window inheriting a classification the name no longer deserved.
 * Deciding WHICH write reaches a given use is reaching-definitions
 * analysis, whose every gap is another round of this — so any write at
 * all makes the name unusable as a landmark, and the fix in code is a
 * `const` holding the landmark rather than a marker.
 */
function assignsTo(src, scope, name) {
  const { nodes, parents } = astOf(src, 'assignsTo');
  return nodes.some((n) => {
    const target =
      n.type === 'AssignmentExpression'
        ? n.left
        : n.type === 'UpdateExpression'
          ? n.argument
          : null;
    if (!target || target.type !== 'Identifier' || target.name !== name) return false;
    for (let p = n; p; p = parents.get(p)) if (p === scope) return true;
    return false;
  });
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
 *   - `'positions'` — a collection of places, valid only as the thing a
 *     selection reads from.
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
      const bound = bindingAt(src, node.name, node.start);
      if (!bound.found || !bound.init) return null;
      // A name that is WRITTEN TO after it is declared cannot be trusted
      // to still hold what it was declared with (round 7):
      // `let end = s.indexOf('x'); end = start + 320;` had the window
      // inheriting the declaration's classification.
      if (bound.reassigned) return null;
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
      // Selecting from a collection of landmarks. The KEY is never
      // inspected — it selects rather than contributes — so a numeric
      // index does not make the bound a count.
      return kindOf(src, node.object, seen) === 'positions' ? 'position' : null;
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

    // A collection is NOT a bound — `s.slice(start, [a, b])` coerces to
    // a comma-joined string and then to NaN (round 7). It is only ever
    // the thing a selection reads from.
    case 'ArrayExpression':
      return node.elements.length > 0 &&
        node.elements.every((e) => kindOf(src, e, seen) === 'position')
        ? 'positions'
        : null;

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
    if (node.callee.type === 'Identifier' && REGION_HELPERS.has(node.callee.name)) return true;
    // A local helper that returns one — `const branch = () => blockFrom(…)`
    // in `confirmTrial`. Expression bodies only, for the reason
    // `helperKind` gives: a block body needs to prove every path returns,
    // and a path that returns nothing hands back the whole file.
    if (node.callee.type !== 'Identifier') return false;
    const key = `regionFn:${node.callee.name}@${node.callee.start}`;
    if (seen.has(key)) return false;
    seen.add(key);
    const fn = bindingAt(src, node.callee.name, node.callee.start);
    return fn.found &&
      !fn.reassigned &&
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
  const bound = bindingAt(src, node.name, node.start);
  return bound.found && !bound.reassigned && bound.init
    ? isBoundedRegion(src, bound.init, seen)
    : false;
}

const REGION_HELPERS = new Set(['blockFrom', 'between', 'statementFrom', 'callContaining']);

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
    !callee.computed &&
    FINDERS.has(callee.property.name) &&
    isPlainName(callee.object)
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
  const bound = bindingAt(src, callee.name, callee.start);
  if (!bound.found || bound.reassigned) return null;
  const fn = bound.init;
  if (!fn || fn.type !== 'ArrowFunctionExpression' || fn.body.type === 'BlockStatement') return null;
  return kindOf(src, fn.body, seen);
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

/** An identifier, or a dotted chain of them — `src`, `page.body`. */
function isPlainName(node) {
  if (!node) return false;
  if (node.type === 'Identifier' || node.type === 'ThisExpression') return true;
  return node.type === 'MemberExpression' && !node.computed && isPlainName(node.object);
}

function declarationsDirectlyIn(scope) {
  const out = [];
  const add = (id, init) => {
    if (id && id.type === 'Identifier') out.push({ name: id.name, init: init ?? null });
  };
  // A DEFAULTED parameter is an AssignmentPattern, and its right-hand
  // side is a binding like any other — `function f(WINDOW = 320)` was
  // invisible until round 5.
  for (const p of scope.params ?? []) {
    if (p && p.type === 'AssignmentPattern') add(p.left, p.right);
    else add(p, null);
  }
  if (scope.type === 'CatchClause') add(scope.param, null);
  const statements =
    scope.type === 'Program' || scope.type === 'BlockStatement' || scope.type === 'StaticBlock'
      ? (scope.body ?? [])
      : scope.type === 'SwitchStatement'
        ? (scope.cases ?? []).flatMap((c) => c.consequent ?? [])
        : scope.type === 'ForStatement' ||
            scope.type === 'ForOfStatement' ||
            scope.type === 'ForInStatement'
          ? [scope.init ?? scope.left].filter(Boolean)
          : [];
  for (const s of statements) {
    if (s.type === 'VariableDeclaration') {
      for (const d of s.declarations) add(d.id, d.init);
    } else if (s.type === 'FunctionDeclaration') {
      add(s.id, null);
    }
  }
  return out;
}

/** Every `var` declared under `fn`, not crossing into a nested function. */
function hoistedVarsIn(fn) {
  const out = [];
  const descend = (n, top) => {
    if (n === null || typeof n !== 'object') return;
    if (Array.isArray(n)) {
      for (const c of n) descend(c, top);
      return;
    }
    if (typeof n.type !== 'string') return;
    if (!top && FUNCTIONS.has(n.type)) return;
    if (n.type === 'VariableDeclaration' && n.kind === 'var') {
      for (const d of n.declarations) {
        if (d.id && d.id.type === 'Identifier') out.push({ name: d.id.name, init: d.init ?? null });
      }
    }
    for (const k of Object.keys(n)) {
      if (k === 'type' || k === 'start' || k === 'end' || k === 'range') continue;
      descend(n[k], false);
    }
  };
  descend(fn, true);
  return out;
}

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
