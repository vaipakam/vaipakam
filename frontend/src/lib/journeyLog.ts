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
  | 'staking'
  | 'escrow-upgrade'
  | 'allowance'
  | 'alerts';

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
  /** Truncated `Error.stack` from the original throw — top frames only,
   *  control chars stripped. Captured automatically by
   *  `beginStep().failure()` so callers don't have to thread it. */
  errorStack?: string;
  /** Recursive walk of `Error.cause` at the time of the throw, each
   *  layer's `name: message`. Depth capped at 3 to keep URL length
   *  manageable. Useful when wrappers like `enrichFetchError` layer a
   *  more verbose error over the original network failure. */
  errorCauseChain?: string[];
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
  errorStack?: string;
  errorCauseChain?: string[];
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
    errorStack: input.errorStack,
    errorCauseChain: input.errorCauseChain,
    note: input.note,
  };
  buffer.push(ev);
  if (buffer.length > BUFFER_SIZE) buffer = buffer.slice(-BUFFER_SIZE);
  persist();
  notify();
  return ev;
}

/**
 * Truncate a JS Error.stack string to the top N frames + a header. Keeps
 * third-party `node_modules` frames so the call site that triggered the
 * throw is visible even when our own bundle is wrapped through ethers /
 * viem / wagmi internals. Returns undefined when the input doesn't look
 * like a stack trace.
 */
function extractStack(err: unknown, maxFrames = 15): string | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const stack = (err as { stack?: unknown }).stack;
  if (typeof stack !== 'string' || !stack) return undefined;
  // The first line is the error name + message; subsequent lines are
  // frames. Keep the header line + up to maxFrames frame lines.
  const lines = stack.split('\n');
  if (lines.length <= maxFrames + 1) return stack;
  return [...lines.slice(0, maxFrames + 1), `... (${lines.length - maxFrames - 1} more frames)`].join('\n');
}

/**
 * Walk `Error.cause` recursively up to `maxDepth` levels and return one
 * compact string per layer (`name: message`). Useful when wrappers like
 * `enrichFetchError` layer a more-verbose error over the original
 * network failure — the cause chain surfaces both.
 */
