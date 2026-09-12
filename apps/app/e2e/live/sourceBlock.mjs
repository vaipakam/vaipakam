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
