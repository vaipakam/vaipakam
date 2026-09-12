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
  const open = src.indexOf('{', start);
  if (open === -1) throw new Error(`${header} opens no block`);
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`${header} has no matching close brace`);
}
