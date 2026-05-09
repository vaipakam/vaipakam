/**
 * 2026-05-01 — diagnostics error capture endpoint.
 *
 * `POST /diag/record` — frontend fires-and-forgets one of these for
 * every `failure` journey event. Body shape (all fields optional
 * unless flagged required):
 *
 *   {
 *     "id": "uuidv4",                 // required, also used as report id
 *     "client_at": 1735761234,        // required, unix seconds, client clock
 *     "area": "offer-create",         // required, journey-log area
 *     "flow": "createLenderOffer",    // required, journey-log flow
 *     "step": "submit-tx",            // optional, journey-log step
 *     "errorType": "tx-revert",       // optional, journey-log errorType
 *     "errorName": "InsufficientFunds",
 *     "errorSelector": "0x12345678",
 *     "errorMessage": "…",            // truncated to 1000 chars at write
 *     "redactedWallet": "0x…abcd",    // pre-redacted by frontend
 *     "chainId": 84532,
 *     "loanId": "42",
 *     "offerId": "1138",
 *     "appLocale": "en",
 *     "appTheme": "dark",
 *     "viewport": "1280x720",
 *     "appVersion": "abcd1234"
 *   }
 *
 * Response: `{recorded: true, id}` on write, `{recorded: false,
 * reason: "…"}` on dedup / sample / validation skip. Always 200 (the
 * frontend doesn't retry; non-recording is not an error from the
 * caller's perspective).
 *
 * Defenses:
 *   - CORS-locked to FRONTEND_ORIGIN (env var).
 *   - Per-IP rate limit via DIAG_RECORD_RATELIMIT binding.
 *   - Random sampling via DIAG_SAMPLE_RATE env var.
 *   - Server-side dedup: skip writes when the last 5 records for the
 *     same fingerprint were identical with no different fingerprint
 *     between. Belt-and-suspenders against a frontend that fails to
 *     respect its local 5-streak cap.
 *   - Field-length caps on every string. Numeric fields are coerced
 *     and clamped.
 */

import type { Env } from './env';

const FRONTEND_TIMESTAMP_MAX_DRIFT_SECONDS = 6 * 60 * 60; // 6 hours

// Field length caps. Bigger than the frontend would normally send, so
// these are belt-and-suspenders rather than primary truncation.
const CAP_AREA = 64;
const CAP_FLOW = 96;
const CAP_STEP = 96;
const CAP_ERROR_TYPE = 64;
const CAP_ERROR_NAME = 96;
const CAP_ERROR_SELECTOR = 12; // '0x' + 8 hex
const CAP_ERROR_MESSAGE = 1000;
const CAP_WALLET = 64; // '0x…abcd' is short, but ENS names can be longer
const CAP_LOAN_OR_OFFER_ID = 32; // bigint string fits in 78 chars; cap defensively
const CAP_LOCALE = 16;
const CAP_THEME = 16;
const CAP_VIEWPORT = 16; // '99999x99999'
const CAP_APP_VERSION = 64;

// UUIDv4 regex — frontend uses crypto.randomUUID(). Server validates
// to reject random garbage in the id field.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface RecordBody {
  id?: unknown;
  client_at?: unknown;
  area?: unknown;
  flow?: unknown;
  step?: unknown;
  errorType?: unknown;
  errorName?: unknown;
  errorSelector?: unknown;
  errorMessage?: unknown;
  redactedWallet?: unknown;
  chainId?: unknown;
  loanId?: unknown;
  offerId?: unknown;
  appLocale?: unknown;
  appTheme?: unknown;
  viewport?: unknown;
  appVersion?: unknown;
}

interface ValidatedRecord {
  id: string;
  clientAt: number;
  area: string;
  flow: string;
  step: string | null;
  errorType: string | null;
  errorName: string | null;
  errorSelector: string | null;
  errorMessage: string | null;
  redactedWallet: string | null;
  chainId: number | null;
  loanId: string | null;
  offerId: string | null;
  appLocale: string | null;
  appTheme: string | null;
  viewport: string | null;
  appVersion: string | null;
}

