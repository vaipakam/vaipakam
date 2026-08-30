/**
 * Pre-filled GitHub issue URL for the Support drawer (#1028 item 4).
 *
 * Lightweight port of defi's buildGithubIssueUrl with the same
 * redaction contract, minus the journey buffer:
 *   - wallet address is SHORTENED to 0x1234…abcd — the full address
 *     never leaves the device via a report;
 *   - error text is length-capped;
 *   - no user agent, no cookies, no storage contents.
 * The report carries exactly what the drawer SHOWS the user: page,
 * network, connection statuses, build, and the last recorded error.
 */
import type { LastError } from './lastError';

const DEFAULT_ISSUES_URL = 'https://github.com/vaipakam/vaipakam/issues/new';
/** Keep well under browser/GitHub URL limits (defi caps at 7000). */
const MAX_URL_LEN = 7000;
const MAX_ERROR_CHARS = 1200;
const MAX_STACK_CHARS = 1000;

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

/** A run of percent-escapes, used only by the fail-closed path. */
const ESCAPE_RUN_RE = /(?:%[0-9a-fA-F]{2})+/g;

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
  // No escapes means the text IS its own fixpoint, so the cheap pass is the
  // whole job — and this is the overwhelmingly common case.
  if (!text.includes('%')) return text.replace(ADDRESS_RE, shortenMatch);

  if (text.length > MAX_MAPPED_INPUT) {
    // Escape runs go FIRST so nothing hides behind them, then literals are
    // shortened. A hash whose tail was escaped now reads as an address and is
    // shortened too: with the tail unread there is no way to tell, and losing
    // a hash to over-redaction is the right side of that trade.
    const head = text
      .slice(0, MAX_MAPPED_INPUT)
      .replace(ESCAPE_RUN_RE, '…')
      .replace(ADDRESS_RE, shortenMatch);
    return `${head.replace(TRAILING_HEX_FRAGMENT_RE, '')}…`;
  }

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
    return text.replace(ESCAPE_RUN_RE, '…').replace(ADDRESS_RE, shortenMatch);
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

/** Paths are user-navigable input (deep links, 404s) — bound them so
 *  the final no-error fallback stays provably under MAX_URL_LEN. */
const MAX_PATH_CHARS = 200;

export interface ReportContext {
  path: string;
  /** The network line EXACTLY as the drawer shows it — including the
   *  unsupported-wallet-network wording when that's the state (the
   *  report must carry what the panel showed, round 5). */
  networkLine: string;
  walletRedacted: string;
  rpcStatusLine: string;
  indexerStatusLine: string;
  buildHash: string;
  buildTime: string | undefined;
  lastError: LastError | null;
}

function issuesBase(): string {
  const env = import.meta.env.VITE_GITHUB_ISSUES_URL as string | undefined;
  return env || DEFAULT_ISSUES_URL;
}

function cap(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** The diagnostics section shared by the clipboard copy and the issue
 *  form's "Additional context" field. */
function buildDiagnosticsBlock(ctx: ReportContext): string {
  const lines = [
    '### App-collected details',
    '',
    `- Page: \`${redactCap(ctx.path, MAX_PATH_CHARS)}\``,
    `- Network: ${ctx.networkLine}`,
    `- Wallet: ${ctx.walletRedacted}`,
    `- Blockchain connection: ${ctx.rpcStatusLine}`,
    `- Market data cache: ${ctx.indexerStatusLine}`,
    `- Build: ${ctx.buildHash}${ctx.buildTime ? ` (${ctx.buildTime})` : ''}`,
  ];
  if (ctx.lastError) {
    lines.push(
      '',
      '### Last error recorded on the device',
      '',
      `At ${new Date(ctx.lastError.at).toISOString()} on \`${redactCap(ctx.lastError.path, MAX_PATH_CHARS)}\`:`,
      '',
      '```',
      redactCap(ctx.lastError.message, MAX_ERROR_CHARS),
      '```',
    );
    if (ctx.lastError.componentStack) {
      lines.push(
        '',
        '<details><summary>Component stack</summary>',
        '',
        '```',
        redactCap(ctx.lastError.componentStack, MAX_STACK_CHARS),
        '```',
        '',
        '</details>',
      );
    }
  }
  // Redact the FINISHED text — error messages, stacks, and paths can
  // all embed the connected account.
  return redactText(lines.join('\n'));
}

export function buildReportBody(ctx: ReportContext): string {
  return [
    '### What happened?',
    '',
    '_Please describe what you were doing and what you expected._',
    '',
    buildDiagnosticsBlock(ctx),
  ].join('\n');
}

/** Targets the repo's Bug issue FORM (blank issues are disabled —
 *  a bare /issues/new lands users in the template chooser and drops
 *  every pre-filled param, round 6). Form fields are pre-filled by
 *  their ids: `surface`/`chain`/`env` from the drawer context and the
 *  whole diagnostics block into `extra` ("Additional context: logs
 *  from the diagnostics drawer" — its stated purpose). The user
 *  writes repro/expected/actual/severity — those are their story. */
export function buildIssueUrl(ctx: ReportContext): string {
  const title = redactText(
    `[Bug] app problem report — ${redactCap(ctx.path, MAX_PATH_CHARS)}${
      ctx.lastError ? ` (${redactCap(ctx.lastError.message, 60)})` : ''
    }`,
  );
  const params = new URLSearchParams({
    template: 'bug.yml',
    title,
    surface: redactCap(`apps/app — ${ctx.path}`, MAX_PATH_CHARS),
    chain: ctx.networkLine,
    env: `Build ${ctx.buildHash}${ctx.buildTime ? ` (${ctx.buildTime})` : ''}; wallet ${ctx.walletRedacted}`,
    extra: buildDiagnosticsBlock(ctx),
  });
  let url = `${issuesBase()}?${params.toString()}`;
  if (url.length > MAX_URL_LEN) {
    // Drop the stack first, then the whole error block — the drawer's
    // Copy-details path still carries the full text.
    const withoutStack = {
      ...ctx,
      lastError: ctx.lastError ? { ...ctx.lastError, componentStack: undefined } : null,
    };
    params.set('extra', buildDiagnosticsBlock(withoutStack));
    url = `${issuesBase()}?${params.toString()}`;
    if (url.length > MAX_URL_LEN) {
      params.set('extra', buildDiagnosticsBlock({ ...ctx, lastError: null }));
      url = `${issuesBase()}?${params.toString()}`;
    }
  }
  return url;
}
