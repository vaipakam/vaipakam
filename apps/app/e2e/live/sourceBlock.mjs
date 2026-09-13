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
  // The brace must belong to the construct the header INTRODUCES (round
  // 19). `blockFrom('const anchor = 1; if (ready) { … }', 'const anchor
  // = 1;')` took the `if` body — a plausible, complete, unrelated region.
  // The failure it hides is the one this module exists to refuse: refactor
  // a guarded construct to drop its block while a neighbour keeps one, and
  // the assertions carry on over the neighbour instead of going red.
  // CONTAINING, not "first at or after" (round 20). An anchor that begins
  // part-way into a statement — `'anchor = 1'` inside `const anchor = 1;`
  // — leaves that statement starting BEFORE the anchor, so a search
  // forward skipped it and took the later `if` as the owner: the same
  // unrelated block, reached by naming the header slightly differently.
  const owner = [...nodes]
    .reverse()
    .find((n) => STATEMENT.test(n.type) && n.start <= start && n.end >= start);
  if (owner && (brace.start < owner.start || brace.end > owner.end)) {
    throw new Error(`${header} opens no block of its own`);
  }
  // …and the construct must actually HAVE a braced body (round 28).
  // `if (ready) consume({ marker: true });` has none, so the first
  // braced node after the header is the argument's object literal —
  // inside the owner, so the containment check passed, and the helper
  // handed back a plausible partial region instead of saying the header
  // opens nothing.
  if (owner && unbracedBody(owner, start)) {
    throw new Error(`${header} opens no block of its own`);
  }
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
  // An anchor must not STRADDLE the edge of skipped text (round 21).
  // Testing only its first character let ` 'if (target) {` match: the
  // leading space sits outside the string literal that follows, so the
  // match began in code and ran on into quoted text, and `blockFrom`
  // then took an unrelated later block.
  //
  // Straddling, not overlapping. An anchor that CONTAINS a skipped span
  // whole is ordinary code — `page.on('request', (req) => {` is a real
  // anchor in these suites and quotes a string in passing. Only a match
  // whose own start or end falls strictly inside a skipped span has
  // crossed a boundary it should not have.
  for (let i = src.indexOf(anchor, at); i !== -1; i = src.indexOf(anchor, i + 1)) {
    const end = i + anchor.length;
    // Overlap that is NOT containment. Round 22: testing the start with
    // `i >= a` rejected an anchor beginning exactly at a literal's first
    // character — `'x' && (() => {` contains the whole literal and
    // continues into code, which is the contains case, not the straddle.
    const straddles = skipped.some(
      ([a, b]) => i < b && end > a && !(i <= a && end >= b),
    );
    // …and it must contain SOME CODE. Round 23: the containment rule
    // above happily accepted a match that IS a comment — `// if (target)
    // {` — which walked `blockFrom` on to an unrelated later block, the
    // very behaviour `anchorAt` says is always skipped. Containing a
    // skipped span is fine; consisting of one is not.
    // WHITESPACE IS NOT CODE (round 24). A leading space lies outside
    // acorn's comment span, so ` // if (target) {` satisfied a
    // "contains some unskipped character" test and took the unrelated
    // later block — the same wrong region, one space further on.
    const hasCode = [...Array(end - i).keys()].some(
      (k) =>
        !/\s/.test(src[i + k]) && !skipped.some(([a, b]) => i + k >= a && i + k < b),
    );
    if (!straddles && hasCode) return i;
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
  // An EMPTY needle identifies nothing, and round 29's every-occurrence
  // loop cannot even end on one: the empty string is found at every
  // index and then clamps to the end of the text, so the loop receives
  // the same position forever and hangs the process. `anchorAt` has
  // rejected empty anchors since it was written; going direct to
  // `anchorIn` left this caller without that guard (round 30).
  if (typeof needle !== 'string' || needle === '') {
    throw new Error('callContaining needs a non-empty needle');
  }
  const want = callee.endsWith('(') ? callee.slice(0, -1) : callee;
  const { nodes } = astOf(src, 'callContaining');
  // EVERY occurrence of the needle, not just the first (round 29). The
  // needle identifies WHICH call is wanted, so an earlier copy of the
  // same text elsewhere — in another string, in another call — is not a
  // reason to report that no call contains it.
  let seen = 0;
  for (let inside = anchorIn(src, needle, 0); inside !== -1; inside = anchorIn(src, needle, inside + 1)) {
    seen++;
    // Innermost first: `nodes` is sorted so more specific containers come
    // later, and the LAST match is the tightest call around the anchor.
    const calls = nodes.filter(
      (n) =>
        (n.type === 'CallExpression' || n.type === 'NewExpression') &&
        n.start <= inside &&
        n.end >= inside + needle.length &&
        src.slice(n.callee.start, n.callee.end) === want,
    );
    if (calls.length > 0) return src.slice(calls.at(-1).start, calls.at(-1).end);
  }
  if (seen === 0) throw new Error(`${needle} was renamed or removed`);
  throw new Error(`${needle} is not inside a ${callee} call`);
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

/**
 * The truncator a TAG denotes, with the receiver it narrows, or null.
 *
 * A tag is a callee, so it takes the same forms one does: a plain
 * member, a `bind` call, or a name holding either. One reader for all of
 * them, so the tagged form cannot fall behind the called form again.
 */
function taggedTruncator(src, tag) {
  if (!tag) return null;
  if (tag.type === 'MemberExpression') {
    // Through the VALUE-AWARE reader, not the property name (round 36).
    // `box.cut = String.prototype.slice; box.cut`320`` installs a real
    // narrowing behind a name that says nothing, and reading the name
    // alone dropped it — the same mistake the borrowed-call path had
    // made and had already been corrected for. Same reader, both paths.
    const method = memberTruncator(src, tag);
    if (!method) return null;
    return { method, receiverNode: tag.object };
  }
  // A NAME tag goes through the same every-value resolution an ordinary
  // callee does (round 38). It went through the alias resolver instead,
  // which refuses a reassigned name — so `let cut; cut = s.slice.bind(s);
  // cut\`320\`` was dropped, combining two forms each of which was
  // already handled on its own. Two paths asking one question again.
  if (tag.type === 'Identifier') {
    const held = boundTruncatorValues(src, tag);
    return held ? { method: held.method, receiverNode: held.call.arguments[0] ?? null } : null;
  }
  if (tag.type !== 'CallExpression') return null;
  const inner = unwrapChain(tag.callee);
  if (!inner || inner.type !== 'MemberExpression' || memberName(inner) !== 'bind') return null;
  const method = borrowedTruncator(src, inner, 'bind');
  return method ? { method, receiverNode: tag.arguments[0] ?? null } : null;
}

/**
 * A bound truncator among EVERY value a name is given — its declaration
 * and every later assignment — or null.
 *
 * `certain` says whether that was the only candidate. With one, the
 * preset bounds are knowable and are read; with several, the call is
 * still reported but its bounds are not claimed.
 */
function boundTruncatorValues(src, node) {
  const { variableOf, parents } = astOf(src, 'boundTruncatorValues');
  const variable = variableOf.get(node);
  if (!variable) return null;
  const values = [];
  for (const def of variable.defs) if (def.node?.init) values.push(def.node.init);
  for (const ref of variable.references) {
    if (!ref.isWrite() || ref.init) continue;
    const p = parents.get(ref.identifier);
    if (p?.type === 'AssignmentExpression' && p.left === ref.identifier) values.push(p.right);
  }
  const bound = values
    // A candidate may itself be a NAME holding the bound function
    // (round 38): `const cut = src.slice.bind(src); const alias = cut;`
    // put one more hop between the bind and the call, and unwrapping
    // without resolving discarded it for not being a call.
    .map((v) => {
      const u = unwrapChain(v);
      return u?.type === 'Identifier' ? unwrapChain(resolveAlias(src, u)) : u;
    })
    .filter((v) => v?.type === 'CallExpression')
    .map((call) => {
      const inner = unwrapChain(call.callee);
      if (!inner || inner.type !== 'MemberExpression' || memberName(inner) !== 'bind') return null;
      const method = borrowedTruncator(src, inner, 'bind');
      return method ? { method, call } : null;
    })
    .filter(Boolean);
  if (bound.length === 0) return null;
  return { ...bound[0], certain: values.length === 1 };
}

export function sliceCallsIn(src) {
  const { nodes } = astOf(src, 'sliceCallsIn');
  const out = [];
  for (const n of nodes) {
    // A truncator invoked as a TAG (round 34). `src.slice`320`` is a
    // call: the template's cooked parts arrive as an array, which the
    // truncator coerces to a number, so this is a one-argument slice
    // from a fixed offset to the end of the text — the exact window this
    // guard exists to refuse, written in a form the node-type filter
    // below never looked at. The bounds are a coercion rather than a
    // landmark, so they are reported as unreadable rather than
    // interpreted.
    if (n.type === 'TaggedTemplateExpression') {
      const tag = unwrapChain(n.tag);
      // The tag may be any of the shapes a CALLEE may be, because it IS
      // a callee (round 35). Restricting it to a direct member let
      // `src.slice.bind(src)`320`` through — the bind was not a tag this
      // looked at, and the tagged call was not a call the filter below
      // looked at, so the window left between the two forms the same way
      // it left between the two statements in round 33.
      const tagged = taggedTruncator(src, tag);
      if (!tagged) continue;
      out.push({
        method: tagged.method,
        line: lineOf(src, n.start),
        receiver: tagged.receiverNode
          ? src.slice(tagged.receiverNode.start, tagged.receiverNode.end)
          : '',
        args: UNKNOWN_BOUNDS,
        text: src.slice(n.start, n.end),
        node: n,
        receiverNode: tagged.receiverNode,
      });
      continue;
    }
    if (n.type !== 'CallExpression') continue;
    const c = unwrapChain(n.callee);
    // `f.bind(src)(a, b)` — the receiver sits on the INNER call and the
    // bounds on the outer one, so neither filter saw it (round 15).
    if (c && c.type === 'CallExpression') {
      const inner = c.callee;
      if (
        inner &&
        inner.type === 'MemberExpression' &&
        memberName(inner) === 'bind'
      ) {
        const method = borrowedTruncator(src, inner, 'bind');
        if (method) {
          out.push({
            method,
            line: lineOf(src, n.start),
            receiver: c.arguments[0] ? src.slice(c.arguments[0].start, c.arguments[0].end) : '',
            // `bind`'s PRESET arguments come first and are what a
            // two-argument truncator actually consumes (round 25):
            // `slice.bind(src, start, start + 320)(at('x'), at('y'))`
            // truncates at the preset window and ignores the rest.
            args: effective([...c.arguments.slice(1), ...n.arguments]),
            text: src.slice(n.start, n.end),
            node: n,
            receiverNode: c.arguments[0] ?? null,
          });
        }
      }
      continue;
    }
    // `const cut = src.slice.bind(src); cut(start, start + 320)` — the
    // binding and the invocation in two statements instead of one
    // (round 33). The inline form above is recognised because both
    // halves sit in one expression; store the bound function in a name
    // and the `bind` call is skipped for being a `bind`, while the call
    // that uses it is skipped for having a plain name as its callee. The
    // window left the collector through the gap between the two.
    // EVERY value the name is ever given, not only its initialiser
    // (round 37). `let cut; cut = src.slice.bind(src); cut(…)` gives the
    // name its value by assignment, and the alias resolver refuses a
    // reassigned name — correctly, since it cannot say WHICH value
    // stands. But "which one" is not the question here: if ANY of them
    // is a bound truncator, this call may be a narrowing, and a may-be
    // is refused. Enumerating a name's own writes is bounded, unlike
    // deciding between them.
    if (c && c.type === 'Identifier') {
      const held = boundTruncatorValues(src, c);
      if (held) {
        out.push({
          method: held.method,
          line: lineOf(src, n.start),
          receiver: held.call.arguments[0]
            ? src.slice(held.call.arguments[0].start, held.call.arguments[0].end)
            : '',
          // Preset bounds first, exactly as the inline form: they are
          // what a two-argument truncator consumes. When the name has
          // more than one candidate value the bounds are not knowable,
          // so they are reported unreadable rather than guessed.
          args: held.certain
            ? effective([...held.call.arguments.slice(1), ...n.arguments])
            : UNKNOWN_BOUNDS,
          text: src.slice(n.start, n.end),
          node: n,
          receiverNode: held.certain ? (held.call.arguments[0] ?? null) : null,
        });
        continue;
      }
    }
    if (!c || c.type !== 'MemberExpression') continue;
    // `Reflect.apply(String.prototype.slice, src, [a, b])` — the same
    // borrowing again, through a callee whose object is a plain name
    // rather than a member, so `borrowedTruncator` refused it and the
    // direct path saw only `apply` (round 19). The receiver is the
    // SECOND argument and the bounds are in the third.
    const reflected = reflectApplyTruncator(src, n);
    if (reflected) {
      out.push({
        method: reflected,
        line: lineOf(src, n.start),
        receiver: n.arguments[1] ? src.slice(n.arguments[1].start, n.arguments[1].end) : '',
        args: effective(arrayElements(n.arguments[2])),
        text: src.slice(n.start, n.end),
        node: n,
        receiverNode: n.arguments[1] ?? null,
      });
      continue;
    }
    // `Reflect.apply` has ONE reader and it has now answered. Falling
    // through asks a SECOND reader the same question, and that one sees
    // an object it cannot resolve — `Reflect` is a global, so it has no
    // binding to follow — and reports unreadable. A call the dedicated
    // reader just proved harmless came back as a truncation that way
    // (round 30). Whoever owns a shape owns its answer.
    if (isReflectApply(src, c)) continue;
    // `String.prototype.slice.call(src, a, b)` is the same operation with
    // the receiver moved into the arguments (round 8). Recognised, and
    // the shifted receiver dropped so the bounds line up.
    const borrowed = borrowedTruncator(src, c);
    if (borrowed) {
      out.push({
        method: borrowed,
        line: lineOf(src, n.start),
        receiver: n.arguments[0] ? src.slice(n.arguments[0].start, n.arguments[0].end) : '',
        args: effective(borrowedArgs(memberName(c), n.arguments)),
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
    const name = memberName(c);
    // `substring` and `substr` truncate identically; the invariant is
    // about source REGIONS, not one spelling of the String API (round 5).
    if (name !== UNREADABLE && !TRUNCATORS.has(name)) continue;
    out.push({
      method: name,
      line: lineOf(src, n.start),
      receiver: src.slice(c.object.start, c.object.end),
      args: effective(n.arguments),
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
/**
 * The BOUNDS a borrowed truncator was actually given.
 *
 * `call` passes them straight through after the receiver. `apply` passes
 * them in an array, and reading the array expression itself as the sole
 * argument reported a correctly anchored slice as unbounded (round 16) —
 * refusing correct work while claiming to support the form. An array
 * this cannot read statically (a spread, a name) yields no arguments,
 * which refuses, and refusing an unreadable bound is the right way round.
 */
/**
 * The arguments a truncator actually CONSUMES.
 *
 * `slice`, `substring` and `substr` all take at most two; JavaScript
 * ignores anything after. Scanning every argument classified the ignored
 * `320` in `src.slice(start, src.indexOf('end'), 320)` as a character
 * bound and refused a correctly anchored region (round 17) — the
 * refusing direction again, and this one would have demanded an
 * exemption marker asserting that correct code counts characters.
 */
function effective(args) {
  return args === UNKNOWN_BOUNDS ? UNKNOWN_BOUNDS : args.slice(0, 2);
}

function borrowedArgs(via, args) {
  const rest = args.slice(1);
  if (via !== 'apply') return rest;
  return arrayElements(rest[0]);
}

/** The statically readable elements of an argument ARRAY, or UNKNOWN.
 *
 *  UNKNOWN is not the empty list (round 25). Zero arguments means "take
 *  the rest", which on an already-bounded receiver is legitimate — so
 *  collapsing an unreadable list to `[]` had
 *  `String.prototype.slice.apply(block, args)` read as a deliberate
 *  slice-to-end while the runtime used a fixed window. */
function arrayElements(node) {
  if (!node || node.type !== 'ArrayExpression') return UNKNOWN_BOUNDS;
  return node.elements.some((e) => !e || e.type === 'SpreadElement')
    ? UNKNOWN_BOUNDS
    : node.elements;
}

const UNKNOWN_BOUNDS = Symbol('bounds this cannot read');
export { UNKNOWN_BOUNDS };

/**
 * A value whose IDENTITY IS VISIBLE in the text it is written as — a
 * function or class written out, an object, an array, a piece of text.
 * None of these IS `String.prototype.slice`, so a borrowing through one
 * truncates nothing and is dropped.
 *
 * Everything else stays unknown, and the difference is the point: a
 * call's return value, a conditional, a parameter COULD hold a
 * truncator, so refusing them is the round-6 posture. Only a value this
 * can read off the page is a definite negative.
 *
 * Round 29 taught the same lesson on one path and round 30 on the other
 * — a local arrow behind `Reflect.apply` was being called unreadable,
 * which made the collector report a truncation that is not there and
 * then demand an exemption for it. One predicate, both paths, so the
 * next borrowing form does not get a third answer.
 */
const SELF_EVIDENT = new Set([
  'ArrowFunctionExpression',
  'FunctionExpression',
  'ClassExpression',
  'ObjectExpression',
  'ArrayExpression',
  'Literal',
  'TemplateLiteral',
  // `NewExpression` is NOT here, and that is the correction round 32
  // made to round 30's list. A constructor may RETURN a function, and
  // then that function is what `new` evaluates to — so
  // `function Factory() { return String.prototype.slice; }` makes
  // `new Factory()` a truncator wearing a constructor's spelling.
  // Calling it self-evidently harmless dropped a real fixed window out
  // of the collector entirely. An identity that is only visible by
  // reading the constructor's body is not visible in the text here.
]);

function definiteNonTruncator(node) {
  return node != null && SELF_EVIDENT.has(node.type);
}

// The hosts whose prototypes carry the built-in text operations. Named
// so the `.prototype` shortcut below checks an INTRINSIC rather than a
// word anyone can use as a property key.
const INTRINSIC_TEXT_HOSTS = ['String', 'Array'];

/**
 * The truncator a MEMBER denotes — `String.prototype.slice`, or
 * `box.cut` where `box` is written out and `cut` holds one.
 *
 * A property NAME that is not a truncator does not establish that the
 * property's VALUE is not one (round 35):
 * `const box = { cut: String.prototype.slice }` puts a real narrowing
 * behind a name that says nothing, and reading the name alone dropped
 * the call entirely. So the name settles it only where the object is
 * self-describing — an intrinsic's prototype, where the property name IS
 * the method — and otherwise the value has to be read. When it cannot
 * be, the answer is unreadable, which refuses.
 */
function memberTruncator(src, member) {
  const method = memberName(member);
  if (method === UNREADABLE) return UNREADABLE;
  if (TRUNCATORS.has(method)) return method;
  // The UNRESOLVED node is kept as well, because a global does not
  // resolve: `resolveAlias` finds no binding for `String` and returns
  // nothing, which is the right answer to "what was this assigned" and
  // the wrong one to "is this the intrinsic". `isIntrinsic` asks the
  // second question, and it needs the name itself to ask it of.
  const named = unwrapChain(member.object);
  const object = resolveAlias(src, named) ?? named;
  // `String.prototype.replace` — an INTRINSIC's prototype describes
  // itself, so a non-truncator name there is a definite negative. The
  // intrinsic has to be checked and not merely the spelling (round 36):
  // `{ prototype: { cut: String.prototype.slice } }` is an ordinary
  // object with a property called `prototype`, and trusting the word
  // alone dropped a real narrowing. A shortcut that keys on a name
  // anyone can choose is not a shortcut, it is a hole.
  if (
    object &&
    object.type === 'MemberExpression' &&
    memberName(object) === 'prototype' &&
    INTRINSIC_TEXT_HOSTS.some((name) => isIntrinsic(src, unwrapChain(object.object), name))
  ) {
    return null;
  }
  // An unshadowed INTRINSIC describes itself too: `String.raw` is a
  // known property of a known global, and a tag is a member like any
  // other, so without this every `String.raw\`…\`` in a test fixture
  // read as an unreadable narrowing (round 36). The check is on the
  // binding, not the spelling — a local `String` is somebody else's.
  if (object && INTRINSIC_TEXT_HOSTS.some((name) => isIntrinsic(src, object, name))) {
    return null;
  }
  // AND NOTHING ELSE IS READ (round 37, and this is a root fix rather
  // than a fourth patch to the same function).
  //
  // This used to look inside an object written out, find the property,
  // and judge its value. Three consecutive rounds found three ways for
  // that reading to be wrong — the property reassigned after the literal
  // was written, the property defined as an accessor so the literal
  // holds a getter rather than the value, a spread bringing it in from
  // elsewhere — and each fix exposed the next. That is the shape round 6
  // named: a rule whose correctness depends on having enumerated an open
  // set is wrong without knowing it. "What does this property hold when
  // this line runs" is a question about the whole program.
  //
  // So it is not asked. An intrinsic settles it; everything else is
  // UNREADABLE, which REFUSES. The cost is naming: a borrowing through
  // an ordinary object is reported as an unreadable narrowing rather
  // than as a `slice` one. It is still reported, which is what matters,
  // and no live suite borrows through an object at all.
  return UNREADABLE;
}

/** The truncator a `Reflect.apply(fn, recv, args)` is borrowing, or null.
 *  Takes the whole call: the borrowed function is its FIRST ARGUMENT,
 *  where every other borrowing form carries it on the callee. */
function isReflectApply(src, callee) {
  return (
    callee?.type === 'MemberExpression' &&
    isIntrinsic(src, unwrapChain(callee.object), 'Reflect') &&
    memberName(callee) === 'apply'
  );
}

function reflectApplyTruncator(src, call) {
  const callee = unwrapChain(call.callee);
  if (!isReflectApply(src, callee)) return null;
  const first = unwrapChain(call.arguments[0]);
  // No first argument, or one hidden behind a spread, is a call this
  // cannot read — which is refused, not dropped.
  if (!first || first.type === 'SpreadElement') return UNREADABLE;
  const named = first.type === 'Identifier';
  const fn = resolveAlias(src, first);
  // UNRESOLVABLE and RESOLVED-TO-SOMETHING-ELSE are different answers
  // (round 29 on the `.call`/`.apply` path, round 30 here).
  if (named && fn === null) return UNREADABLE;
  if (definiteNonTruncator(fn)) return null;
  if (!fn || fn.type !== 'MemberExpression') return UNREADABLE;
  return memberTruncator(src, fn);
}

/** Follow a STABLE alias to what it holds — one hop or many, refusing
 *  the moment a write reaches it or the chain cannot be followed. */
function resolveAlias(src, node, seen = new Set()) {
  if (node?.type !== 'Identifier') return node;
  const key = `alias:${node.name}@${node.start}`;
  if (seen.has(key)) return null;
  seen.add(key);
  const bound = bindingOf(src, node);
  if (!bound.found || !bound.init) return null;
  if (writeReaches(src, bound.writes, node.start)) return null;
  // A DESTRUCTURED name is not an alias for the whole initializer
  // (round 27): `const { slice: cut } = String.prototype` binds `cut` to
  // the selected property, while the declarator's init is
  // `String.prototype`. Following that read `prototype` as a known
  // non-truncator and DROPPED the call — the permissive answer again.
  // Unprojected means unresolved, which refuses.
  if (!simplyBound(src, node)) return null;
  return resolveAlias(src, bound.init, seen);
}

/** Whether every definition of the name binds it DIRECTLY — `const x =
 *  …` rather than a destructuring pattern, whose initializer belongs to
 *  the pattern and not to this name. */
function simplyBound(src, node) {
  const { variableOf } = astOf(src, 'simplyBound');
  const variable = variableOf.get(node);
  if (!variable) return false;
  return variable.defs.every((d) => d.node?.id?.type === 'Identifier');
}

/** An optional member is wrapped in a `ChainExpression` (round 26):
 *  `(src?.slice)(start, start + 320)` puts one in the callee, and there
 *  is no nested call for the walker to recover it from. */
function unwrapChain(node) {
  return node?.type === 'ChainExpression' ? node.expression : node;
}

function borrowedTruncator(src, callee, only) {
  const via = memberName(callee);
  if (only ? via !== only : !BORROWERS.has(via)) return null;
  let inner = unwrapChain(callee.object);
  // `const cut = String.prototype.slice; cut.call(src, …)` — the borrowed
  // function through a name (round 25). Resolve it, the way every other
  // rule here resolves a name, rather than giving up and letting the
  // direct path see only `call`.
  const named = inner?.type === 'Identifier';
  inner = resolveAlias(src, inner);
  // UNRESOLVABLE and RESOLVED-TO-SOMETHING-ELSE are different answers
  // (round 29). Round 26 made an unreadable borrowing refuse, and that
  // is right — but a name that resolves to an object literal is a
  // DEFINITE non-truncator, and refusing it demanded an exemption for a
  // call that truncates nothing. Only a failed resolution is unknown.
  if (named && inner === null) return UNREADABLE;
  if (definiteNonTruncator(inner)) return null;
  // A BORROWING THIS CANNOT READ IS REFUSED, NOT DROPPED (round 26).
  // Returning null here handed the call to the direct path, which saw
  // only `call`/`apply`, so it left the collector entirely — and every
  // round found another way to be unreadable: one alias, then two, then
  // a reassigned one, then one behind `Reflect.apply`. That is an open
  // set, so it is answered the way round 6 answered the bounds: an
  // unresolved borrowing MIGHT be a truncation and is reported as
  // UNREADABLE. Measured before adopting — the suites this guard reads
  // contain NO `call`/`apply`/`bind` borrowings at all, so nothing
  // correct is newly refused.
  if (!inner || inner.type !== 'MemberExpression') return UNREADABLE;
  // An UNREADABLE inner name is inspected, not dropped (round 19). The
  // direct path has treated an unreadable computed name that way since
  // round 7 — a call nobody can name is not a reason to stop looking at
  // it — and unifying the two readers in round 17 left this half still
  // returning null, so `String.prototype['sl' + 'ice'].call(…)` fell
  // through both paths. Same question, same answer, both ways round —
  // which is now one reader for both, so it cannot drift again.
  return memberTruncator(src, inner);
}

/**
 * The property name a member expression READS, statically — ONE reader,
 * used by every layer that needs one.
 *
 * There were two of these: the direct-call path decoded computed names
 * (a string, a no-substitution template, otherwise UNREADABLE) while
 * `borrowedTruncator` refused any computed member outright. So
 * `String.prototype.slice['call'](src, start, start + 320)` was invisible
 * to the borrowed path AND read as a plain `call` by the direct one,
 * leaving the window unexamined by both (round 17).
 *
 * Two readers of the same thing is the shape this file keeps being
 * caught by — round 6 had two answers to "is this a length", round 15
 * had two to "what does this name mean". The fix each time is one
 * reader, and it is the fix here.
 *
 * `UNREADABLE` is a Symbol, so it is in neither name set and falls
 * through to the inspect-anyway path rather than being skipped.
 */
function memberName(member) {
  if (!member.computed) return member.property.name;
  if (member.property.type === 'Literal') return member.property.value;
  if (member.property.type === 'TemplateLiteral' && member.property.expressions.length === 0) {
    return member.property.quasis.map((q) => q.value.cooked).join('');
  }
  return UNREADABLE;
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
  // It is trusted only if it DEFINITELY runs on the way to the use — an
  // initializer inside a branch the use is outside of leaves the name
  // undefined when that branch did not run (round 8).
  const withInit = defs.filter((d) => d.node?.init);
  // A definition that MIGHT have run and might not — one inside a branch
  // the use is outside of — poisons the binding rather than being
  // skipped: `var e = t.indexOf('e'); if (on) { var { e } = obj; }` may
  // leave `e` holding either (round 12, restated here).
  // The definition that STANDS is the last one that definitely runs
  // before the use. An uncertain definition only matters if nothing
  // certain overwrites it afterwards (round 19): in
  // `if (on) { var end = start + 320; } var end = s.indexOf('e');`
  // reaching the use proves the second ran, so the first cannot be what
  // `end` holds — and poisoning the binding refused correct work.
  const certain = [...withInit].reverse().find((d) => alwaysRunsBefore(src, d.node, node));
  const uncertain = withInit.some(
    (d) =>
      !alwaysRunsBefore(src, d.node, node) &&
      !definitelyAfter(src, d.node, node) &&
      !(certain && certain.node.start > d.node.end),
  );
  const initialised = uncertain
    ? undefined
    : [...withInit].reverse().find((d) => alwaysRunsBefore(src, d.node, node));
  // A DESTRUCTURED name is not bound to the whole initialiser (round
  // 34). `const { end } = src.indexOf('end')` binds `end` to a property
  // of the number the search returned — which is `undefined` — while the
  // declarator's initialiser is the search itself. Handing that back
  // read the search as this name's value and certified a bound that at
  // runtime is not there at all, so the region ran to the end of the
  // text.
  //
  // Fixed HERE rather than at the caller, and that is the point: the
  // alias resolver has carried its own destructuring check since round
  // 27, and the rule was missing from every other reader of this
  // function. One reader, one answer — see #2175, which this narrows.
  // The definition still counts for the uncertainty test above, so a
  // destructured definition that MIGHT have run still poisons the
  // binding (round 12); it simply never supplies a value.
  const projected = initialised && initialised.node.id?.type !== 'Identifier';
  return {
    found: true,
    init: initialised && !projected ? initialised.node.init : null,
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
  // A `var` HOISTS, so a function called before its initializer runs
  // sees `undefined` (round 26): `region(); var end = at('e'); function
  // region() { return s.slice(start, end); }` takes the slice with no
  // end at all. Textual order proves nothing there. `const`/`let` are
  // exempt because reaching the use before the declaration would throw,
  // so any run that gets there has already run it.
  if (crossesDeferredBoundary(parents, decl, use)) {
    // A `var` hoists, so a call before its initializer sees `undefined`.
    // A `const`/`let` is in its temporal dead zone, so such a call
    // THROWS — and therefore any run that reaches the use has already
    // run the declaration, whichever side of the function text it sits
    // on (round 27). Position is the wrong question here in both
    // directions: it over-accepted the `var` and under-accepted this.
    return !isHoistedVar(src, decl);
  }
  for (let c = decl, p = parents.get(c); p; c = p, p = parents.get(p)) {
    const slot = guardedSlot(SKIPPABLE, p, c);
    // The use must share the SAME guarded slot, not merely sit somewhere
    // inside the construct (round 17). `if (on) { var end = at('e'); }
    // else { s.slice(start, end) }` put both in one `IfStatement`, and
    // asking whether the STATEMENT contained the use said yes — so a
    // declaration in the branch that did not run was treated as
    // guaranteed, which is the unsound direction.
    if (slot && !slotContains(slot, use)) return false;
  }
  return decl.start < use.start;
}

/** Whether `decl` is a `var` declarator — the one declaration form whose
 *  name exists before its initializer runs. */
function isHoistedVar(src, decl) {
  const { parents } = astOf(src, 'isHoistedVar');
  const stmt = parents.get(decl);
  return decl.type === 'VariableDeclarator' && stmt?.type === 'VariableDeclaration' && stmt.kind === 'var';
}

/** Whether `use` sits inside a deferred host that `decl` does not. */
function crossesDeferredBoundary(parents, decl, use) {
  for (let c = use, p = parents.get(c); p; c = p, p = parents.get(p)) {
    if (inGuardedSlot(DEFERRED, p, c) && !(p.start <= decl.start && p.end >= decl.end)) {
      return true;
    }
  }
  return false;
}

/** Whether a construct that CAN have a braced body does not have one. */
function unbracedBody(node, at = -1) {
  // WHICH ARM the anchor names, not always the first one. An `if` has
  // two bodies, and an anchor on the `else` asks about the ALTERNATE:
  // `if (ready) { work(); } else consume({ marker: true });` has a
  // braced consequent, so checking that one said the header opens a
  // block and handed back `else consume({ marker: true }` — a partial,
  // plausible, wrong region, produced by the very check written to
  // refuse those. Round 28 added the check; it only ever looked at the
  // consequent.
  // Which arm the anchor names is settled by the TREE, not by counting
  // characters (round 36 — and counting characters to decide where a
  // region begins is the exact habit this whole module exists to
  // replace, so doing it here was worse than a bug). An anchor at or
  // past the end of the consequent is in the alternate's half of the
  // statement, whatever sits between them: `else /* why */ consume(…)`
  // put the anchor more than five characters from the alternate and the
  // count picked the wrong arm.
  const body =
    node.type === 'IfStatement'
      ? at >= 0 && node.alternate && at >= node.consequent.end
        ? node.alternate
        : node.consequent
      : node.body;
  if (!body || typeof body.type !== 'string') return false;
  // An `else if` chains rather than opening a block of its own, and the
  // nested `if` is its own owner — so it is not an unbraced body. ONLY
  // an else-if, though (round 38): written unconditionally this excused
  // any header whose unbraced body happens to be an `if`, so
  // `while (ready) if (x) { work(); }` and `label: if (a) {…} else {…}`
  // both returned the nested block as though the outer header had opened
  // it — a plausible partial region, which is the thing this check
  // exists to refuse. The exemption is about the `else if` CHAIN, so it
  // is written as that and not as a shape that resembles one.
  if (node.type === 'IfStatement' && body === node.alternate && body.type === 'IfStatement') {
    return false;
  }
  return BODY_BEARING.has(node.type) && !BRACED.has(body.type);
}

const BODY_BEARING = new Set([
  'IfStatement',
  'ForStatement',
  'ForOfStatement',
  'ForInStatement',
  'WhileStatement',
  'DoWhileStatement',
  'LabeledStatement',
]);

/** Whether a slot's extent covers `use`. A slot may be a list — a case
 *  body, a block's statements — and the whole list is one guarded path,
 *  so a use in a LATER statement of it is still on that path. */
function slotContains(slot, use) {
  const parts = Array.isArray(slot) ? slot.filter(Boolean) : [slot];
  if (parts.length === 0) return false;
  const start = Math.min(...parts.map((n) => n.start));
  const end = Math.max(...parts.map((n) => n.end));
  return start <= use.start && end >= use.end;
}

/**
 * Whether `decl` definitely runs only AFTER `use`, so it cannot affect
 * it. A declaration inside anything deferred is never in this class,
 * because a function body runs whenever it is called.
 */
function definitelyAfter(src, decl, use) {
  if (decl.start < use.end) return false;
  const { parents } = astOf(src, 'definitelyAfter');
  for (let c = decl, p = parents.get(c); p; c = p, p = parents.get(p)) {
    if (inGuardedSlot(DEFERRED, p, c)) return false;
  }
  return true;
}

/**
 * THE GUARDED THING IS A SLOT, NOT A NODE (round 16).
 *
 * Both rules above used to ask "is any ancestor of type X", and that is
 * the wrong unit — three of one round's five findings were the same
 * mistake wearing different syntax:
 *
 *   - a `do` body runs at least once, though the loop repeats;
 *   - a class field's KEY is evaluated where the class is defined,
 *     though its VALUE waits for construction;
 *   - a `while` test runs at least once, though its body may not.
 *
 * In each case part of the construct is guarded and part is not, so a
 * rule keyed to the construct is wrong about the other part — and wrong
 * in the direction that refuses correct code, which is the direction
 * that gets a check switched off. The tables below name the SLOTS.
 *
 * This is the same correction as round 15's template finding one level
 * up: a template is not text or code, its quasis are text and its holes
 * are code. A node is not skipped or run, its slots are.
 */
function guardedSlot(table, parent, child) {
  const slots =
    parent.type === 'PropertyDefinition' && parent.static
      ? // A STATIC field initializer runs where it is written, in
        // class-definition order, so nothing about it is guarded. The
        // one way that is not the whole story is handled by
        // `keyPrecedesStaticValue` rather than here — see its note.
        undefined
      : table[parent.type];
  if (!slots) return null;
  if (slots === ALL_SLOTS) return parent;
  for (const slot of slots) if (holds(parent[slot], child)) return parent[slot];
  return null;
}

function inGuardedSlot(table, parent, child) {
  return guardedSlot(table, parent, child) !== null;
}

/** Whether a slot's value IS `child`, or is a list containing it. */
function holds(value, child) {
  return Array.isArray(value) ? value.includes(child) : value === child;
}

const ALL_SLOTS = Symbol('every slot');

/**
 * Slots that MAY NOT RUN AT ALL, so a declaration inside one cannot be
 * relied on by a use outside it.
 *
 * What is deliberately absent is as load-bearing as what is present. A
 * `for`'s `init` always runs. A `while`/`for` `test` runs at least once.
 * A `do` statement appears nowhere: both its body and its test are
 * guaranteed a first pass. A `try`'s `finalizer` always runs, while its
 * `block` may stop part-way through.
 */
const SKIPPABLE = {
  IfStatement: ['consequent', 'alternate'],
  ForStatement: ['update', 'body'],
  ForOfStatement: ['left', 'body'],
  ForInStatement: ['left', 'body'],
  WhileStatement: ['body'],
  SwitchCase: ['test', 'consequent'],
  TryStatement: ['block', 'handler'],
  CatchClause: ['param', 'body'],
  ConditionalExpression: ['consequent', 'alternate'],
  LogicalExpression: ['right'],
};

/**
 * Slots that run at a time a POSITION CANNOT EXPRESS — a loop repeats, a
 * function body runs whenever it is called, an instance field waits for
 * construction. A write inside one is treated as reaching any use, which
 * refuses rather than certifies.
 *
 * A `do` IS here even though it is absent above: running at least once
 * answers "did it happen", not "in what order relative to everything
 * else in the loop".
 */
const DEFERRED = {
  PropertyDefinition: ['value'],
  ForStatement: ['test', 'update', 'body'],
  ForOfStatement: ['body'],
  ForInStatement: ['body'],
  WhileStatement: ['test', 'body'],
  DoWhileStatement: ['test', 'body'],
  FunctionDeclaration: ALL_SLOTS,
  FunctionExpression: ALL_SLOTS,
  ArrowFunctionExpression: ALL_SLOTS,
};

// Definition kinds that cannot hold source text, whichever syntax
// introduced them — `function f(){}`, `class C{}`, `export class C{}`
// all land here.
//
// An IMPORT does NOT (round 16). A module can export a string, so an
// imported name can hold source text, and rejecting it contradicted the
// stated interprocedural limit two screens below: a receiver that
// resolves to an import, a parameter or a call result is ACCEPTED. The
// cost of getting this wrong is not a missed window, it is pressure on
// an author to mark correct code as a character count — a falsehood the
// next reader inherits.
const NOT_TEXT_DEFS = new Set(['FunctionName', 'ClassName']);

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
    // A function marker excuses ONE truncator (round 17). A marked
    // helper containing a legitimate count handed the same excuse to
    // every other call in it, so adding an unsafe window to an
    // already-marked helper left the suite green — the same
    // one-reason-many-bounds fault round 7 found on a multi-declarator
    // statement, a scope wider. Where there is more than one, the
    // reason cannot say which it is about, so it excuses none.
    if (n.type === 'FunctionDeclaration' && truncatorCount(src, n) === 1) out.push(n);
    if (n.type !== 'VariableDeclarator') continue;
    const stmt = parents.get(n);
    // One name per marked statement, or the reason is ambiguous.
    if (stmt && stmt.type === 'VariableDeclaration' && stmt.declarations.length === 1) {
      // A marker above `export const label = …` sits above the EXPORT,
      // so the export is the statement it attaches to (round 29). The
      // inner declaration has the `export` token between it and the
      // comment, and `markedStatement` rightly refused that.
      const outer = parents.get(stmt);
      const markable = outer?.type === 'ExportNamedDeclaration' ? outer : stmt;
      // EVERY marked declarator takes the one-truncator rule, whatever
      // its initializer is (round 19). Round 18 applied it only when the
      // initializer WAS a function, so a marker above
      // `const label = choose(t.slice(0, 40), src.slice(start, start + 320));`
      // still excused both — the third shape of the same fault, after
      // round 7's multi-declarator statement and round 17's function
      // declaration. One reason cannot say which of two bounds it is
      // about, wherever the two sit.
      if (truncatorCount(src, stmt) <= 1) out.push(markable);
    }
  }
  return out;
}

/** How many truncating calls `fn` contains. */
function truncatorCount(src, fn) {
  return sliceCallsIn(src).filter((c) => c.node.start >= fn.start && c.node.end <= fn.end).length;
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
 * Whether a write to `variable` could reach the use at `useAt`.
 *
 * Position means something only when BOTH ends sit in straight-line code
 * (round 14). A write inside a function or a loop runs at a time position
 * cannot express, and so does a USE inside one — a region taken inside a
 * function runs whenever it is called, so a write below it may execute
 * first. Unknown order refuses rather than certifies.
 *
 * "Inside" is a SLOT question, not a node question — see `inGuardedSlot`.
 * A slice in a class field's computed KEY is not inside anything
 * deferred, however deferred the field's value is.
 */
function writeReaches(src, writes, useAt) {
  if (writes.length === 0) return false;
  const { nodes, parents } = astOf(src, 'writeReaches');
  const deferred = (n) => {
    for (let c = n, p = parents.get(c); p; c = p, p = parents.get(p)) {
      if (inGuardedSlot(DEFERRED, p, c)) return true;
    }
    return false;
  };
  // The innermost deferred ancestor — the function or loop body a node
  // runs inside. Two nodes sharing one are in the SAME invocation, where
  // ordinary position order holds again (round 23): deferring a function
  // says nothing about the order of statements within a single call of
  // it, and treating every use inside one as unordered refused correct
  // code outright.
  const host = (n) => {
    for (let c = n, p = parents.get(c); p; c = p, p = parents.get(p)) {
      if (inGuardedSlot(DEFERRED, p, c)) return p;
    }
    return null;
  };
  let useNode = null;
  for (const n of nodes) if (n.start <= useAt && n.end >= useAt) useNode = n;
  const useHost = useNode ? host(useNode) : null;
  return writes.some((w) => {
    if (keyPrecedesStaticValue(parents, w, useNode)) return true;
    const writeHost = host(w);
    // A LOOP repeats, so even one body gives no order; only a shared
    // FUNCTION host restores it.
    // …and only when the BINDING itself lives in that activation (round
    // 24). `let end = at('e'); function region() { …slice…; end = …; }
    // region(); region();` shares the function node but not the
    // lifetime: the second call sees the first call's write. A binding
    // declared OUTSIDE the host outlives the invocation, so sharing the
    // node proves nothing.
    const shared =
      useHost !== null &&
      writeHost === useHost &&
      !LOOPS.has(useHost.type) &&
      declaredWithin(src, w, useHost);
    // An assignment evaluates its RIGHT side before it writes (round
    // 27): in `end = s.slice(start, end).length` the bound use sits
    // inside the value being computed, so this write cannot have
    // happened yet however the identifiers are positioned.
    if (writesAfterUse(parents, w, useAt)) return false;
    if (shared) return w.start < useAt;
    if (useHost !== null) return true;
    return w.start < useAt || writeHost !== null;
  });
}

/** Whether the binding the write targets is DECLARED inside `host`. */
function declaredWithin(src, write, host) {
  const { variableOf } = astOf(src, 'declaredWithin');
  const variable = variableOf.get(write);
  if (!variable) return false;
  return variable.defs.every(
    (d) => d.name && d.name.start >= host.start && d.name.end <= host.end,
  );
}

/** Whether the use sits inside the VALUE an assignment is computing, so
 *  the write necessarily happens after it. */
function writesAfterUse(parents, write, useAt) {
  for (let c = write, p = parents.get(c); p; c = p, p = parents.get(p)) {
    // An `AssignmentPattern` is the same shape inside a destructuring —
    // `[end = s.slice(start, end).length] = []` evaluates the default
    // before the write (round 28), and walking past it to the outer
    // assignment tested the wrong right-hand side.
    // CONTINUE past one whose default does not contain the use (round
    // 29): in `[end = 0] = [s.slice(start, end).length]` the inner
    // pattern's default is unrelated, and returning there never reached
    // the outer assignment whose right side does contain it.
    if ((p.type === 'AssignmentExpression' || p.type === 'AssignmentPattern') && p.left === c) {
      if (p.right.start <= useAt && p.right.end >= useAt) return true;
    }
  }
  return false;
}

const LOOPS = new Set([
  'ForStatement',
  'ForOfStatement',
  'ForInStatement',
  'WhileStatement',
  'DoWhileStatement',
]);

/**
 * Whether `write` sits in a computed KEY that runs before `use`'s static
 * field initializer — in which case a later position does not mean later
 * execution.
 *
 * INSIDE A CLASS BODY, TEXT ORDER IS NOT EVALUATION ORDER (round 17).
 * Every computed key in the body is evaluated when the class is defined,
 * and all of them run before ANY static initializer. So
 *
 *     class C { static a = s.slice(start, end); static [(end = 320, 'k')] = 1 }
 *
 * lets a TEXTUALLY LATER key supply the bound the EARLIER static field
 * reads, and comparing positions certifies a window that is fixed.
 *
 * This is the one place the static-field exemption is not the whole
 * story, and it is kept here rather than folded into the slot tables
 * because it is not a containment question: nothing guards either node.
 * It is an ordering question, and the answer is that these two phases
 * run in the opposite order from how they are written.
 */
function keyPrecedesStaticValue(parents, write, use) {
  if (!use) return false;
  const body = enclosingClassPart(parents, write, (p, c) => p.computed && p.key === c);
  if (body === null) return false;
  // A STATIC BLOCK runs in the same phase as a static field value
  // (round 26) — after every computed key — so a slice inside one is
  // reached by a textually later key just as a field value is.
  return (
    body === enclosingClassPart(parents, use, (p, c) => p.static && p.value === c) ||
    body === enclosingStaticBlock(parents, use)
  );
}

/** The `ClassBody` whose `StaticBlock` contains `n`, or null. */
function enclosingStaticBlock(parents, n) {
  for (let c = n, p = parents.get(c); p; c = p, p = parents.get(p)) {
    if (p.type === 'StaticBlock') return parents.get(p) ?? null;
  }
  return null;
}

/** The `ClassBody` whose `PropertyDefinition` holds `n` in the slot
 *  `match` names, or null. */
function enclosingClassPart(parents, n, match) {
  for (let c = n, p = parents.get(c); p; c = p, p = parents.get(p)) {
    // A computed METHOD key is evaluated in the same phase as a computed
    // field key (round 27) — both before any static initializer — so the
    // member form must not decide which keys count.
    if (CLASS_MEMBERS.has(p.type) && match(p, c)) return parents.get(p) ?? null;
  }
  return null;
}

const CLASS_MEMBERS = new Set(['PropertyDefinition', 'MethodDefinition']);


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
      // `propertyName` reads a computed spelling too (round 24):
      // `needle['length']` is the same measurement as `needle.length`,
      // and rejecting it reported a genuine anchor as a window. This
      // module already had one reader for the question; this branch was
      // simply not using it.
      if (propertyName(node) === 'length') {
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
      // A POSITION STEPPED BY ITS OWN LANDMARK'S WIDTH, and nothing
      // else. Round 20 asked "is this distance about the same text";
      // round 21 showed that question has an open-ended answer as soon
      // as the arithmetic nests — `s.indexOf('x') + 'x'.length +
      // 'yyyy'.length` makes the inner sum a position, and the outer
      // measurement then has no finder to disagree with.
      //
      // So this is stated the way round 6 stated the whole rule: as a
      // CLOSED SHAPE rather than a property to verify. The left side
      // must be a finder call, the right its own needle's length. A
      // composite is not that shape and is refused — which is what the
      // one composite bound these suites actually write looks like:
      // `block.indexOf(haveControl) + haveControl.length`.
      // STEPPING PAST a landmark, never back before it (round 36).
      // `s.indexOf('x') - 'x'.length` is negative whenever the landmark
      // is at the start of the text, and a negative end is measured
      // from the END of the source — so that bound returns very nearly
      // the whole thing while reading as an anchored position. Proving
      // non-negativity means knowing where the landmark is, which is a
      // runtime fact; "just past the landmark" is the shape these
      // suites write and the only one this admits.
      if (l === 'position' && r === 'offset') {
        if (node.operator !== '+') return null;
        return sameLandmark(src, node.left, node.right) ? 'position' : null;
      }
      if (node.operator === '+' && l === 'offset' && r === 'position') {
        return sameLandmark(src, node.right, node.left) ? 'position' : null;
      }
      if (node.operator === '-' && l === 'position' && r === 'position') return 'offset';
      if (l === 'offset' && r === 'offset') return 'offset';
      return null;
    }

    // SIBLING branches get their OWN cycle state (round 21). `seen`
    // exists to stop a name resolving through itself; sharing one set
    // across two arms made the second arm mistake the first's ordinary
    // work for recursion, so `on ? alias : alias` — the same acyclic
    // alias twice — was refused. Cycle detection is per PATH, not per
    // traversal.
    case 'ConditionalExpression': {
      const a = kindOf(src, node.consequent, new Set(seen));
      return a !== null && a === kindOf(src, node.alternate, new Set(seen)) ? a : null;
    }

    case 'LogicalExpression': {
      const a = kindOf(src, node.left, new Set(seen));
      return a !== null && a === kindOf(src, node.right, new Set(seen)) ? a : null;
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
  // A CHOICE between two bounded regions is bounded (round 19): either
  // value `const block = useA ? blockFrom(…) : between(…)` can take
  // already has a meaningful end, so refusing it pressed the author
  // toward a marker asserting a character count that is not there.
  // Both arms must qualify — one unbounded arm is an unbounded region.
  if (node.type === 'ConditionalExpression') {
    return (
      isBoundedRegion(src, node.consequent, new Set(seen)) &&
      isBoundedRegion(src, node.alternate, new Set(seen))
    );
  }
  // The same choice written with `||`, `??` or `&&` (round 30).
  // `blockFrom(…) || between(…)` selects between two bounded regions
  // exactly as the ternary does, and refusing it pressed the author
  // toward the character count again. Every operand must qualify,
  // whichever operator: with `||` and `??` either can be the value, and
  // a left operand of `&&` that could be the value is falsy, which is
  // not a region at all.
  if (node.type === 'LogicalExpression') {
    return (
      isBoundedRegion(src, node.left, new Set(seen)) &&
      isBoundedRegion(src, node.right, new Set(seen))
    );
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
      isThisModule(d.parent.source.value),
  );
}

/**
 * Whether a module specifier names THIS helper.
 *
 * The file name has to be a whole path SEGMENT. `endsWith` was matching
 * `./fake-sourceBlock.mjs` too (round 16) — which is a module a test can
 * write, exporting a `blockFrom` that returns the raw source, and that
 * was enough to be trusted as the canonical one. A near-miss name is the
 * cheapest possible way past a trust check, so the comparison is on the
 * segment rather than on the tail of the string.
 */
function isThisModule(specifier) {
  // The CANONICAL sibling specifier, not any path ending that way
  // (round 25). `./fixtures/sourceBlock.mjs` shares the basename and can
  // return raw source; every real consumer of this helper sits beside it
  // and imports it as './sourceBlock.mjs'. Matching the whole specifier
  // needs no file-path plumbing and admits nothing else.
  return specifier === './sourceBlock.mjs';
}

/**
 * Whether `node` denotes the START OF THE TEXT — the literal `0`, or a
 * name that stably holds it (round 28). A region opening at `begin`
 * where `const begin = 0` is the same stable position as one opening at
 * `0`, and refusing it asked the author to mark correct code as a count.
 */
export function isStartOfText(src, node) {
  if (!node) return false;
  if (node.type === 'Literal') return node.value === 0 || node.value === '0';
  if (node.type !== 'Identifier') return false;
  const init = resolveAlias(src, node);
  return !!init && init !== node && isStartOfText(src, init);
}

/** Whether `node` is the global `name`, and not a local of that
 *  spelling. A binding found in this file is somebody else's. */
function isIntrinsic(src, node, name) {
  if (node?.type !== 'Identifier' || node.name !== name) return false;
  return !bindingOf(src, node).found;
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
  // An ASYNC arrow does not return what its body evaluates to — it
  // returns a promise of it. `const at = async (n) => src.indexOf(n)`
  // then makes `src.slice(start, at('end'))` coerce an object to NaN and
  // then to zero, so the region is empty and was being certified as
  // anchored. The body's kind is the promise's kind, not the call's.
  if (fn.async) return null;
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
  // A locally constructed object is no more evidence of source text
  // than an object literal (round 28): `new (class { indexOf() { … } })`
  // is the same fake finder with a constructor in front of it.
  'NewExpression',
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
  // THE `new String(src)` EXEMPTION IS GONE (round 33), and this is a
  // root fix rather than a fourth patch.
  //
  // It was added at round 29 because such a wrapper does use the
  // built-in finder and does return a source-relative position. Three
  // rounds then found three ways through it, each fix opening the next:
  // a property written on the wrapper, the same property written through
  // its prototype, and finally the intrinsic prototype itself replaced
  // before the wrapper is even built. That last one is not reachable
  // from the wrapper's own uses at all, so no amount of examining them
  // closes it — the question is whether anything in the program has
  // changed how strings search, which nothing bounded can answer.
  //
  // So the exemption is withdrawn rather than mended. `new` is already
  // in NOT_TEXT, so a wrapper is now suspect like any other constructed
  // object, and the cost is one shape nothing in these suites writes:
  // the census found zero. Refusing is the direction this guard errs in
  // everywhere else, and a rule that has needed a fix in each of three
  // consecutive rounds is telling you which side of it is wrong.
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
 * Whether a MEASURED offset measures the landmark the position found.
 *
 * "A place plus a distance is a place" (round 7) was true of the shapes
 * this suite writes — `s.indexOf('x') + 'x'.length` steps just past the
 * needle — and round 20 showed it admitting any measurement at all:
 * `start + `${'x'.repeat(320)}`.length` is a 320-character window
 * spelled as an offset, and so is a 320-character string literal.
 *
 * So the two halves have to be ABOUT THE SAME TEXT. When both are
 * statically readable and differ, the sum measures something the search
 * did not find, and is refused.
 *
 * The stated limit: when either side cannot be read statically — the
 * position came through a name, the measurement is a name — this keeps
 * accepting, because refusing there would reject the `at(x) + x.length`
 * shape these suites legitimately write. The demonstrated escapes both
 * close: an unreadable template measures nothing nameable, and a literal
 * that is not the needle is caught by the comparison.
 */
function sameLandmark(src, positionNode, offsetNode) {
  const needle = finderNeedleSource(src, positionNode);
  if (needle === null || needle !== measuredSource(src, offsetNode)) return false;
  // Spelling the same name on both sides does not make it TEXT (round
  // 22). `const needle = 320; s.indexOf(needle) + needle.length` passes
  // source equality, and `needle.length` is `undefined` — the end
  // coerces to zero and the region is empty, which is the too-short
  // failure this module exists to refuse.
  return isTextNeedle(src, needleNode(positionNode));
}

/** The finder's first argument, or null. */
function needleNode(node) {
  return node?.arguments?.[0] ?? null;
}

/**
 * Whether a needle can hold TEXT. Written out, it is text. A NAME is
 * trusted unless its binding is provably something else — the one
 * composite bound these suites write measures a name holding a bounded
 * REGION (`const haveControl = blockFrom(...)`), so requiring a literal
 * initializer here would refuse the very case the rule is for.
 */
function isTextNeedle(src, node, seen = new Set()) {
  if (!node) return false;
  if (node.type === 'Literal') return typeof node.value === 'string';
  if (node.type === 'TemplateLiteral') return true;
  if (node.type !== 'Identifier') return false;
  const key = `needle:${node.name}@${node.start}`;
  if (seen.has(key)) return false;
  seen.add(key);
  const bound = bindingOf(src, node);
  if (!bound.found) return true;
  if (bound.notText) return false;
  // A needle REASSIGNED before the use is not what it was declared as
  // (round 24) — `let needle = 'x'; needle = 320;` leaves `.length`
  // undefined and the end coerces to zero. Same rule the bound and the
  // receiver have followed since round 7; this check simply had not
  // adopted it.
  if (writeReaches(src, bound.writes, node.start)) return false;
  const init = bound.init;
  if (!init) return true;
  if (init.type === 'Literal') return typeof init.value === 'string';
  // An ALIAS hides the value one hop further on (round 23):
  // `const raw = 320; const needle = raw;` stopped at the Identifier
  // initializer and certified it as text. Follow the chain.
  if (init.type === 'Identifier') return isTextNeedle(src, init, seen);
  // A CLOSED LIST of what a needle may be, not an open list of what it
  // may not (the round-6 inversion, applied here at last). Naming the
  // non-text shapes left `const needle = 320 * 1` reading as text
  // because arithmetic is not in that set — and then `needle.length` is
  // undefined, the end is NaN, and the empty region was certified as
  // anchored. So: text written out, a name holding some, or a REGION
  // taken from the source — which is text by construction, and is what
  // the one composite bound these suites actually contain measures
  // (`block.indexOf(haveControl) + haveControl.length`, where
  // `haveControl` is a block taken from `block`). Anything else a
  // reader cannot see the value of, and is refused.
  return isBoundedRegion(src, init, new Set());
}

/** The SOURCE of the text a finder searched for, or null when the
 *  position is not a direct finder call. Source text rather than a
 *  value, so `'x'` and a name both compare — the one composite bound
 *  these suites write measures a NAME:
 *  `block.indexOf(haveControl) + haveControl.length`. */
function finderNeedleSource(src, node) {
  if (!node || node.type !== 'CallExpression') return null;
  const callee = node.callee;
  if (callee?.type !== 'MemberExpression' || !FINDERS.has(propertyName(callee))) return null;
  const arg = node.arguments[0];
  return arg ? src.slice(arg.start, arg.end) : null;
}

/** The SOURCE of the text an offset measures, or null when the offset
 *  is not a `<text>.length` measurement. */
function measuredSource(src, node) {
  if (!node || node.type !== 'MemberExpression') return null;
  if (propertyName(node) !== 'length') return null;
  return src.slice(node.object.start, node.object.end);
}


/**
 * A member's property name, read through a computed spelling where that
 * is possible: `s['indexOf']` and ``s[`indexOf`]`` are the same call as
 * `s.indexOf`, and refusing them reported a correctly anchored region
 * and asked for a marker claiming a count that was not happening
 * (round 11). `sliceCallsIn` already read truncator names this way.
 */
function propertyName(member) {
  // `#indexOf` is a PRIVATE method and can never be the built-in string
  // finder (round 28), but its node carries the bare name `indexOf`.
  if (member.property?.type === 'PrivateIdentifier') return null;
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
