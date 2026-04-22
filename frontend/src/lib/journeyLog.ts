/**
 * Frontend user-journey diagnostics buffer.
 *
 * Implements the "Troubleshooting And Observability" spec
 * (docs/WebsiteReadme.md §) — every important action path emits
 * `start` / `success` / `failure` events so support can reconstruct what the
 * user did before hitting an error. Events live in a capped ring buffer
 * (in-memory + sessionStorage mirror) and can be exported via
 * `exportDiagnostics()` from the footer's Diagnostics drawer.
 *
 * Redaction: we capture wallet addresses and error messages verbatim, but
 * nothing else (no private keys, no signatures, no RPC payloads). Export
 * truncates addresses to `0x…abcd` form so support tickets don't leak a
 * full wallet unless the user re-types it.
 */
import { decodeContractError, extractRevertData, extractRevertSelector, namedRevertSelector } from './decodeContractError';
import { getChainByChainId } from '../contracts/config';

export type JourneyArea =
  | 'wallet'
  | 'offer-create'
  | 'offer-accept'
  | 'offer-cancel'
  | 'offer-book'
  | 'loan-view'
  | 'repay'
  | 'add-collateral'
  | 'claim'
  | 'liquidation'
  | 'preclose'
  | 'refinance'
  | 'early-withdrawal'
  | 'nft-verifier'
  | 'log-index'
  | 'dashboard'
  | 'profile'
  | 'vpfi-buy'
  | 'keeper'
  | 'config'
  | 'rewards'
  | 'escrow-upgrade';

export type JourneyStatus = 'start' | 'success' | 'failure' | 'info';

export type ErrorType =
  | 'wallet'           // rejected, locked, wrong chain
  | 'contract-revert'  // on-chain revert with decodable reason
  | 'rpc'              // network/RPC transport failure
  | 'validation'       // client-side form/precondition failure
  | 'unknown';

export interface JourneyEvent {
  id: string;                // random per-event id; used to correlate start→success/failure pairs
  correlationId?: string;    // set on success/failure to point back to the paired start
  timestamp: number;         // Date.now()
  area: JourneyArea;
  flow: string;              // e.g. "createLenderOffer"
  step: string;              // e.g. "approveCollateral", "submitTx"
  status: JourneyStatus;
  wallet?: string | null;
  chainId?: number | null;
  loanId?: string;
  offerId?: string;
  nftId?: string;
  role?: 'lender' | 'borrower';
  errorType?: ErrorType;
  errorMessage?: string;
  errorSelector?: string;    // 4-byte revert selector (0x + 8 hex), when available
  errorName?: string;        // resolved custom-error name, if the selector matches a known entry
  errorData?: string;        // full raw revert data (0x…) for off-line decoding
  note?: string;             // optional free-form extra context (never secrets)
}

const BUFFER_SIZE = 200;
const STORAGE_KEY = 'vaipakam.journey';

let buffer: JourneyEvent[] = loadFromStorage();
const listeners = new Set<(events: JourneyEvent[]) => void>();

function loadFromStorage(): JourneyEvent[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.slice(-BUFFER_SIZE) : [];
  } catch {
    return [];
  }
}

function persist() {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(buffer));
  } catch {
    // sessionStorage disabled / full — keep in-memory copy only
  }
}

function notify() {
  const snapshot = buffer.slice();
  for (const l of listeners) l(snapshot);
}

function randomId(): string {
  // Short opaque id; avoids pulling in a uuid dep for a debug aid.
  return Math.random().toString(36).slice(2, 10);
}

export function subscribe(cb: (events: JourneyEvent[]) => void): () => void {
  listeners.add(cb);
  cb(buffer.slice());
  return () => {
    listeners.delete(cb);
  };
}

export function getEvents(): JourneyEvent[] {
  return buffer.slice();
}

export function clearJourney() {
  buffer = [];
  persist();
  notify();
}

export interface EmitInput {
  area: JourneyArea;
  flow: string;
  step: string;
  status: JourneyStatus;
  wallet?: string | null;
  chainId?: number | null;
  loanId?: string | number | bigint;
  offerId?: string | number | bigint;
  nftId?: string | number | bigint;
  role?: 'lender' | 'borrower';
  errorType?: ErrorType;
  errorMessage?: string;
  errorSelector?: string;
  errorName?: string;
  errorData?: string;
  note?: string;
  correlationId?: string;
}

