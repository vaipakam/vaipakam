/**
 * The wallet-address redaction contract, shared by every surface that
 * publishes user-supplied text.
 *
 * It lives here rather than inside `apps/app` because it has to hold on TWO
 * independent surfaces and must not drift between them (#2024, Codex r7 P1).
 * The connected app scrubs a support report before it becomes a pre-filled
 * GitHub issue; `apps/agent` scrubs the same fields again when a ticket
 * arrives at `POST /support/ticket`, precisely because that endpoint accepts
 * arbitrary JSON from any caller clearing the Origin gate, and from any
 * cached older client. The server copy matched only LITERAL addresses, so an
 * encoded one passed it unchanged into D1 and the operator notification —
 * fixing the client alone would have left the promise half true.
 *
 * Two copies of an algorithm this fiddly would diverge at the next finding.
 * The review history behind this file is seven rounds of exactly the kind of
 * subtlety that does not survive being maintained twice, so: one
 * implementation, one test suite, both surfaces.
 *
 * Framework-free by construction — no DOM, no viem, no React — so a
 * Cloudflare Worker and a browser bundle can both take it.
 *
 * WHAT IT STILL DOES NOT CATCH, stated here rather than discovered (#2027).
 * Two residual exposures remain after the payload-anchored matcher below, and
 * both are the SAME trade rather than two oversights: this module also
 * promises a 32-byte transaction hash survives whole, and a hash is sixty-four
 * hex characters containing many forty-character windows. Any rule that
 * redacts a 40-character window inside a longer run therefore destroys every
 * hash. So:
 *
 * - a hex run LONGER than forty is left alone, including a 41-run whose last
 *   forty could be an account with one junk character in front;
 * - an address deliberately SPLIT across a separator — two encoded halves
 *   joined by a hyphen, say — is two short runs and is left alone. Joining
 *   fragments across separators means deciding how far a separation may
 *   stretch before reconstruction is speculation, and picking that line
 *   silently inside a matcher is how the contiguity gap arrived in the first
 *   place.
 *
 * Both are pinned in the suite as known limits, so they read as decisions
 * rather than as coverage. Neither is reachable by an ordinary crash message;
 * both need text an attacker composed, and an attacker composing the text
 * already knows the address.
 */