/** Reject obvious garbage. Returns null + reason on bad input. */
function validate(body: RecordBody, nowSeconds: number):
  | { ok: true; record: ValidatedRecord }
  | { ok: false; reason: string } {
  if (typeof body.id !== 'string' || !UUID_RE.test(body.id)) {
    return { ok: false, reason: 'id must be a UUIDv4' };
  }
  const clientAt =
    typeof body.client_at === 'number' && isFinite(body.client_at)
      ? Math.floor(body.client_at)
      : NaN;
  if (!isFinite(clientAt) || clientAt <= 0) {
    return { ok: false, reason: 'client_at must be a positive unix-seconds number' };
  }
  // Clock-drift sanity: a client clock more than 6 hours off is
  // probably misconfigured (or a replay attempt). Accept but flag —
  // we don't want to lose otherwise-valid reports just because a
  // user's laptop has the wrong time.
  if (Math.abs(clientAt - nowSeconds) > FRONTEND_TIMESTAMP_MAX_DRIFT_SECONDS) {
    // Don't reject — log via the recorded_at vs client_at delta in
    // the row. Triage can spot it later.
  }
  if (typeof body.area !== 'string' || body.area.length === 0) {
    return { ok: false, reason: 'area is required' };
  }
  if (typeof body.flow !== 'string' || body.flow.length === 0) {
    return { ok: false, reason: 'flow is required' };
  }

  return {
    ok: true,
    record: {
      id: body.id,
      clientAt,
      area: trim(body.area, CAP_AREA),
      flow: trim(body.flow, CAP_FLOW),
      step: optStr(body.step, CAP_STEP),
      errorType: optStr(body.errorType, CAP_ERROR_TYPE),
      errorName: optStr(body.errorName, CAP_ERROR_NAME),
      errorSelector: optStr(body.errorSelector, CAP_ERROR_SELECTOR),
      errorMessage: optStr(body.errorMessage, CAP_ERROR_MESSAGE),
      redactedWallet: optStr(body.redactedWallet, CAP_WALLET),
      chainId:
        typeof body.chainId === 'number' && isFinite(body.chainId)
          ? Math.floor(body.chainId)
          : null,
      loanId: optStr(body.loanId, CAP_LOAN_OR_OFFER_ID),
      offerId: optStr(body.offerId, CAP_LOAN_OR_OFFER_ID),
      appLocale: optStr(body.appLocale, CAP_LOCALE),
      appTheme: optStr(body.appTheme, CAP_THEME),
      viewport: optStr(body.viewport, CAP_VIEWPORT),
      appVersion: optStr(body.appVersion, CAP_APP_VERSION),
    },
  };
}

function trim(s: string, cap: number): string {
  return s.length > cap ? s.slice(0, cap) : s;
}

function optStr(v: unknown, cap: number): string | null {
  if (typeof v !== 'string' || v.length === 0) return null;
  return trim(v, cap);
}

/** Stable fingerprint: hash of the dimensions that define "same
 *  error". Used for dedup at write time AND surfaceable on the
 *  triage UI to group identical errors. SHA-256 hex truncated to
 *  16 chars — birthday collision probability is negligible at our
 *  expected volume. */