export function emit(input: EmitInput): JourneyEvent {
  const ev: JourneyEvent = {
    id: randomId(),
    correlationId: input.correlationId,
    timestamp: Date.now(),
    area: input.area,
    flow: input.flow,
    step: input.step,
    status: input.status,
    wallet: input.wallet ?? null,
    chainId: input.chainId ?? null,
    loanId: input.loanId !== undefined ? String(input.loanId) : undefined,
    offerId: input.offerId !== undefined ? String(input.offerId) : undefined,
    nftId: input.nftId !== undefined ? String(input.nftId) : undefined,
    role: input.role,
    errorType: input.errorType,
    errorMessage: input.errorMessage,
    errorSelector: input.errorSelector,
    errorName: input.errorName,
    errorData: input.errorData,
    note: input.note,
  };
  buffer.push(ev);
  if (buffer.length > BUFFER_SIZE) buffer = buffer.slice(-BUFFER_SIZE);
  persist();
  notify();
  return ev;
}

/**
 * Helper that opens a step and returns callbacks to close it as success or
 * failure. Using `beginStep` keeps correlationIds consistent without callers
 * having to thread the id manually.
 */
export function beginStep(input: Omit<EmitInput, 'status'>): {
  correlationId: string;
  success: (extra?: Partial<EmitInput>) => void;
  failure: (err: unknown, extra?: Partial<EmitInput>) => void;
} {
  const start = emit({ ...input, status: 'start' });
  return {
    correlationId: start.id,
    success: (extra) =>
      emit({ ...input, ...extra, status: 'success', correlationId: start.id }),
    failure: (err, extra) => {
      const { type, message } = classifyError(err);
      const selector = extractRevertSelector(err);
      const named = namedRevertSelector(err);
      const data = extractRevertData(err);
      emit({
        ...input,
        ...extra,
        status: 'failure',
        errorType: extra?.errorType ?? type,
        errorMessage: extra?.errorMessage ?? message,
        errorSelector: extra?.errorSelector ?? selector,
        errorName: extra?.errorName ?? (named && named !== selector ? named : undefined),
        errorData: extra?.errorData ?? data,
        correlationId: start.id,
      });
    },
  };
}

/**
 * Classifies a thrown error into one of the spec's categories.
 * Wallet rejections (EIP-1193 code 4001) and method-not-found (4100) are
 * recognised explicitly; everything else falls through to contract-revert
 * when we have a decoded reason, RPC when there's a network hint, and
 * unknown otherwise. Validation errors should be emitted by callers directly
 * rather than routed through this helper.
 */
export function classifyError(err: unknown): {
  type: ErrorType;
  message: string;
} {
  if (err && typeof err === 'object') {
    const e = err as {
      code?: number | string;
      reason?: string;
      shortMessage?: string;
      message?: string;
      data?: { message?: string };
    };
    if (e.code === 4001 || e.code === 'ACTION_REJECTED') {
      return { type: 'wallet', message: 'User rejected the request.' };
    }
    if (e.code === 4100 || e.code === -32601) {
      return { type: 'wallet', message: e.message ?? 'Wallet method unavailable.' };
    }
    if (e.code === -32002) {
      return { type: 'wallet', message: 'Wallet request already pending.' };
    }
    if (e.reason || e.shortMessage) {
      return { type: 'contract-revert', message: decodeContractError(err) };
    }
    if (typeof e.code === 'string' && /NETWORK|TIMEOUT|SERVER/.test(e.code)) {
      return { type: 'rpc', message: decodeContractError(err) };
    }
  }
  return { type: 'unknown', message: decodeContractError(err) };
}

