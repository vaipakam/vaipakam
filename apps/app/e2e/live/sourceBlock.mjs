/**
 * Brace-matched slices of the drive's source, for the source tests.
 *
 * WHY THIS EXISTS. `live-position-observe.mjs` runs the whole drive on
 * import, so several of its branches cannot be executed from a unit test
 * and are asserted against the source text instead (extraction is
 * tracked in #2120). Every such test needs the same thing: the block
 * under a given header, and NOTHING past its close.
 *
 * The tempting way to get one is a fixed character window —
 * `src.slice(start, start + 1600)` — and it is wrong in two directions,
 * both of which this PR has paid for:
 *
 *   - TOO SHORT, silently. The slice stops inside the block, so a rule
 *     asserted over it is blind to the tail. `confirmTrial.test.mjs`
 *     counted the assignments that record the trial's outcome and found
 *     two, over a block that has three — the third sat 137 characters
 *     past the window. It had been asserting `toBe(2)` and calling it
 *     exact, so deleting the unguarded arm's assignment — precisely the
 *     regression the test exists to catch — would have left it green.
 *   - TOO LONG, eventually. The slice runs past the block into whatever
 *     follows, and a rule "about" the block starts matching its
 *     neighbours.
 *
 * Both failure modes move with unrelated edits, which is the tell: a
 * test that fails because the file GREW teaches nothing, and trains the
 * next reader to widen the number rather than ask what it bounds.
 *
 * Extracted rather than copied. Two files needed it, and a second copy
 * of a helper is how `notClipped` / `paintsText` / `shownBox` /
 * `visibleTextOf` ended up with one fixed site and one stale one
 * (#2102).
 */

/**
 * The source of the block introduced by `header`, from the header
 * through its matching close brace.
 *
 * Throws rather than returning an empty string if the header is gone: a
 * rule asserted over `''`, or over a slice taken from `-1`, passes by
 * measuring nothing, which is the vacuous shape this suite has been
 * caught by four times.
 *
 * Brace counting is naive about braces inside strings, comments and
 * template literals. That is sound for the headers used here — whole
 * functions and control-flow blocks in the drive — and the callers all
 * assert something about the content they get back, so a slice that
 * ended in the wrong place would not quietly satisfy them.
 */
export function blockFrom(src, header) {
  const start = src.indexOf(header);
  if (start === -1) throw new Error(`${header} was renamed or removed`);
  return balanced(src, start, '{', '}', 'close brace', header);
}

/**
 * The source BETWEEN two anchors — from `from` up to (not including) the
 * next occurrence of `to` after it.
 *
 * For a region that is neither a brace block nor a paren call: a
 * declaration and the few lines that belong with it, a neighbourhood of
 * statements. `blockFrom` cannot bound those — there is no brace to match
 * — and the tempting substitute is the fixed window this module exists to
 * refuse (#2144). A following anchor bounds the region by something that
 * MEANS the region ended, so it moves with the code instead of with the
 * file's length.
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
  const start = src.indexOf(from);
  if (start === -1) throw new Error(`${from} was renamed or removed`);
  const end = src.indexOf(to, start + from.length);
  if (end === -1) {
    throw new Error(`${to} does not follow ${from} — it was renamed, removed, or moved above it`);
  }
  return src.slice(start, end);
}

/**
 * The source of the STATEMENT introduced by `header`, from the header
 * through its own terminating semicolon.
 *
 * For the region a declaration owns — `const x = a && b && c;` spread over
 * several lines — which is neither a brace block nor a call, and which
 * `between` can only bound by naming whatever happens to follow it. That
 * "whatever follows" is the weakness: it is a real anchor in the file but
 * it means nothing ABOUT the region, so it moves when an unrelated
 * declaration is inserted after this one, and a rule about this statement
 * silently starts reading the insertion too.
 *
 * Every fixed-length window this module set out to retire (#2144) was over
 * exactly this shape — a multi-line initializer with no closing brace to
 * match — which is why they survived two passes of conversion: there was
 * nothing to convert them TO. This is that missing bound.
 *
 * Depth-tracked over `()`, `[]` and `{}`, so a semicolon inside an
 * arrow body or an object literal does not end the statement. String
 * literals and comments are SKIPPED rather than scanned, unlike
 * `blockFrom`'s naive brace count: a `;` inside a message string is
 * ordinary here, where a stray brace in a whole-function header is not.
 */