export function redactAddress(address: string | undefined): string {
  if (!address) return 'not connected';
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/**
 * An address is found by its FORTY DIGITS, not by its `0x` (#2027).
 *
 * The pattern here used to be `0[xX][a-fA-F0-9]{40}(?![a-fA-F0-9])` — the
 * prefix and the digits had to be contiguous, so anything between them was an
 * escape route, on every path. A space, an `&`, a second query parameter, a
 * hyphen; and the degenerate case of no prefix at all, since forty bare hex
 * digits are one fixed two-character edit from the account. Each of those
 * reached a PUBLIC issue in full.
 *
 * #2026 fixed the case where this module MANUFACTURED the shape — the
 * fail-closed branches deleted an escape run and left the hex beside it — and
 * adjacency is the honest limit of that fix. It does nothing for a separation
 * that was in the input already.
 *
 * So the match anchors on the payload. A MAXIMAL run of exactly forty hex
 * characters is an address body; the `0x` is taken into the span when it
 * happens to be right there, purely so the familiar `0x1234…5678` shape
 * survives. Two properties follow from "maximal" that the old lookahead had
 * to state and that a naive bare-hex rule would get wrong:
 *
 * - a 32-byte transaction hash is a 64-run, so it is not a 40-run and is left
 *   whole — support needs those intact, and a mangled prefix would neither
 *   redact nor preserve anything;
 * - its LAST forty characters are inside that same run, so they are not a
 *   maximal 40-run either. The tail case needs no separate rule.
 *
 * NO LOOKBEHIND, and that is a hard constraint rather than a preference.
 * `(?<![a-fA-F0-9])` expresses this in one pattern and is a SyntaxError at
 * PARSE time on Safari before 16.4 — not a failed match, a module that will
 * not load, in a file whose standing rule is that a diagnostics helper must
 * never become a crash source. A scan costs a few lines and cannot do that.
 *
 * The issue that filed this proposed a second rule as well: redact a 40-run
 * sitting within a small window of a `0x`, with only non-alphanumerics
 * between. That rule is unnecessary — the forty digits are redacted whatever
 * precedes them — and it was the part carrying the judgement call about how
 * far a separation may stretch before joining the pieces is speculation. The
 * question does not arise.
 *
 * THE COST, stated because it is real: a bare 40-hex run that is not an
 * address is redacted too, and a full git SHA-1 is exactly forty hex
 * characters. One appearing in a component stack or a URL inside an error
 * message will come through shortened. That is the trade this module makes
 * everywhere else — a redacted SHA can be asked for again, a published
 * account cannot be taken back. The app's own build stamp is unaffected: it
 * is `git rev-parse --short`, seven to nine characters.
 */
const HEX_RUN_RE = /[a-fA-F0-9]+/g;
const ADDRESS_HEX_LEN = 40;

/**
 * Every span this module will shorten, in order, without overlaps.
 *
 * `matchAll` over `[a-fA-F0-9]+` yields MAXIMAL runs, which is the whole
 * mechanism: run length alone separates an address from a hash, so neither a
 * lookahead nor a lookbehind is needed to express it. Linear — each character
 * belongs to at most one run — and free of the backtracking hazard the
 * escape-run comment above documents, since the pattern has no optional
 * leading quantifier to unwind.
 */
function* addressSpans(text: string): Generator<{ index: number; text: string }> {
  // End of the previously yielded span. THE PREFIX IS WHAT CAN COLLIDE
  // (#2043 round 2 P2), and it was a leak rather than a tidiness problem.
  //
  // The forty-digit bodies can never overlap — they are maximal hex runs and
  // are disjoint by construction. The absorbed `0x` can, because its `0` IS a
  // hex character and can therefore be the last character of the run before
  // it. `<39 hex>0x<40 hex>` is the shape: the first maximal run is those 39
  // digits PLUS that `0`, exactly forty long, so it is emitted as an address;
  // the second then tries to absorb the same `0` and starts one character
  // inside the span already taken.
  //
  // The consumer's overlap guard then dropped the whole second match. Observed
  // before the fix: `…aaa0` + `x` + the complete second address — not merely
  // recoverable, INTACT, on text that becomes a public issue.
  //
  // Absorbing the prefix is cosmetic; redacting the digits is the promise. So
  // where the two conflict the prefix gives way, and the address is still
  // shortened — one character further in.
  let previousEnd = 0;
  for (const m of text.matchAll(HEX_RUN_RE)) {
    if (m[0].length !== ADDRESS_HEX_LEN) continue;
    const digitsAt = m.index;
    // Absorb an immediately preceding `0x` / `0X` — case-insensitive, because
    // a pasted `0X`-prefixed address must redact to the same shape (round 5).
    // `x` is not a hex character, so it always ends the previous run and can
    // never have been swallowed by it.
    const prefixed =
      digitsAt >= 2 &&
      (text[digitsAt - 1] === 'x' || text[digitsAt - 1] === 'X') &&
      text[digitsAt - 2] === '0';
    const index =
      prefixed && digitsAt - 2 >= previousEnd ? digitsAt - 2 : digitsAt;
    const end = digitsAt + ADDRESS_HEX_LEN;
    yield { index, text: text.slice(index, end) };
    previousEnd = end;
  }
}

/** Shorten every address span in `text` — the single replacement helper each
 *  redaction path now calls. */
function shortenAddresses(text: string): string {
  let out = '';
  let cursor = 0;
  for (const span of addressSpans(text)) {
    if (span.index < cursor) continue;
    out += text.slice(cursor, span.index) + shortenMatch(span.text);
    cursor = span.index + span.text.length;
  }
  return out + text.slice(cursor);
}

/** Scrub any full address ANYWHERE in report text — crash messages,
 *  component stacks, and deep-link paths routinely embed the
 *  connected account, and the redaction contract covers the whole
 *  public report, not just the wallet row. Applied to the finished
 *  body/title so future fields can't reintroduce a leak; exported so
 *  the drawer's ON-SCREEN error row honours the same contract. */
const shortenMatch = (m: string): string => `${m.slice(0, 6)}…${m.slice(-4)}`;

/**
 * Decode percent-escapes while remembering where each decoded character
 * came from (#2024).
 *
 * `ctx.path` is `pathname + search` taken raw from the browser, and
 * `location.search` does NOT decode escapes — so a deep link carrying
 * `?wallet=%30%78%31…` presents no literal `0x…` to the scrubber and the
 * address reaches GitHub reversibly. Decoding for the SEARCH while keeping
 * an index map means the redaction can be applied back to the original
 * span, so the report still shows the URL as it actually was, minus the
 * address. Decoding the whole string instead would silently rewrite text a
 * reader may need to see verbatim.
 *
 * Deliberately single-byte and ASCII-only: an address is ASCII, so there is
 * no reason to reassemble multi-byte UTF-8 here. A `%C3%A9` pair decodes to
 * two characters that match nothing and are mapped back individually, which
 * is harmless. `decodeURIComponent` is not used at all — it throws on a
 * malformed escape (`%zz`, a trailing `%`), and this module's standing rule
 * is that a diagnostics helper must never become a crash source.
 */
function decodeWithMap(text: string): { decoded: string; map: number[] } {
  let decoded = '';
  const map: number[] = [];
  let i = 0;
  while (i < text.length) {
    const isEscape = text[i] === '%' && /^[0-9a-fA-F]{2}$/.test(text.slice(i + 1, i + 3));
    if (isEscape) {
      decoded += String.fromCharCode(parseInt(text.slice(i + 1, i + 3), 16));
      map.push(i);
      i += 3;
    } else {
      decoded += text[i];
      map.push(i);
      i += 1;
    }
  }
  // Sentinel so a match ending at the last character can resolve its end.
  map.push(text.length);
  return { decoded, map };
}

/**
 * Peel percent-encoding until it stops changing, under a WORK budget
 * (#2024, Codex r1 and r2).
 *
 * Two wrong answers preceded this one, and both are worth naming because the
 * second looked principled.
 *
 * r1: a single pass. `%2530%2578…` decodes once to `%30%78…` — still encoded,
 * still matching nothing — so the text came back untouched and a recipient
 * recovered the address with a second decode.
 *
 * r2: a fixed depth of 8, justified by "each escape costs three characters and
 * yields one, so a level shrinks the text threefold". That reasoning is FALSE
 * for selective encoding. Encode only the two `%` signs at each outer level and
 * the string grows by four characters per level, so nine levels fit in 78
 * characters, outlast a depth cap, and leak.
 *
 * So the loop runs to a fixpoint and the limit is a budget on characters
 * PROCESSED rather than on depth — depth is the thing an attacker controls
 * cheaply, length is not. If the budget runs out with escapes still present,
 * the caller FAILS CLOSED: it cannot show that nothing is hidden, so it stops
 * claiming to.
 */
const DECODE_WORK_PER_CHAR = 8;
const DECODE_WORK_FLOOR = 1024;

/**
 * A run of percent-escapes TOGETHER with any hex clinging to either side —
 * used only by the two fail-closed paths (#2024, Codex r5 P1).
 *
 * Dropping the escapes alone was not fail-closed, it was fail-open with a
 * tidier appearance. `%30%78` followed by forty plain hex digits is only the
 * `0x` escaped, so removing the run left `…1234567890abcdef…` — every digit of
 * the address, on a PUBLIC issue, one fixed two-character prefix from being
 * whole. Verified before the fix, on both the oversized branch and the
 * budget-exhaustion branch.
 *
 * The lesson generalises past that one spelling: the address can be split
 * anywhere, so ANY hex touching a removed escape may be the remainder of one,
 * and there is no length below which the leftover is safe. So the deletion
 * takes the adjacent payload with it.
 *
 * What that costs is hex-spelled words next to an escape — `%20decade` becomes
 * a single ellipsis. Only these two already-lossy branches pay it: one has
 * given up on reading past 64 KB, the other on resolving the escapes at all.
 * Losing a word beats publishing an account.
 *
 * EXPRESSING IT AS ONE REGEX IS THE BUG (Codex r5 fix, r6 P2). Writing it
 * `[a-fA-F0-9]*(?:%[0-9a-fA-F]{2})+[a-fA-F0-9]*` reads correctly and is
 * quadratic: on hex-only text with no escape to find, the leading `*` consumes
 * to the end and backtracks a character at a time, from every start position.
 * Measured on 64 KB of `a`: 6850 ms, versus 1 ms for the anchored pattern. The
 * fallback exists to keep an attacker-controlled provider error from freezing
 * the Support drawer, so hanging it there is self-defeating.
 *
 * The pattern below therefore only ever anchors on a literal `%`, and the
 * adjacent hex is taken by an explicit scan that cannot revisit consumed text.
 */
const ESCAPE_RUN_RE = /(?:%[0-9a-fA-F]{2})+/g;
/**
 * The alphabet the adjacency scan consumes: hex, PLUS a literal `x`/`X`
 * (#2024, Codex r7 P1).
 *
 * Hex alone left a hole one character wide. `%30x` spells the same prefix as
 * `%30%78` with only the zero escaped, so deleting the run stopped at the
 * literal `x` and forwarded `…x1234567890abcdef…` — every digit of the
 * account plus the `x`, recoverable by prepending a fixed `0`. The prefix
 * alphabet is `0`, `x` and `X`; two of the three were already hex, and the
 * third is why this is not simply `[a-fA-F0-9]`.
 *
 * Cost is small and local to the two fail-closed branches: a word beginning
 * with `x` next to an escape loses that letter. It cannot run away — `x` is a
 * single character in an otherwise-hex run.
 */
const HEX_CHAR_RE = /[a-fA-F0-9xX]/;

/**
 * Replace every escape run — plus the hex touching either side — with one
 * ellipsis, in linear time.
 *
 * Each backward scan stops at `cursor`, which only ever advances, so the two
 * scans together touch each character at most once. A later match cannot begin
 * inside a span already swallowed: the forward scan consumes only hex, and a
 * match begins with `%`, which is not hex.
 */
function dropEscapeRunsWithHex(text: string): string {
  let out = '';
  let cursor = 0;
  for (const m of text.matchAll(ESCAPE_RUN_RE)) {
    let from = m.index;
    let to = from + m[0].length;
    while (from > cursor && HEX_CHAR_RE.test(text[from - 1]!)) from -= 1;
    while (to < text.length && HEX_CHAR_RE.test(text[to]!)) to += 1;
    out += `${text.slice(cursor, from)}…`;
    cursor = to;
  }
  return out + text.slice(cursor);
}

/**
 * Decode to a fixpoint, reporting whether the budget was exhausted first.
 *
 * ONLY THE FIXPOINT IS SEARCHED, and that is a correctness property rather
 * than an economy (Codex r2's second finding). An address that is literal at
 * any level contains no escapes, so every later pass leaves it untouched and
 * it is still present at the fixpoint — searching intermediate levels can
 * therefore find nothing the fixpoint misses. It can, however, find things
 * that are NOT there: a transaction hash whose first 42 characters are encoded
 * once and whose tail is encoded twice shows an apparent 20-byte address at
 * level one, and the negative lookahead accepts it because the next character
 * is `%`. At the fixpoint the same span is a 64-hex run and is correctly
 * rejected. Scanning every level recorded that false match and nothing
 * withdrew it.
 */
function decodeToFixpoint(text: string): {
  text: string;
  map: number[];
  exhausted: boolean;
} {
  let current = text;
  // Identity map into the original, with the same end sentinel decodeWithMap
  // produces so composition stays total.
  let currentMap = Array.from({ length: text.length + 1 }, (_, i) => i);
  let budget = text.length * DECODE_WORK_PER_CHAR + DECODE_WORK_FLOOR;
  for (;;) {
    if (budget < current.length) {
      return { text: current, map: currentMap, exhausted: current.includes('%') };
    }
    budget -= current.length;
    const { decoded, map } = decodeWithMap(current);
    if (decoded === current) return { text: current, map: currentMap, exhausted: false };
    currentMap = map.map((p) => currentMap[p]!);
    current = decoded;
  }
}

/**
 * Above this, the index map is not built at all (#2024, Codex r2 P2).
 *
 * `redactCap` redacts BEFORE capping — deliberately, since capping first
 * strands a partial address the scrubber no longer recognises — so a caught
 * provider error of several megabytes arrives here whole even though the
 * caller keeps 1,200 characters of it. Building a per-character map over that,
 * once per decoding pass, measured ~3.8 s and would leave the Support drawer
 * unusable exactly after the kind of failure someone wants to report.
 *
 * Beyond the ceiling the function stops at it: only the first 64 KB is scanned
 * at all, and the result is marked truncated. Dropping the map was not enough
 * on its own (#2024, Codex r4 P2) — a message whose escapes are SEPARATED by
 * ordinary characters, `%25x` repeated, cannot collapse into one run, so the
 * two regex passes still materialised an output half the size of the whole
 * uncapped input. Measured here: 20 million characters took 3.6 s and 360 MB
 * of heap to produce 10 million characters, of which the caller keeps at most
 * 1,200 — a frozen Support drawer, again exactly after the failure someone
 * wants to report. Bounding the input makes the same case 24 ms.
 *
 * Within the ceiling the pass stays fail-closed — literal addresses are
 * shortened by regex and every escape run is dropped unread, so nothing can
 * hide in an escape that is no longer there. What it costs is escape fidelity,
 * and now content, in a message far past anything a report will keep: every
 * caller caps at 1,200 characters or fewer.
 */
export const MAX_MAPPED_INPUT = 64 * 1024;

/** Characters an address can be spelled with, escapes included. */
const ADDRESS_CHAR_RE = /[0-9a-fA-FxX%]/;

/**
 * Move the 64 KB cut back off anything that could be part of an address —
 * BEFORE any shortening runs (#2024, r12 P1).
 *
 * SIX VERSIONS OF A POST-HOC REPAIR FAILED HERE, and the reason is structural
 * rather than a run of oversights. Repairing after shortening means asking "is
 * this span my own output or the user's text?", and that had to be inferred
 * from shape — a question about text an attacker writes. Every answer was
 * defeated by a sharper spelling: must-end-in-hex, then
 * strip-the-stranded-escape, then contains-an-ellipsis, then
 * starts-like-a-shortening, then the-last-prefix-is-the-fragment, then
 * `0x1234…5678-` followed by the remaining digits — a fabricated shortening
 * with one separator after it, which the shape assertion accepted while every
 * digit of the account rode along behind.
 *
 * Ordering removes the question instead of answering it better. Cutting on the
 * RAW slice means nothing in it came from this module: a run of
 * address-spellable characters at the end is unredacted input, and dropping it
 * needs no judgement about who wrote it. Shortening then runs on text whose end
 * cannot bisect an address, and there is no repair pass at all.
 *
 * THE SCAN IS NOT WINDOWED (r13 P1). It was, at 48 characters, on the
 * arithmetic that an address is 42 so one straddling the cut has at most 41
 * inside. That counts the address, not its SPELLING: percent-encoding makes a
 * single nibble arbitrarily long, so a 30-level encoded digit ran past the
 * window, the scan stopped inside the run at the floor, and 38 literal digits
 * stayed behind it with their EIP-55 casing. A bound expressed in the units of
 * the plaintext cannot bound the encoded form.
 *
 * So the scan walks the whole run. It stays linear — each character is tested
 * once — and it terminates at the first character an address cannot be spelled
 * with, which ordinary prose supplies constantly (a space, a newline, a colon).
 *
 * The cost, stated because it is real and is now unbounded rather than capped
 * at 48: a COMPLETE address ending exactly at the cut is dropped rather than
 * shortened, and text whose tail is one unbroken run of hex, `x` and `%` loses
 * that entire run — in the pathological limit, a 64 KB message containing no
 * other character keeps nothing. That is over-redaction at the tail of a
 * message already being truncated, and it is the side to err on: the
 * alternative is publishing the front of an account.
 */
function truncateAtSafeBoundary(sliced: string): string {
  let cut = sliced.length;
  while (cut > 0 && ADDRESS_CHAR_RE.test(sliced[cut - 1]!)) cut -= 1;
  return sliced.slice(0, cut);
}

/** Scrub any full address ANYWHERE in report text — crash messages,
 *  component stacks, and deep-link paths routinely embed the
 *  connected account, and the redaction contract covers the whole
 *  public report, not just the wallet row. Applied to the finished
 *  body/title so future fields can't reintroduce a leak; exported so
 *  the drawer's ON-SCREEN error row honours the same contract. */
export function redactText(text: string): string {
  // THE SIZE BOUND COMES FIRST, ahead of the no-escape fast path (Codex r6
  // P2). That path is the common one and is cheap per character, which is why
  // it sat above the ceiling and quietly escaped it: a provider error of 21.5
  // million characters carrying nothing but literal addresses still built six
  // million characters of output, ~119 MB, for a caller that keeps 1,200. A
  // ceiling that the ordinary path can step around is not a ceiling.
  if (text.length > MAX_MAPPED_INPUT) {
    // Escape runs go FIRST so nothing hides behind them, then literals are
    // shortened. A hash whose tail was escaped now reads as an address and is
    // shortened too: with the tail unread there is no way to tell, and losing
    // a hash to over-redaction is the right side of that trade.
    // Truncate first, shorten second — the ordering IS the fix (r12 P1).
    const safe = truncateAtSafeBoundary(text.slice(0, MAX_MAPPED_INPUT));
    return `${shortenAddresses(dropEscapeRunsWithHex(safe))}…`;
  }

  // No escapes means the text IS its own fixpoint, so the cheap pass is the
  // whole job — and this is the overwhelmingly common case.
  if (!text.includes('%')) return shortenAddresses(text);

  // NO EAGER LITERAL PASS (Codex r3 P2). Shortening literals before the
  // fixpoint corrupts a hash whose head is literal and whose tail is escaped:
  // `0x` + 40 hex followed by `%` satisfies the negative lookahead, so the
  // head reads as an address and is replaced before decoding could reveal the
  // 64-hex run. A literal address needs no pre-pass anyway — it carries no
  // escapes, so it is still literal at the fixpoint and is found there.
  const final = decodeToFixpoint(text);
  if (final.exhausted) {
    // FAIL CLOSED. The budget ran out with escapes unresolved, so this cannot
    // demonstrate that no address is hidden in them — and on a report that
    // opens a PUBLIC issue, "probably fine" is not the standard. Literals are
    // handled here explicitly, since the pre-pass above is gone.
    return shortenAddresses(dropEscapeRunsWithHex(text));
  }

  // Splice onto the ORIGINAL spans so everything the redaction does not need
  // to touch keeps its exact spelling. `matchAll` yields disjoint matches over
  // one string, so no overlap arithmetic is needed.
  let out = '';
  let cursor = 0;
  for (const span of addressSpans(final.text)) {
    const from = final.map[span.index];
    const to = final.map[span.index + span.text.length];
    if (from === undefined || to === undefined || to <= from || from < cursor) continue;
    out += text.slice(cursor, from) + shortenMatch(span.text);
    cursor = to;
  }
  return out + text.slice(cursor);
}

/** Redact FIRST, then cap: truncation that cuts through an address
 *  would leave a partial hex string the whole-text scrubber no longer
 *  recognises (round 2) — free text must be scrubbed while intact.
 *  Exported for the drawer's on-screen last-error row (round 6). */
export function redactCap(text: string, max: number): string {
  return cap(redactText(text), max);
}

function cap(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
