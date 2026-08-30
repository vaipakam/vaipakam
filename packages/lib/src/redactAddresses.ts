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
 */

export function redactAddress(address: string | undefined): string {
  if (!address) return 'not connected';
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

// Exactly 20 bytes: the negative lookahead stops the pattern from
// eating the first 40 hex chars of a 32-byte tx hash — support needs
// those hashes intact, and a mangled prefix would neither redact nor
// preserve anything useful (round 4). The prefix is case-insensitive:
// a pasted 0X-prefixed address must redact too (round 5).
const ADDRESS_RE = /0[xX][a-fA-F0-9]{40}(?![a-fA-F0-9])/g;

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

/**
 * A `0x`-prefixed hex run reaching the very end of the truncated head.
 *
 * The 64 KB cut can land in the middle of an address, and half an account
 * forwarded verbatim is not something this module should be relied on to
 * emit — the redact-before-cap ordering in `redactCap` exists to stop exactly
 * that shape. Dropping the boundary fragment costs a few characters of a
 * message that is already being truncated.
 */
const TRAILING_HEX_FRAGMENT_RE = /0[xX][a-fA-F0-9]*$/;

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
    const head = dropEscapeRunsWithHex(text.slice(0, MAX_MAPPED_INPUT)).replace(
      ADDRESS_RE,
      shortenMatch,
    );
    return `${head.replace(TRAILING_HEX_FRAGMENT_RE, '')}…`;
  }

  // No escapes means the text IS its own fixpoint, so the cheap pass is the
  // whole job — and this is the overwhelmingly common case.
  if (!text.includes('%')) return text.replace(ADDRESS_RE, shortenMatch);

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
    return dropEscapeRunsWithHex(text).replace(ADDRESS_RE, shortenMatch);
  }

  // Splice onto the ORIGINAL spans so everything the redaction does not need
  // to touch keeps its exact spelling. `matchAll` yields disjoint matches over
  // one string, so no overlap arithmetic is needed.
  ADDRESS_RE.lastIndex = 0;
  let out = '';
  let cursor = 0;
  for (const m of final.text.matchAll(ADDRESS_RE)) {
    const from = final.map[m.index];
    const to = final.map[m.index + m[0].length];
    if (from === undefined || to === undefined || to <= from) continue;
    out += text.slice(cursor, from) + shortenMatch(m[0]);
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