function redactAddress(addr: string | null | undefined): string | null {
  if (!addr) return null;
  if (addr.length < 10) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

/**
 * Per-report opaque identifier so a JSON attachment and a GitHub issue body
 * can be cross-referenced by support without anything identifying the user.
 * Persisted across a single tab's lifetime so a user who copies JSON, then
 * clicks "Report on GitHub" a few seconds later, gets the SAME id in both.
 */
let activeReportId: string | null = null;
function reportId(): string {
  if (!activeReportId) {
    activeReportId = Math.random().toString(36).slice(2, 10);
  }
  return activeReportId;
}
/**
 * Fresh report id on the next export — called when the user clears the
 * journey buffer so the next ticket gets a new correlation key.
 */
export function resetReportId() {
  activeReportId = null;
}

/**
 * Builds a support-friendly JSON blob. Addresses are shortened; the rest of
 * the payload is left as-is so engineers can correlate with on-chain events.
 */
export function exportDiagnostics(): string {
  const payload = {
    reportId: reportId(),
    exportedAt: new Date().toISOString(),
    userAgent: typeof navigator === 'undefined' ? 'unknown' : navigator.userAgent,
    events: buffer.map((ev) => ({
      ...ev,
      wallet: redactAddress(ev.wallet),
    })),
  };
  return JSON.stringify(payload, null, 2);
}

/** Reads `chainId` directly off the injected provider (e.g. MetaMask)
 *  without needing the WalletContext. Returns null in SSR / when the user
 *  has no injected wallet. MetaMask exposes `chainId` as a `0x`-hex string,
 *  so we parse it. A missing value falls through to null and the caller
 *  treats it as "not-connected". */
function readProviderChainId(): number | null {
  if (typeof window === 'undefined') return null;
  const eth = (window as unknown as { ethereum?: { chainId?: string | number } }).ethereum;
  if (!eth || eth.chainId == null) return null;
  if (typeof eth.chainId === 'number') return eth.chainId;
  const parsed = Number(eth.chainId);
  return Number.isFinite(parsed) ? parsed : null;
}

const MAX_BODY_LEN = 6_000; // keep GitHub issue URL under its practical limit
const MAX_EVENTS_IN_ISSUE = 20;
/** How many events to include on either side of the most-recent failure
 *  when the buffer contains one. The error itself is always included.
 *  Picked so the lead-up (15) is long enough to see what the user was
 *  doing before the revert, and the tail (5) captures any retry or
 *  cascaded failures the app emitted after the initial error. */
const EVENTS_BEFORE_FAILURE = 15;
const EVENTS_AFTER_FAILURE = 5;
const VAIPAKAM_ISSUES_URL = 'https://github.com/vaipakam/vaipakam/issues/new';

const TX_HASH_RE = /\b0x[0-9a-fA-F]{64}\b/;

/**
 * Pulls the first on-chain transaction hash out of a journey event's
 * free-form fields. The convention is that every success step for a
 * write action emits a `note: \`tx ${tx.hash}\`` string — see the
 * `beginStep().success({ note: ... })` call sites across the app
 * (BorrowerPreclose, CreateOffer, LoanDetails, ClaimCenter, etc.).
 * Falls back to `errorData` / `errorMessage` for post-submit failures
 * that still carry a mined hash (e.g. a revert we only learned about
 * when the receipt came back).
 * @return The `0x`-prefixed 64-hex tx hash, or `null` when the event
 *         isn't backed by an on-chain transaction.
 */
export function extractTxHash(ev: JourneyEvent): string | null {
  const match =
    TX_HASH_RE.exec(ev.note ?? '') ??
    TX_HASH_RE.exec(ev.errorData ?? '') ??
    TX_HASH_RE.exec(ev.errorMessage ?? '');
  return match ? match[0] : null;
}

/**
 * Last known transaction hash from the buffer — surfaced in the GitHub
 * issue body as the single most actionable on-chain pointer for the
 * triage team. Scans back from the end so the "most recent" tx
 * associated with whatever went wrong is what lands in the ticket.
 */
function mostRecentTxHash(): string | null {
  for (let i = buffer.length - 1; i >= 0; i--) {
    const hash = extractTxHash(buffer[i]);
    if (hash) return hash;
  }
  return null;
}

/**
 * Summarises ONE event as a single safe-to-publish line. Never includes:
 *   - full wallet addresses (always redacted to `0x…abcd`)
 *   - the free-form `note` or `errorMessage` fields verbatim — those can
 *     rarely contain user-entered copy; only the first 140 chars are kept,
 *     control chars stripped, pipe chars escaped (so a Markdown table the
 *     triage team builds later stays intact).
 */
function eventToIssueLine(ev: JourneyEvent): string {
  const parts: string[] = [];
  // ISO-8601 UTC timestamp as the first field so triage can correlate the
  // event order and measure gaps between retries without having to open the
  // downloadable JSON. Falls back to a placeholder if the buffer entry
  // somehow lacks `timestamp` (defensive — every call site sets it).
  const ts = ev.timestamp ? new Date(ev.timestamp).toISOString() : '????-??-??T??:??:??.???Z';
  parts.push(`\`${ts}\``);
  parts.push(`\`${ev.status}\``);
  parts.push(`${ev.area}/${ev.flow}`);
  if (ev.step) parts.push(`step=${ev.step}`);
  if (ev.loanId) parts.push(`loan #${ev.loanId}`);
  if (ev.offerId) parts.push(`offer #${ev.offerId}`);
  if (ev.chainId != null) parts.push(`chain ${ev.chainId}`);
  if (ev.errorName && ev.errorName !== ev.errorSelector) parts.push(`error=${ev.errorName}`);
  else if (ev.errorSelector) parts.push(`selector=${ev.errorSelector}`);
  if (ev.errorType) parts.push(`type=${ev.errorType}`);
  // Error messages sometimes embed user-entered strings (e.g. bad address
  // input echoed back). Truncate + strip control chars + escape pipes so
  // nothing downstream can break or smuggle hidden markdown.
  if (ev.errorMessage) {
    // Strip ASCII control chars (C0 set) via their code points so eslint's
    // no-control-regex doesn't flag the pattern, and escape markdown-breaking
    // backticks and pipes so downstream triage tables stay intact.
    const safe = ev.errorMessage
      .replace(/[|`]/g, (c) => '\\' + c)
      .split('')
      .filter((c) => c.charCodeAt(0) >= 0x20)
      .join('')
      .slice(0, 140);
    parts.push(`msg="${safe}"`);
  }
  return `- ${parts.join(' · ')}`;
}

/**
 * Generates a `github.com/.../issues/new?title=…&body=…` URL prefilled with
 * a redacted summary the user can publish directly to the Vaipakam issue
 * tracker. The body includes:
 *   - an opaque `reportId` that also appears in the downloadable JSON so a
 *     user who attaches the JSON on the same ticket can be correlated
 *   - the most recent 64-hex transaction hash seen in the buffer (if any)
 *   - the last N events, redacted to `area/flow/step + error selector/name`
 *   - no full wallet addresses, no user-entered free-form text, no userAgent
 */
export function buildGithubIssueUrl(): string {
  const id = reportId();
  const wallet =
    redactAddress(
      buffer.find((e) => e.wallet)?.wallet ?? null,
    ) ?? 'not-connected';
  const tx = mostRecentTxHash();
  // Newest chainId seen in the buffer. Walk in reverse so a user who
  // switched networks mid-session gets the chain that was active when the
  // failure surfaced, not the first one we ever saw. Most read-path events
  // (dashboard hooks, log-index scans) don't attach chainId today, so we
  // fall back to the injected-provider's current chainId — that's the chain
  // the RPC calls in this session are actually hitting.
  const chainIdSeen =
    [...buffer].reverse().find((e) => e.chainId != null)?.chainId ?? readProviderChainId();
  const chainConfig = getChainByChainId(chainIdSeen);
  const chainLabel = chainIdSeen == null
    ? 'not-connected'
    : chainConfig
      ? `${chainConfig.name} (chainId ${chainIdSeen})`
      : `unknown (chainId ${chainIdSeen})`;
  const lastFailureIdx = buffer.findLastIndex((e) => e.status === 'failure');
  const lastFailure = lastFailureIdx >= 0 ? buffer[lastFailureIdx] : null;
  const title = lastFailure
    ? `[bug] ${lastFailure.area}/${lastFailure.flow} — ${
        lastFailure.errorName ?? lastFailure.errorType ?? 'failure'
      } (report ${id})`
    : `[diag] session report ${id}`;

  const header = [
    `**Report ID:** \`${id}\``,
    `**Wallet (redacted):** \`${wallet}\``,
    `**Chain:** \`${chainLabel}\``,
    tx ? `**Last tx hash:** \`${tx}\`` : null,
    `**Generated:** ${new Date().toISOString()}`,
    '',
    '> Auto-generated by the Vaipakam diagnostics drawer. No personal',
    '> information is published: wallet addresses are shortened to',
    '> `0x…abcd`, free-form error text is truncated to 140 chars, the',
    '> browser user-agent is NOT included. If support asks for more detail,',
    '> they can request the full diagnostics JSON (contains the same',
    '> `reportId` as this issue).',
    '',
    '### What happened?',
    '<!-- Please describe in your own words what you were trying to do. -->',
    '',
    '### Recent events',
    '',
  ].filter((l) => l != null).join('\n');

  // Window the event list around the failure so the issue body always shows
  // the error itself plus context. Just taking the last N events can miss
  // the revert entirely when the UI emitted retries or follow-up reads
  // after the failure — pushing the original error out of the tail. When a
  // failure exists we take the 15 events before it, the failure itself,
  // and up to the next 5. Falls back to the tail slice when there's no
  // failure in the buffer (pure "diag" report).
  const windowStart = lastFailureIdx >= 0
    ? Math.max(0, lastFailureIdx - EVENTS_BEFORE_FAILURE)
    : Math.max(0, buffer.length - MAX_EVENTS_IN_ISSUE);
  const windowEnd = lastFailureIdx >= 0
    ? Math.min(buffer.length, lastFailureIdx + 1 + EVENTS_AFTER_FAILURE)
    : buffer.length;
  const recent = buffer
    .slice(windowStart, windowEnd)
    .map(eventToIssueLine)
    .join('\n');

  let body = header + recent;
  if (body.length > MAX_BODY_LEN) {
    body =
      body.slice(0, MAX_BODY_LEN - 80) +
      '\n\n> _(truncated — attach full diagnostics JSON for complete log)_';
  }

  const params = new URLSearchParams({
    title,
    body,
    labels: 'bug,diagnostics',
  });
  return `${VAIPAKAM_ISSUES_URL}?${params.toString()}`;
}
