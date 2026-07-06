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
export function redactText(text: string): string {
  return text.replace(ADDRESS_RE, (m) => `${m.slice(0, 6)}…${m.slice(-4)}`);
}

/** Redact FIRST, then cap: truncation that cuts through an address
 *  would leave a partial hex string the whole-text scrubber no longer
 *  recognises (round 2) — free text must be scrubbed while intact. */
function redactCap(text: string, max: number): string {
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

export function buildReportBody(ctx: ReportContext): string {
  const lines = [
    '### What happened?',
    '',
    '_Please describe what you were doing and what you expected._',
    '',
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

export function buildIssueUrl(ctx: ReportContext): string {
  const title = redactText(
    `[alpha02] problem report — ${redactCap(ctx.path, MAX_PATH_CHARS)}${
      ctx.lastError ? ` (${redactCap(ctx.lastError.message, 60)})` : ''
    }`,
  );
  const params = new URLSearchParams({
    title,
    body: buildReportBody(ctx),
    labels: 'bug,diagnostics',
  });
  let url = `${issuesBase()}?${params.toString()}`;
  if (url.length > MAX_URL_LEN) {
    // Drop the stack first, then the whole error block — the drawer's
    // Copy-details path still carries the full text.
    const withoutStack = {
      ...ctx,
      lastError: ctx.lastError ? { ...ctx.lastError, componentStack: undefined } : null,
    };
    params.set('body', buildReportBody(withoutStack));
    url = `${issuesBase()}?${params.toString()}`;
    if (url.length > MAX_URL_LEN) {
      params.set('body', buildReportBody({ ...ctx, lastError: null }));
      url = `${issuesBase()}?${params.toString()}`;
    }
  }
  return url;
}