async function fingerprintOf(r: ValidatedRecord): Promise<string> {
  const key = [
    r.area,
    r.flow,
    r.step ?? '',
    r.errorType ?? '',
    r.errorName ?? '',
    r.errorSelector ?? '',
  ].join('|');
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
  return Array.from(new Uint8Array(buf))
    .slice(0, 8)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Server-side dedup check: did the last 5 records all have this
 *  fingerprint AND no different fingerprint between? If yes, skip
 *  the write — the user has already burnt their 5-streak budget. */
async function exceedsConsecutiveCap(
  db: D1Database,
  fingerprint: string,
): Promise<boolean> {
  const rows = await db
    .prepare(
      `SELECT fingerprint
         FROM diag_errors
        ORDER BY recorded_at DESC
        LIMIT 5`,
    )
    .all<{ fingerprint: string }>();
  const recent = rows.results ?? [];
  if (recent.length < 5) return false;
  return recent.every((r) => r.fingerprint === fingerprint);
}

function corsHeaders(env: Env, origin: string | null): HeadersInit {
  const allowed = env.FRONTEND_ORIGIN ?? '';
  const matched = allowed
    .split(',')
    .map((s) => s.trim())
    .some((o) => o.length > 0 && origin === o);
  return {
    'access-control-allow-origin': matched ? origin! : 'null',
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '86400',
    vary: 'origin',
  };
}

function clientIp(req: Request): string {
  return req.headers.get('cf-connecting-ip') ?? 'unknown';
}

function clampSampleRate(raw: string | undefined): number {
  if (!raw) return 1.0;
  const n = Number(raw);
  if (!isFinite(n)) return 1.0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

export async function handleDiagRecord(
  req: Request,
  env: Env,
): Promise<Response> {
  const origin = req.headers.get('origin');
  const headers = corsHeaders(env, origin);

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers });
  }
  if (req.method !== 'POST') {
    return new Response('method not allowed', { status: 405, headers });
  }

  // Per-IP rate limit. Skipped silently if the binding isn't
  // configured (e.g. local dev without the unsafe binding) so the
  // dev path still works.
  const limiter = env.DIAG_RECORD_RATELIMIT;
  if (limiter) {
    const result = await limiter.limit({ key: clientIp(req) });
    if (!result.success) {
      return new Response(
        JSON.stringify({ recorded: false, reason: 'rate_limited' }),
        {
          status: 429,
          headers: { ...headers, 'content-type': 'application/json' },
        },
      );
    }
  }

  // Random sampling. Drops the request entirely (200 OK, no row)
  // when the dice land outside the configured rate.
  const sampleRate = clampSampleRate(env.DIAG_SAMPLE_RATE);
  if (sampleRate < 1 && Math.random() > sampleRate) {
    return new Response(
      JSON.stringify({ recorded: false, reason: 'sampled_out' }),
      {
        status: 200,
        headers: { ...headers, 'content-type': 'application/json' },
      },
    );
  }

  let body: RecordBody;
  try {
    body = (await req.json()) as RecordBody;
  } catch {
    return new Response(
      JSON.stringify({ recorded: false, reason: 'invalid_json' }),
      {
        status: 400,
        headers: { ...headers, 'content-type': 'application/json' },
      },
    );
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const validation = validate(body, nowSeconds);
  if (!validation.ok) {
    return new Response(
      JSON.stringify({ recorded: false, reason: validation.reason }),
      {
        status: 400,
        headers: { ...headers, 'content-type': 'application/json' },
      },
    );
  }
  const r = validation.record;

  const fingerprint = await fingerprintOf(r);

  if (await exceedsConsecutiveCap(env.DB, fingerprint)) {
    return new Response(
      JSON.stringify({
        recorded: false,
        reason: 'streak_cap',
        id: r.id,
      }),
      {
        status: 200,
        headers: { ...headers, 'content-type': 'application/json' },
      },
    );
  }

  await env.DB
    .prepare(
      `INSERT INTO diag_errors (
         id, recorded_at, client_at, fingerprint,
         area, flow, step,
         error_type, error_name, error_selector, error_message,
         redacted_wallet, chain_id, loan_id, offer_id,
         app_locale, app_theme, viewport, app_version
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      r.id,
      nowSeconds,
      r.clientAt,
      fingerprint,
      r.area,
      r.flow,
      r.step,
      r.errorType,
      r.errorName,
      r.errorSelector,
      r.errorMessage,
      r.redactedWallet,
      r.chainId,
      r.loanId,
      r.offerId,
      r.appLocale,
      r.appTheme,
      r.viewport,
      r.appVersion,
    )
    .run();

  return new Response(
    JSON.stringify({ recorded: true, id: r.id }),
    {
      status: 200,
      headers: { ...headers, 'content-type': 'application/json' },
    },
  );
}

/** Cron-driven retention prune. Runs once per scheduled tick (the
 *  hf-watcher already cron-runs every 5 min, so this fires often
 *  enough — adds at most one DELETE per tick, no measurable cost).
 *  Reads DIAG_RETENTION_DAYS (default 90, clamped >= 1). */
export async function pruneOldDiagErrors(env: Env): Promise<void> {
  const rawDays = env.DIAG_RETENTION_DAYS ?? '90';
  const parsed = Number(rawDays);
  const days = isFinite(parsed) ? Math.max(1, Math.floor(parsed)) : 90;
  const cutoff = Math.floor(Date.now() / 1000) - days * 86400;
  await env.DB
    .prepare(`DELETE FROM diag_errors WHERE recorded_at < ?`)
    .bind(cutoff)
    .run();
}
