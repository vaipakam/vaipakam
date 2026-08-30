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

/** Scrub any full address ANYWHERE in report text — crash messages,
 *  component stacks, and deep-link paths routinely embed the
 *  connected account, and the redaction contract covers the whole
 *  public report, not just the wallet row. Applied to the finished
 *  body/title so future fields can't reintroduce a leak; exported so
 *  the drawer's ON-SCREEN error row honours the same contract. */
/**
 * How many times to peel percent-encoding while looking for an address
 * (#2024, Codex r1).
 *
 * ONE PASS IS NOT ENOUGH, and I chose one anyway when filing this — the
 * mistake is worth naming. `%2530%2578…` decodes once to `%30%78…`, which is
 * still encoded and still matches nothing, so a single pass returns the text
 * untouched and the recipient recovers the address with a second decode.
 * Double-encoding is not exotic: it is what happens to a URL carried inside
 * another URL's query parameter.
 *
 * The bound is a formality rather than a real limit. Every escape costs three
 * characters and yields one, so each level shrinks the text roughly threefold
 * and the loop converges in a handful of steps for any input a browser could
 * hold; the loop also stops as soon as a pass changes nothing. The cap is
 * here so a crafted input cannot make that reasoning load-bearing.
 */
const MAX_DECODE_DEPTH = 8;

/** Each decoding level, with a map from ITS positions back to the original. */
function decodeLevels(text: string): { text: string; map: number[] }[] {
  const levels: { text: string; map: number[] }[] = [];
  let current = text;
  // Identity map into the original, with the same end sentinel decodeWithMap
  // produces so composition stays total.
  let currentMap = Array.from({ length: text.length + 1 }, (_, i) => i);
  for (let depth = 0; depth < MAX_DECODE_DEPTH; depth++) {
    const { decoded, map } = decodeWithMap(current);
    if (decoded === current) break;
    currentMap = map.map((p) => currentMap[p]!);
    current = decoded;
    levels.push({ text: current, map: currentMap });
  }
  return levels;
}

/** Scrub any full address ANYWHERE in report text — crash messages,
 *  component stacks, and deep-link paths routinely embed the
 *  connected account, and the redaction contract covers the whole
 *  public report, not just the wallet row. Applied to the finished
 *  body/title so future fields can't reintroduce a leak; exported so
 *  the drawer's ON-SCREEN error row honours the same contract. */
export function redactText(text: string): string {
  const plain = text.replace(ADDRESS_RE, shortenMatch);
  // Percent-escapes are the only way an address hides from the pass above,
  // so everything without one is finished here (#2024).
  if (!plain.includes('%')) return plain;

  // Collect the spans to redact in ORIGINAL coordinates, across every
  // decoding depth, so the splice keeps the rest of the text spelled exactly
  // as it arrived.
  const spans: { from: number; to: number; text: string }[] = [];
  for (const level of decodeLevels(plain)) {
    ADDRESS_RE.lastIndex = 0;
    for (const m of level.text.matchAll(ADDRESS_RE)) {
      const from = level.map[m.index];
      const to = level.map[m.index + m[0].length];
      if (from === undefined || to === undefined || to <= from) continue;
      spans.push({ from, to, text: shortenMatch(m[0]) });
    }
  }
  if (spans.length === 0) return plain;

  // One address can be found at several depths and map to the same original
  // span, and a shallower find can enclose a deeper one. Sort by start, widest
  // first, then keep only spans that do not overlap one already kept.
  spans.sort((a, b) => a.from - b.from || b.to - a.to);
  let out = '';
  let cursor = 0;
  for (const s of spans) {
    if (s.from < cursor) continue;
    out += plain.slice(cursor, s.from) + s.text;
    cursor = s.to;
  }
  return out + plain.slice(cursor);
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
