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
 * WHAT THIS ASSUMES ABOUT THE ENVIRONMENT, stated because it was twice
 * built as a check and the check was twice wrong (#2175 rounds 9-15).
 *
 * The truncation rule below reads the names a file's text spells — a
 * member called `slice`, a member called `call` — and decides from them
 * whether the file truncates text. That holds only while the language
 * behaves as written, so THIS MODULE ASSUMES THE DRIVE FILES DO NOT REWRITE THE LANGUAGE'S OWN
 * MACHINERY: no replaced intrinsic, no written prototype, no swapped
 * iterator or coercion hook, no Proxy standing in for source text.
 *
 * It was tempting to CHECK that instead of assuming it, and two rounds
 * were spent doing so — first for a replaced global, then for a written
 * prototype. Both were deleted, because "has this file replaced
 * something the language provides" has no syntactic answer: a computed
 * key spells it, `Object.defineProperty` and `Reflect.set` and
 * `Object.setPrototypeOf` each spell it, destructuring spells it, and
 * `valueOf` / `Symbol.toPrimitive` / a prototype getter / a Proxy reach
 * the same end without naming a prototype at all. Six review rounds each
 * produced another spelling. A check over an open set is not a weaker
 * check — it is a check that REPORTS SOUNDNESS IT DOES NOT HAVE, which
 * on a guard whose whole job is refusing unearned confidence is worse
 * than the honest assumption.
 *
 * The assumption is also the right shape for the actual threat. This
 * guard exists to stop an AUTHOR writing `src.slice(start, start + 320)`
 * by mistake. It was never an adversary model, and nobody reaches for
 * `Object.defineProperty(String.prototype, …)` in a Playwright drive by
 * accident.
 *
 * What replaces the check is in the SUITE, not here: `sourceBlock.test`
 * asserts that no file under `e2e/live/**` rewrites machinery, in the
 * forms it can recognise. Best-effort is appropriate THERE and was not
 * appropriate here — a miss in the suite means nobody noticed something
 * bizarre in our own drive files, while a miss here would be a
 * truncation the guard never reported.
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

const PARSE_OPTIONS = { ecmaVersion: 'latest', sourceType: 'module' };

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
 * The source AFTER `anchor` — from the end of its first code occurrence
 * to the end of `src`.
 *
 * For a tail inside a region that is ALREADY bounded by meaning: the arm
 * of a branch that follows a block taken with `blockFrom`, say. Over a
 * whole file this is the too-long region #2144 is about, so it is only
 * the right helper when `src` is itself such a region.
 *
 * Throws when the anchor is gone, which is the point of having it
 * (#2172): `block.slice(block.indexOf(x) + x.length)` with `x` renamed
 * searches to -1 and returns the block from a few characters before its
 * end, a plausible region that asserts nothing.
 */
export function after(src, anchor) {
  const at = anchorAt(src, anchor, 'after');
  return src.slice(at + anchor.length);
}

// ─── THE TRUNCATION RULE (#2172, #2174, #2176) ──────────────────────────
//
// What the guard asks of a suite, in one sentence: A SUITE NEVER CUTS
// SOURCE TEXT ITSELF. Every region comes from `blockFrom`, `statementFrom`,
// `between`, `callContaining` or `after`, which find their anchors in the
// parse tree and THROW when one is gone. Every other truncation in a suite
// (trimming a message, dropping `0x`, dropping header rows) carries a
// `not-a-source-region:` marker that says what it cuts.
//
// It used to ask something else: that a hand-written `src.slice(a, b)`
// be PROVABLY ANCHORED, which meant proving that each bound was a search
// for a landmark and not a count. That took a resolver, a write-ordering
// model, a class-phase model, a receiver model and a needle model, about
// two thousand lines across #2144, #2170, #2175 and #2177, and every round
// of review found another shape it was wrong about in one direction or
// the other. Three issues remained open against it, and they are the
// reason it is gone rather than patched again:
//
//   - #2172: a search for a landmark that is no longer there returns -1,
//     which is a valid slice bound. No syntactic rule can know whether a
//     search will succeed, so the guard certified such regions. One was
//     live when this landed: an exit-ordering rule sliced up to a comment
//     the drive had since dropped, and asserted over the rest of the file.
//   - #2174: escapes that need an unbounded analysis to close (a receiver
//     with its own finder, a jump past an initialiser).
//   - #2176: correctly anchored code the model refused, which pushed the
//     author toward a marker claiming a count that was not happening.
//
// Asking for the helpers instead removes all three by construction. The
// helpers throw on a missing anchor, so -1 never becomes a bound. Nothing
// is certified from a bound's shape, so there is nothing to escape. And
// correct code always has an honest spelling: the helper call.
//
// What is left is DETECTION, and it is kept to names the text spells, so
// it needs no resolver either. Reported, wherever it appears in a suite:
//
//   1. a call or a template tag whose callee is a member named `slice`,
//      `substring` or `substr`, or whose computed name cannot be read
//      (`s[k](…)` may be any of them);
//   2. one of those three members anywhere ELSE: taken as a value
//      (`String.prototype.slice`), stored, passed, bound or assigned;
//   3. a member named `call`, `apply` or `bind`, which is how a function
//      taken as a value is invoked on a receiver (`Reflect.apply` is
//      the member `apply` too);
//   4. one of the three names unpacked by a destructuring pattern
//      (`const { slice } = String.prototype`).
//
// Rules 2 to 4 close every way to reach a truncator without writing its
// call out, so rule 1 never has to work out what a name holds. They refuse
// correct code too, and that is the trade: none of the three shapes occurs
// in the suites today (measured when this landed), and if one is ever
// needed it gets a marker like any other non-region truncation.
//
// THE THREAT MODEL is the one the module header states: an author
// writing a fixed window by mistake. A file that rebuilds a truncator
// through reflection (`Reflect.get(String.prototype, 'slice')` installed
// as a method of a wrapper object) is rewriting the language's machinery
// in all but name, which the header's assumption already excludes.

const TRUNCATORS = new Set(['slice', 'substring', 'substr']);
const BORROWERS = new Set(['call', 'apply', 'bind']);

// A computed member name this cannot read. A Symbol, so it is in neither
// set above and a caller has to decide about it in the open.
const UNREADABLE = Symbol('unreadable member name');

/**
 * The name a property KEY spells, statically: the identifier, a string
 * key, or a no-substitution template key. `UNREADABLE` for any other
 * computed key, and `null` for a private name (`#slice` is a class's own
 * method and never the built-in).
 *
 * ONE decoder for members and for destructuring keys alike, and for the
 * suite's own assumption check through `propertyName` below: two decoders
 * for one question is how `s[`slice`]` once escaped (#2144 round 7).
 */
function keyName(key, computed) {
  if (key?.type === 'PrivateIdentifier') return null;
  if (!computed && key?.type === 'Identifier') return key.name;
  if (key?.type === 'Literal') return String(key.value);
  if (key?.type === 'TemplateLiteral' && key.expressions.length === 0) {
    return key.quasis.map((q) => q.value.cooked).join('');
  }
  return UNREADABLE;
}

function memberName(member) {
  return keyName(member.property, member.computed);
}

/**
 * The statically readable property name of a member, or `null` when it
 * has none (an unreadable computed key, or a private name).
 *
 * Exported for the suite's assumption check, so it decodes a member the
 * same way this module does.
 */
export function propertyName(member) {
  const name = memberName(member);
  return typeof name === 'string' ? name : null;
}

/**
 * The call or tagged template that INVOKES `member`, or `null` when the
 * member is used some other way. Optional chaining is looked through:
 * `s?.slice(…)` and `(s?.slice)(…)` both invoke the member, the second
 * with a `ChainExpression` between them.
 */
function invokerOf(parents, member) {
  let callee = member;
  let p = parents.get(member);
  if (p?.type === 'ChainExpression') {
    callee = p;
    p = parents.get(p);
  }
  if (p?.type === 'CallExpression' && p.callee === callee) {
    return parents.get(p)?.type === 'ChainExpression' ? parents.get(p) : p;
  }
  if (p?.type === 'TaggedTemplateExpression' && p.tag === callee) return p;
  return null;
}

/**
 * Every truncation `src` writes, or could perform without writing its
 * call out, as `{ line, text, node, why }` — `node` being the call (or
 * the member, or the pattern property) so a caller can ask which
 * statement it belongs to. The rule is the four-point list above.
 */
export function truncationsIn(src) {
  const { nodes, parents } = astOf(src, 'truncationsIn');
  const out = [];
  const report = (node, why) =>
    out.push({ line: lineOf(src, node.start), text: src.slice(node.start, node.end), node, why });
  for (const n of nodes) {
    if (n.type === 'Property' && parents.get(n)?.type === 'ObjectPattern') {
      const name = keyName(n.key, n.computed);
      if (TRUNCATORS.has(name) || name === UNREADABLE) {
        report(n, `unpacks ${typeof name === 'string' ? `\`${name}\`` : 'a computed key'} from an object`);
      }
      continue;
    }
    if (n.type !== 'MemberExpression') continue;
    const name = memberName(n);
    const invoker = invokerOf(parents, n);
    if (TRUNCATORS.has(name)) {
      if (invoker) {
        report(invoker, invoker.type === 'TaggedTemplateExpression' ? `\`${name}\` called as a tag` : `\`${name}\` call`);
        continue;
      }
      // `String.prototype.slice.call(…)` is ONE truncation, reported once
      // by the borrowing below rather than twice here and there: a marker
      // excuses one truncation per statement, and a double report would
      // make a marked borrowing unexcusable.
      const p = parents.get(n);
      if (p?.type === 'MemberExpression' && p.object === n && BORROWERS.has(memberName(p))) continue;
      report(n, `\`${name}\` taken as a value`);
      continue;
    }
    if (name === UNREADABLE && invoker) {
      report(invoker, 'a method whose name cannot be read, which may be a truncator');
      continue;
    }
    if (BORROWERS.has(name)) {
      report(invoker ?? n, `\`${name}\` borrows a function onto a receiver`);
    }
  }
  return out;
}


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
  return truncationsIn(src).filter((c) => c.node.start >= fn.start && c.node.end <= fn.end).length;
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
