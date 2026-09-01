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

/**
 * The redaction contract itself now lives in `@vaipakam/lib/redactAddresses`
 * (#2024, Codex r7 P1). It has to hold on the receiving service too — the
 * support-ticket endpoint accepts arbitrary JSON from any caller clearing the
 * Origin gate, and from cached older clients — and two copies of an algorithm
 * this fiddly would diverge at the next finding. Re-exported here so this
 * module's callers, and the drawer's on-screen error row, are unchanged.
 */
export {
  MAX_MAPPED_INPUT,
  redactAddress,
  redactCap,
  redactText,
} from '@vaipakam/lib/redactAddresses';
import { redactCap, redactText } from '@vaipakam/lib/redactAddresses';


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
export interface IssueReport {
  /** The pre-filled issue URL, after any length trimming. */
  readonly url: string;
  /** Exactly the field values that URL carries, after the same trimming. */
  readonly fields: {
    readonly title: string;
    readonly surface: string;
    readonly chain: string;
    readonly env: string;
    readonly extra: string;
  };
}

/**
 * The issue URL AND the field values it actually carries (#2043 round 3 P2).
 *
 * The two are returned together because they can differ from the untrimmed
 * report, and something has to preview what is genuinely sent. The ladder
 * below drops the component stack, then the whole error block, whenever the
 * encoded URL crosses `MAX_URL_LEN` — so on exactly the largest crashes, the
 * report GitHub receives is SHORTER than `buildReportBody`. A preview built
 * from the untrimmed body therefore showed content that would never travel,
 * which made the Privacy Policy's "displays exactly what would be sent" false
 * for the reports where the difference matters most.
 *
 * Returning the fields rather than re-deriving them in the drawer keeps the
 * two from drifting: there is one trimming decision and both the link and the
 * preview read its result.
 */
export function buildIssueReport(ctx: ReportContext): IssueReport {
  const title = redactText(
    `[Bug] app problem report — ${redactCap(ctx.path, MAX_PATH_CHARS)}${
      ctx.lastError ? ` (${redactCap(ctx.lastError.message, 60)})` : ''
    }`,
  );
  const surface = redactCap(`apps/app — ${ctx.path}`, MAX_PATH_CHARS);
  const env = `Build ${ctx.buildHash}${ctx.buildTime ? ` (${ctx.buildTime})` : ''}; wallet ${ctx.walletRedacted}`;
  const params = new URLSearchParams({
    template: 'bug.yml',
    title,
    surface,
    chain: ctx.networkLine,
    env,
    extra: buildDiagnosticsBlock(ctx),
  });
  let url = `${issuesBase()}?${params.toString()}`;
  if (url.length > MAX_URL_LEN) {
    // Drop the stack first, then the whole error block.
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
  return {
    url,
    fields: {
      title,
      surface,
      chain: ctx.networkLine,
      env,
      extra: params.get('extra') ?? '',
    },
  };
}

export function buildIssueUrl(ctx: ReportContext): string {
  return buildIssueReport(ctx).url;
}

/**
 * What the report link actually discloses, rendered for reading.
 *
 * Every field the pre-filled form carries, with the trimming already applied
 * — so the drawer's disclosure can honestly claim to show what GitHub
 * receives. `buildReportBody` is a different thing and stays: it is the
 * template a person copies to write their own report, and it carries a
 * "What happened?" prompt the URL does not.
 */
export function buildSentPreview(ctx: ReportContext): string {
  const { fields } = buildIssueReport(ctx);
  return [
    `Title: ${fields.title}`,
    `Surface: ${fields.surface}`,
    `Chain: ${fields.chain}`,
    `Env: ${fields.env}`,
    '',
    fields.extra,
  ].join('\n');
}