export function statementFrom(src, header) {
  const start = src.indexOf(header);
  if (start === -1) throw new Error(`${header} was renamed or removed`);
  const OPEN = { '(': ')', '[': ']', '{': '}' };
  let depth = 0;
  for (let i = start; i < src.length; i += 1) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i);
      i = nl === -1 ? src.length : nl;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const close = src.indexOf('*/', i + 2);
      if (close === -1) throw new Error(`${header} has an unterminated comment`);
      i = close + 1;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      i = endOfString(src, i, c, header);
      continue;
    }
    if (OPEN[c]) depth += 1;
    else if (c === ')' || c === ']' || c === '}') depth -= 1;
    else if (c === ';' && depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`${header} has no terminating semicolon`);
}

function endOfString(src, open, quote, label) {
  for (let i = open + 1; i < src.length; i += 1) {
    if (src[i] === '\\') {
      i += 1;
      continue;
    }
    // A template's `${…}` holds EXPRESSIONS, which may carry their own
    // strings — including another backtick. Walking straight past them
    // would read that inner quote as this template's close and hand the
    // rest of the file back as code, so the hole is skipped by brace depth.
    if (quote === '`' && src[i] === '$' && src[i + 1] === '{') {
      let depth = 1;
      let j = i + 2;
      for (; j < src.length && depth > 0; j += 1) {
        const c = src[j];
        if (c === "'" || c === '"' || c === '`') j = endOfString(src, j, c, label);
        else if (c === '{') depth += 1;
        else if (c === '}') depth -= 1;
      }
      if (depth > 0) throw new Error(`${label} has an unterminated \${} in a template`);
      i = j - 1;
      continue;
    }
    if (src[i] === quote) return i;
  }
  throw new Error(`${label} has an unterminated ${quote} string`);
}

/**
 * The source of the call that CONTAINS `needle`, from `callee` through
 * its matching close paren.
 *
 * For regions whose boundary is a paren rather than a brace — a report
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
 */
export function callContaining(src, needle, callee = 'console.log(') {
  const inside = src.indexOf(needle);
  if (inside === -1) throw new Error(`${needle} was renamed or removed`);
  const start = src.lastIndexOf(callee, inside);
  if (start === -1) throw new Error(`${needle} is not inside a ${callee} call`);
  const call = balanced(src, start, '(', ')', 'close paren', needle);
  // The anchor has to be INSIDE what came back. If the call closed before
  // reaching it — an unbalanced paren in a string literal is the way that
  // happens — the slice is some earlier call and every rule over it is
  // about the wrong code.
  if (!call.includes(needle)) throw new Error(`${needle} is not inside the ${callee} call found`);
  return call;
}

/**
 * The ARGUMENT TEXT of the call whose open paren sits at `open`, without
 * the parens themselves — `null` if the call never closes.
 *
 * Finding a delimited region is this module's job, and the #2144 guard in
 * the sibling test needs one: to decide whether a bound is an anchor or a
 * number it has to read the whole argument list, however many lines and
 * nested calls it spans. Reading it there would have meant the guard
 * narrowing source by hand in order to forbid narrowing source by hand.
 *
 * Returns `null` rather than throwing. A caller SCANNING a file meets
 * text that is not a call and should move on; the anchored helpers above
 * are told exactly what to find and throw when it is gone.
 */
export function balancedArgs(src, open) {
  if (src[open] !== '(') return null;
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    const c = src[i];
    // Skipped, not counted. The arguments here are ANCHORS — string
    // literals quoting the code being looked for — and the realistic one
    // is `indexOf('for (const l of readyFirst) {')`, whose own brackets
    // are text. Counting them walks the depth off by two and the call
    // "closes" somewhere in the next test.
    if (c === "'" || c === '"' || c === '`') {
      // A quote that never closes means this was not a call after all —
      // an apostrophe in a comment is the usual way. Same answer as an
      // unclosed paren: not a call, move on.
      try {
        i = endOfString(src, i, c, 'balancedArgs');
      } catch {
        return null;
      }
      continue;
    }
    if ('([{'.includes(c)) depth += 1;
    else if (')]}'.includes(c)) {
      depth -= 1;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return null;
}

function balanced(src, start, open, close, what, label) {
  const from = src.indexOf(open, start);
  if (from === -1) throw new Error(`${label} opens no block`);
  let depth = 0;
  for (let i = from; i < src.length; i += 1) {
    if (src[i] === open) depth += 1;
    else if (src[i] === close) {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`${label} has no matching ${what}`);
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