function extractCauseChain(err: unknown, maxDepth = 3): string[] | undefined {
  const chain: string[] = [];
  let current: unknown = err && typeof err === 'object' ? (err as { cause?: unknown }).cause : undefined;
  let depth = 0;
  while (current && depth < maxDepth) {
    const layer = current as { name?: string; message?: string };
    const name = layer.name ?? 'Error';
    const msg = layer.message ?? String(current).slice(0, 200);
    chain.push(`${name}: ${msg}`);
    current = (current as { cause?: unknown }).cause;
    depth++;
  }
  return chain.length > 0 ? chain : undefined;
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
        errorStack: extra?.errorStack ?? extractStack(err),
        errorCauseChain: extra?.errorCauseChain ?? extractCauseChain(err),
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
      name?: string;
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
    // Browser fetch() failures throw a `TypeError` with no `code`. The
    // exact message is browser-dependent: Chrome/Edge → "Failed to fetch",
    // Firefox → "NetworkError when attempting to fetch resource.", Safari
    // → "Load failed". Classify all of these as `rpc` so the diagnostics
    // drawer groups CORS rejections, DNS misses, offline states, and
    // worker-down events together — they all mean "off-chain transport
    // didn't reach the upstream service" and they all need the same
    // operator response.
    if (
      e.name === 'TypeError' &&
      typeof e.message === 'string' &&
      /failed to fetch|networkerror|load failed/i.test(e.message)
    ) {
      return {
        type: 'rpc',
        message:
          e.message ||
          'Network request failed (CORS, offline, or upstream unreachable).',
      };
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
 * Synthesize a richer error message for a `fetch()` failure so the
 * Diagnostics drawer captures more than the bare `TypeError: Failed to
 * fetch`.
 *
 * Why we need this: when a CORS preflight is rejected (or the upstream
 * is offline / DNS-missing), browsers print a verbose explanation
 * straight to the DevTools console — e.g. `Access to fetch at '…' from
 * origin '…' has been blocked by CORS policy: No
 * 'Access-Control-Allow-Origin' header is present on the requested
 * resource.` That message is generated by the browser's network stack
 * and is **not** exposed to JavaScript: the Promise rejection that lands
 * in the catch block only carries `TypeError: Failed to fetch`.
 * Exposing the full message to JS would itself be a cross-origin
 * information leak, so the spec deliberately strips it.
 *
 * What we can do is reconstruct the actionable parts: the exact URL we
 * tried, the page origin we tried it from (so cross-origin failures are
 * obvious), and the most-likely cause class. The user still has to open
 * DevTools → Network to read the literal browser-side CORS line, but
 * the journey log now captures enough to triage from the exported JSON
 * alone.
 *
 * Returns the original error untouched when it doesn't look like a
 * fetch-network failure.
 */
export function enrichFetchError(err: unknown, url: string): unknown {
  if (
    !err ||
    typeof err !== 'object' ||
    (err as { name?: string }).name !== 'TypeError'
  ) {
    return err;
  }
  const msg = (err as { message?: string }).message ?? '';
  if (!/failed to fetch|networkerror|load failed/i.test(msg)) {
    return err;
  }

  const pageOrigin =
    typeof window !== 'undefined' && window.location
      ? window.location.origin
      : 'unknown';
  let targetOrigin = 'unknown';
  let targetPath = url;
  try {
    const u = new URL(url);
    targetOrigin = u.origin;
    targetPath = u.pathname;
  } catch {
    // url wasn't absolute — fall through with the raw string.
  }
  const crossOrigin = targetOrigin !== 'unknown' && targetOrigin !== pageOrigin;

  // Cause-class hint. We can't observe the actual reason, but we can
  // pick the most-likely culprit so triage starts in the right place:
  //  - cross-origin + browser-blocked → CORS rejection (worker
  //    Access-Control-Allow-Origin missing or doesn't echo this origin),
  //    DNS miss, or worker down.
  //  - same-origin → almost always upstream down or offline.
  //  - navigator.onLine === false → the browser already knows we're
  //    offline; surface that explicitly.
  const offline =
    typeof navigator !== 'undefined' && 'onLine' in navigator && !navigator.onLine;
  const causeHint = offline
    ? 'browser reports offline (navigator.onLine === false)'
    : crossOrigin
    ? 'likely CORS rejection (Access-Control-Allow-Origin missing or origin not in allow-list), DNS failure, or upstream down — open DevTools → Network for the verbatim browser CORS message'
    : 'upstream down or local network failure';

  // Synthesize the new Error. Keep `name === 'TypeError'` so downstream
  // classifiers still resolve to `rpc`, but rewrite `message` to carry
  // the URL + origin + cause hint that the original is missing.
  const enriched = new TypeError(
    `Failed to fetch ${targetPath ? `${targetOrigin}${targetPath}` : url} from origin ${pageOrigin} — ${causeHint}.`,
  );
  // Preserve the original error chain for off-line diagnosis.
  (enriched as { cause?: unknown }).cause = err;
  return enriched;
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

// GitHub's practical issue-URL ceiling sits around ~8KB of FINAL URL
// (origin + path + URL-encoded querystring). Each newline / brace /
// paren in the markdown body becomes 3 chars after URL-encoding, so a
// raw body length is a poor proxy for final URL length. We cap both:
//   - `MAX_BODY_LEN`: hard slice of body markdown (cheap, runs first)
//   - `maxUrlChars`: post-encode check (the real GitHub gate)
// Both are env-tunable so operators can dial conservative caps without
// recompiling. Defaults below were dialled in after a real "request
// URL is too long" incident (15+5 events at the prior 8000 body cap).
//
// Operator overrides (Vite env, all optional):
//   VITE_DIAG_MAX_BODY_CHARS         (default 5000)
//   VITE_DIAG_MAX_URL_CHARS          (default 7000)
//   VITE_DIAG_EVENTS_BEFORE_FAILURE  (default 10)
//   VITE_DIAG_EVENTS_AFTER_FAILURE   (default 2)
//   VITE_DIAG_MAX_EVENTS_NO_FAILURE  (default 12)
//   VITE_GITHUB_ISSUES_URL           (default the public Vaipakam repo)
function envInt(key: string, fallback: number): number {
  const env = (import.meta as unknown as { env: Record<string, string | undefined> }).env;
  const raw = env[key];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
function envStr(key: string, fallback: string): string {
  const env = (import.meta as unknown as { env: Record<string, string | undefined> }).env;
  const raw = env[key];
  return raw && raw.trim() !== '' ? raw : fallback;
}

const MAX_BODY_LEN = envInt('VITE_DIAG_MAX_BODY_CHARS', 5_000);
const MAX_URL_LEN = envInt('VITE_DIAG_MAX_URL_CHARS', 7_000);
/** How many events to include on either side of the most-recent failure
 *  when the buffer contains one. The error itself is always included.
 *  Defaults dialled down from 15+5 → 10+2 after a real URL-too-long
 *  incident; the trim-fallback halves these further if the assembled
 *  URL still overshoots `MAX_URL_LEN`. */
const EVENTS_BEFORE_FAILURE = envInt('VITE_DIAG_EVENTS_BEFORE_FAILURE', 10);
const EVENTS_AFTER_FAILURE = envInt('VITE_DIAG_EVENTS_AFTER_FAILURE', 2);
const MAX_EVENTS_IN_ISSUE = envInt('VITE_DIAG_MAX_EVENTS_NO_FAILURE', 12);
const VAIPAKAM_ISSUES_URL = envStr(
  'VITE_GITHUB_ISSUES_URL',
  'https://github.com/vaipakam/vaipakam/issues/new',
);

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

/** Strip ASCII control chars (C0 set) via code-point filter so eslint's
 *  no-control-regex doesn't flag the pattern, then escape markdown-breaking
 *  characters so downstream triage tables stay intact. Optionally caps the
 *  result at `maxLen` characters; pass `null` for no cap. */
function sanitiseForIssue(raw: string, maxLen: number | null = 140): string {
  const cleaned = raw
    .replace(/[|`]/g, (c) => '\\' + c)
    .split('')
    .filter((c) => c.charCodeAt(0) >= 0x20)
    .join('');
  if (maxLen == null) return cleaned;
  return cleaned.slice(0, maxLen);
}

/**
 * Verbose first-level error-details block surfaced at the top of every
 * GitHub issue body. The UI typically shows a short user-friendly
 * message; this block carries everything support needs for triage on
 * the FIRST view of the issue: the failing area / flow / step, the
 * full error type / name / selector / message, raw revert data, plus
 * the most-recent on-chain tx hash if one exists. Wallet addresses
 * are redacted but error fields are kept verbatim — they're already
 * captured server-deterministically and never include private keys
 * or signatures (per the journey-log redaction contract above).
 */
function errorDetailsBlock(ev: JourneyEvent | null): string {
  if (!ev) return '';
  const lines: string[] = ['### Error details', ''];
  lines.push(`- **Area / Flow / Step:** \`${ev.area}/${ev.flow}\` · step \`${ev.step}\``);
  if (ev.errorType) lines.push(`- **Error type:** \`${ev.errorType}\``);
  if (ev.errorName && ev.errorName !== ev.errorSelector) {
    lines.push(`- **Decoded custom error:** \`${ev.errorName}\``);
  }
  if (ev.errorSelector) {
    lines.push(`- **Revert selector (4-byte):** \`${ev.errorSelector}\``);
  }
  if (ev.loanId) lines.push(`- **Loan id:** \`#${ev.loanId}\``);
  if (ev.offerId) lines.push(`- **Offer id:** \`#${ev.offerId}\``);
  if (ev.nftId) lines.push(`- **NFT id:** \`#${ev.nftId}\``);
  if (ev.role) lines.push(`- **Role:** \`${ev.role}\``);
  if (ev.chainId != null) lines.push(`- **Chain id:** \`${ev.chainId}\``);
  const txHash = extractTxHash(ev);
  if (txHash) lines.push(`- **Tx hash:** \`${txHash}\``);
  if (ev.errorMessage) {
    // No 140-char cap here — this is the dedicated detail block. We
    // still strip control chars and escape pipe / backtick so the
    // markdown stays clean. Wrapped in a fenced code block so long
    // multi-line revert reasons render as-is.
    const safe = sanitiseForIssue(ev.errorMessage, 1200);
    lines.push('- **Error message:**');
    lines.push('```');
    lines.push(safe);
    lines.push('```');
  }
  if (ev.errorData) {
    const safe = sanitiseForIssue(ev.errorData, 800);
    lines.push('- **Raw revert data:**');
    lines.push('```');
    lines.push(safe);
    lines.push('```');
  }
  if (ev.note) {
    const safe = sanitiseForIssue(ev.note, 200);
    lines.push(`- **Step note:** \`${safe}\``);
  }
  lines.push('');
  return lines.join('\n');
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
  // input echoed back). The events list lives inside a folded
  // `<details>` block on the issue, so we can afford a more generous
  // 500-char cap per line — enough to capture a typical revert reason
  // including struct-formatted custom-error args without truncating
  // mid-thought. The dedicated `errorDetailsBlock` above the fold still
  // carries the full message (cap 1200) for the most-recent failure.
  if (ev.errorMessage) {
    parts.push(`msg="${sanitiseForIssue(ev.errorMessage, 500)}"`);
  }
  // Free-form step note (e.g. tx hash, retry count, gas-estimation
  // result). Capped at 200 chars; same sanitisation pass as everything
  // else in this file. Many success steps emit `note: 'tx 0x...'` so
  // including this in the events list lets triage correlate the
  // failure with the surrounding on-chain activity.
  if (ev.note) {
    parts.push(`note="${sanitiseForIssue(ev.note, 200)}"`);
  }
  return `- ${parts.join(' · ')}`;
}

/**
 * Render an `Error.stack` excerpt (already truncated upstream by
 * `extractStack`) inside a folded `<details>` block. Sanitised to strip
 * control chars and pipes / backticks, then wrapped in a fenced code
 * block so frame paths render literally.
 */
function stackTraceSection(ev: JourneyEvent | null): string {
  if (!ev?.errorStack) return '';
  const safe = sanitiseForIssue(ev.errorStack, 2400);
  return [
    '<details>',
    '<summary><strong>Stack trace</strong> (top frames from the original throw)</summary>',
    '',
    '```',
    safe,
    '```',
    '',
    '</details>',
    '',
  ].join('\n');
}

/**
 * Render the recursive `Error.cause` chain inside a folded `<details>`
 * block. Surfaces wrappers like `enrichFetchError` (which puts a more
 * verbose `TypeError` over the original `Failed to fetch`) so triage
 * sees both layers at once instead of having to ask "what was the
 * underlying network error?".
 */
function causeChainSection(ev: JourneyEvent | null): string {
  if (!ev?.errorCauseChain || ev.errorCauseChain.length === 0) return '';
  const lines = ev.errorCauseChain.map((layer, i) => {
    const safe = sanitiseForIssue(layer, 400);
    return `${i + 1}. \`${safe}\``;
  });
  return [
    '<details>',
    '<summary><strong>Cause chain</strong> (wrapped errors, top → bottom)</summary>',
    '',
    ...lines,
    '',
    '</details>',
    '',
  ].join('\n');
}

/**
 * Browser-environment summary. Deliberately narrow: viewport size,
 * online state, prefers-color-scheme, document language, and document
 * referrer. Excludes anything that would help fingerprint or identify
 * the user — no user-agent, no screen resolution, no localStorage
 * contents, no cookie info. Returns an empty string when running
 * server-side (no `window`).
 */
function browserEnvSection(): string {
  if (typeof window === 'undefined' || typeof document === 'undefined') return '';
  const viewport = `${window.innerWidth}×${window.innerHeight}`;
  const online =
    typeof navigator !== 'undefined' && 'onLine' in navigator
      ? String(navigator.onLine)
      : 'unknown';
  const colorScheme =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light';
  const lang = (document.documentElement.lang || 'unknown').slice(0, 16);
  const referrer = sanitiseForIssue(document.referrer || '(none)', 120);
  const lines = [
    `- **Viewport:** \`${viewport}\``,
    `- **Online:** \`${online}\``,
    `- **Prefers color scheme:** \`${colorScheme}\``,
    `- **Document language:** \`${lang}\``,
    `- **Referrer:** \`${referrer}\``,
  ];
  return [
    '<details>',
    '<summary><strong>Browser environment</strong> (no user-agent, no fingerprint vectors)</summary>',
    '',
    ...lines,
    '',
    '</details>',
    '',
  ].join('\n');
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

  // Placement note: the "What happened?" prompt sits BEFORE the
  // auto-generated technical sections (error details, stack trace,
  // cause chain, browser env) so the reporter sees it the moment
  // they open the GitHub issue editor. Earlier the prompt was at
  // the bottom under several folded `<details>` blocks and most
  // reporters never scrolled down to it — issues landed without
  // the human context that makes triage possible.
  // Active locale + theme on the top line: high triage value (UI bugs
  // often only repro in a specific locale or theme) and ~zero marginal
  // privacy cost (locale leaks via every translated label in the body
  // already; theme is a single bit). Sourced from the DOM attributes the
  // i18n bootstrap and ThemeContext write on every change, so they
  // always reflect the user's CURRENT selection — no React-context
  // coupling needed in this pure module-level builder.
  const lang =
    typeof document !== 'undefined'
      ? document.documentElement.lang || 'unknown'
      : 'unknown';
  const theme =
    typeof document !== 'undefined'
      ? document.documentElement.getAttribute('data-theme') || 'unknown'
      : 'unknown';
  // ── Body builder, parameterized by trim tier ───────────────────
  // Tier 0 (default): all sections, full event window per env config.
  // Tier 1: events halved.
  // Tier 2: drop browser env section.
  // Tier 3: drop stack trace + cause chain.
  // Tier 4: drop everything except header + error details + truncated
  //         events list — last resort before slice.
  // After each tier, re-encode the URL and check against MAX_URL_LEN;
  // stop at the first tier that fits. The intent is graceful
  // degradation: every reporter still hands triage actionable info,
  // but no one ever hits GitHub's "request URL is too long" gate.
  const buildBody = (tier: number): string => {
    const eventsBefore = tier >= 1
      ? Math.floor(EVENTS_BEFORE_FAILURE / 2)
      : EVENTS_BEFORE_FAILURE;
    const eventsAfter = tier >= 1
      ? Math.max(1, Math.floor(EVENTS_AFTER_FAILURE / 2))
      : EVENTS_AFTER_FAILURE;
    const maxNoFailure = tier >= 1
      ? Math.floor(MAX_EVENTS_IN_ISSUE / 2)
      : MAX_EVENTS_IN_ISSUE;
    const dropBrowserEnv = tier >= 2;
    const dropStackTrace = tier >= 3;
    const dropCauseChain = tier >= 3;

    const header = [
      `**Report ID:** \`${id}\``,
      `**Wallet (redacted):** \`${wallet}\``,
      `**Chain:** \`${chainLabel}\``,
      `**Language:** \`${lang}\``,
      `**Theme:** \`${theme}\``,
      tx ? `**Last tx hash:** \`${tx}\`` : null,
      `**Generated:** ${new Date().toISOString()}`,
      '',
      '### What happened?',
      '<!-- Please describe in your own words what you were trying to do. -->',
      '',
      '---',
      '',
      '> Auto-generated by the Vaipakam diagnostics drawer. No personal',
      '> information is published: wallet addresses are shortened to',
      '> `0x…abcd`, the browser user-agent is NOT included, no localStorage',
      '> contents, no cookies. The "Error details" block carries the full',
      '> first-level diagnostic info for the most recent failure; the folded',
      '> sections below carry the deeper second-level data (stack trace,',
      '> cause chain, browser env, dense events list) so a developer can',
      '> pinpoint the bug without a back-and-forth.',
      '',
      errorDetailsBlock(lastFailure),
      dropStackTrace ? '' : stackTraceSection(lastFailure),
      dropCauseChain ? '' : causeChainSection(lastFailure),
      dropBrowserEnv ? '' : browserEnvSection(),
      '',
    ].filter((l) => l != null).join('\n');

    const windowStart = lastFailureIdx >= 0
      ? Math.max(0, lastFailureIdx - eventsBefore)
      : Math.max(0, buffer.length - maxNoFailure);
    const windowEnd = lastFailureIdx >= 0
      ? Math.min(buffer.length, lastFailureIdx + 1 + eventsAfter)
      : buffer.length;
    const eventLines = buffer
      .slice(windowStart, windowEnd)
      .map(eventToIssueLine)
      .join('\n');
    const eventCount = windowEnd - windowStart;
    const tierNote = tier > 0
      ? ` · trimmed (tier ${tier})`
      : '';
    const recent = [
      '<details>',
      `<summary><strong>Recent events</strong> (${eventCount} entries${tierNote} — click to expand)</summary>`,
      '',
      eventLines,
      '',
      '</details>',
      '',
    ].join('\n');

    let body = header + recent;
    if (body.length > MAX_BODY_LEN) {
      body =
        body.slice(0, MAX_BODY_LEN - 80) +
        '\n\n> _(truncated — attach full diagnostics JSON for complete log)_';
    }
    return body;
  };

  const buildUrl = (tier: number): string => {
    const params = new URLSearchParams({
      title,
      body: buildBody(tier),
      labels: 'bug,diagnostics',
    });
    return `${VAIPAKAM_ISSUES_URL}?${params.toString()}`;
  };

  // Try each tier in order; return the first URL that fits under
  // MAX_URL_LEN. Tier 4 always wins on the last iteration even if
  // still over (the body slice in `buildBody` enforces the body
  // hard cap, so the URL is bounded regardless).
  for (let tier = 0; tier <= 4; tier++) {
    const url = buildUrl(tier);
    if (url.length <= MAX_URL_LEN || tier === 4) return url;
  }
  // Unreachable but typed-required.
  return buildUrl(4);
}
