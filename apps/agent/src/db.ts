/**
 * D1 helpers — thin wrappers over the prepared-statement API. Keeps
 * the watcher loop readable and centralises query shapes so schema
 * changes in `migrations/*.sql` touch only this file.
 */

import type { PublishedRailRow } from '@vaipakam/push';

export type Band = 'healthy' | 'warn' | 'alert' | 'critical';

export interface UserThresholds {
  wallet: string;
  chain_id: number;
  warn_hf: number;
  alert_hf: number;
  critical_hf: number;
  push_channel: string | null;
  /** 2-letter ISO 639-1 locale code (`en`, `es`, ...) for the
   *  language to send Telegram / Push notifications in. Defaults to
   *  `'en'` when the user hasn't explicitly set one. */
  locale: string;
  /** #1033 — 1 = send the periodic-interest pre-notify (default),
   *  0 = user opted out via the connected app Alerts card. */
  notify_maturity_approaching: number;
}

export interface NotifyState {
  wallet: string;
  chain_id: number;
  loan_id: number;
  last_band: Band;
  last_hf_milli: number;
  last_sent_ts: number;
}

/** All thresholds enabled on a given chain — one row per user. Used by
 *  the cron tick to fan out per-user HF reads. */
export async function listThresholdsForChain(
  db: D1Database,
  chainId: number,
): Promise<UserThresholds[]> {
  const res = await db
    .prepare(
      `SELECT wallet, chain_id, warn_hf, alert_hf, critical_hf, push_channel, locale
       FROM user_thresholds
       WHERE chain_id = ?`,
    )
    .bind(chainId)
    .all<UserThresholds>();
  return res.results ?? [];
}

/** Thrown when an OPT-OUT write arrives before migration 0027 — the
 *  column to store it doesn't exist yet, and silently dropping the
 *  flag would make the toggle theater. The HTTP handler maps this to
 *  a distinct 503 so the client can say "try again shortly". */
export class OptOutStorageUnavailableError extends Error {
  constructor() {
    super(
      'notify_maturity_approaching column missing (migration 0027 pending)',
    );
    this.name = 'OptOutStorageUnavailableError';
  }
}

type ThresholdsUpsert = Omit<
  UserThresholds,
  | 'warn_hf'
  | 'alert_hf'
  | 'critical_hf'
  | 'push_channel'
  | 'locale'
  | 'notify_maturity_approaching'
> & {
  /** #2000 — the bands are optional AS A SET (the parser enforces
   *  all-or-none): absent means "no band change" and the stored
   *  values are preserved, the same contract `push_channel` and the
   *  pre-notify flag already carry. The bands express the risky
   *  lane's state, so a client save that did not touch that lane
   *  omits them — otherwise a fresh device's defaults overwrote an
   *  opt-out made elsewhere. */
  warn_hf?: number;
  alert_hf?: number;
  critical_hf?: number;
  push_channel?: string | null;
  locale?: string | null;
  /** #1033 — optional; absent keeps the historical opted-in state. */
  notify_maturity_approaching?: boolean;
};

/** What a BANDLESS upsert's INSERT arm writes when no row exists —
 *  the same sensible defaults `apps/app` shows as the risky lane's
 *  starting state (`DEFAULT_BANDS` there; keep the two in step). A
 *  first-ever write that omitted bands intends no lane change, and
 *  for a wallet with no record the lane's state IS the default. The
 *  values reach ONLY a genuine insert: on conflict the bandless
 *  statement's update arm does not assign the band columns at all. */
const DEFAULT_BANDS = { warn_hf: 1.5, alert_hf: 1.2, critical_hf: 1.05 };

function hasBands(
  t: ThresholdsUpsert,
): t is ThresholdsUpsert & { warn_hf: number; alert_hf: number; critical_hf: number } {
  return (
    t.warn_hf !== undefined && t.alert_hf !== undefined && t.critical_hf !== undefined
  );
}

/**
 * Compose the upsert for the four statement shapes: with/without the
 * pre-notify column (the 0027 rollout split), with/without band
 * assignments in the conflict arm (#2000). Preservation of omitted
 * bands lives in the STATEMENT — the conflict arm simply does not
 * assign the band columns — which is what makes it ATOMIC (PR #2005
 * round 1 P1: an earlier read-then-write preserve could read stored
 * bands, lose the race to a concurrent band update from another
 * device, and write the stale read back over it — reintroducing the
 * exact cross-device overwrite #2000 removes). The VALUES always
 * carry concrete bands because the columns are NOT NULL and a
 * genuine insert needs them; on conflict those values are simply
 * never consulted for a bandless write.
 */
function thresholdsUpsertSql(withFlag: boolean, withBands: boolean): string {
  const flagCol = withFlag ? ', notify_maturity_approaching' : '';
  const flagPlaceholder = withFlag ? ', ?' : '';
  const bandArm = withBands
    ? `warn_hf = excluded.warn_hf,
         alert_hf = excluded.alert_hf,
         critical_hf = excluded.critical_hf,
         `
    : '';
  const flagArm = withFlag
    ? `notify_maturity_approaching = excluded.notify_maturity_approaching,
         `
    : '';
  return `INSERT INTO user_thresholds
         (wallet, chain_id, warn_hf, alert_hf, critical_hf, push_channel, locale${flagCol}, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?${flagPlaceholder}, ?, ?)
       ON CONFLICT(wallet, chain_id) DO UPDATE SET
         ${bandArm}push_channel = COALESCE(excluded.push_channel, user_thresholds.push_channel),
         locale = COALESCE(excluded.locale, user_thresholds.locale),
         ${flagArm}updated_at = excluded.updated_at`;
}

/** The pre-0027 column set. Used when the flag is absent (no change
 *  intended) AND as the rollout-window fallback for an opted-IN write
 *  (true equals the column default, so nothing is lost). */
async function upsertThresholdsLegacy(
  db: D1Database,
  t: ThresholdsUpsert,
  now: number,
): Promise<void> {
  await db
    .prepare(thresholdsUpsertSql(false, hasBands(t)))
    .bind(
      t.wallet.toLowerCase(),
      t.chain_id,
      t.warn_hf ?? DEFAULT_BANDS.warn_hf,
      t.alert_hf ?? DEFAULT_BANDS.alert_hf,
      t.critical_hf ?? DEFAULT_BANDS.critical_hf,
      t.push_channel ?? null,
      t.locale ?? 'en',
      now,
      now,
    )
    .run();
}

/** Upsert a user's thresholds. Called from the frontend settings page
 *  via the HTTP handler. */
export async function upsertThresholds(
  db: D1Database,
  t: ThresholdsUpsert,
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  // The pre-notify opt-out updates ONLY when the caller sent it —
  // absence must preserve a stored opt-out (an older client updating
  // its bands must not re-enable reminders), while new rows take the
  // column default (opted in). Two statements because `excluded.` in
  // the conflict arm sees post-default values, which can't express
  // "no change".
  if (t.notify_maturity_approaching === undefined) {
    await upsertThresholdsLegacy(db, t, now);
    return;
  }
  try {
    await db
      .prepare(thresholdsUpsertSql(true, hasBands(t)))
      .bind(
        t.wallet.toLowerCase(),
        t.chain_id,
        t.warn_hf ?? DEFAULT_BANDS.warn_hf,
        t.alert_hf ?? DEFAULT_BANDS.alert_hf,
        t.critical_hf ?? DEFAULT_BANDS.critical_hf,
        t.push_channel ?? null,
        t.locale ?? 'en',
        t.notify_maturity_approaching ? 1 : 0,
        now,
        now,
      )
      .run();
  } catch (err) {
    // Rollout window — migration 0027 not applied yet. Only the
    // missing-column condition gets special handling; anything else
    // (transient D1 failure, constraint error) propagates untouched.
    // SQLite phrases the condition differently by statement kind:
    // "no such column: X" for expressions/SELECT, but "table T has
    // no column named X" for an INSERT column list — this INSERT
    // path hits the latter (verified live on the staging D1).
    if (!/no such column|has no column named/i.test(String(err))) throw err;
    if (t.notify_maturity_approaching) {
      // Opted-in equals the column default — the legacy write loses
      // nothing.
      await upsertThresholdsLegacy(db, t, now);
      return;
    }
    // An opt-out CANNOT be stored without the column; surface it
    // rather than pretending (a silently-dropped opt-out would be
    // the "toggle is theater" bug all over again).
    throw new OptOutStorageUnavailableError();
  }
}

/** Read the notify-state row for a loan. Returns defaults when the
 *  loan has never been polled (new user, new loan, etc.). */
export async function getNotifyState(
  db: D1Database,
  wallet: string,
  chainId: number,
  loanId: number,
): Promise<NotifyState> {
  const res = await db
    .prepare(
      `SELECT wallet, chain_id, loan_id, last_band, last_hf_milli, last_sent_ts
       FROM notify_state
       WHERE wallet = ? AND chain_id = ? AND loan_id = ?`,
    )
    .bind(wallet, chainId, loanId)
    .first<NotifyState>();
  return (
    res ?? {
      wallet,
      chain_id: chainId,
      loan_id: loanId,
      last_band: 'healthy',
      last_hf_milli: 0,
      last_sent_ts: 0,
    }
  );
}

/** Commit the latest band + HF reading. */
export async function putNotifyState(
  db: D1Database,
  s: NotifyState,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO notify_state
         (wallet, chain_id, loan_id, last_band, last_hf_milli, last_sent_ts)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(wallet, chain_id, loan_id) DO UPDATE SET
         last_band = excluded.last_band,
         last_hf_milli = excluded.last_hf_milli,
         last_sent_ts = excluded.last_sent_ts`,
    )
    .bind(
      s.wallet,
      s.chain_id,
      s.loan_id,
      s.last_band,
      s.last_hf_milli,
      s.last_sent_ts,
    )
    .run();
}

/** True iff the D1 error is the missing-`last_test_alert_at`-column
 *  condition (migration 0034 not applied yet). SQLite phrases it
 *  differently for a SELECT expression vs an INSERT/UPDATE column list,
 *  so both forms are matched — same rollout-tolerance pattern as the
 *  notify_maturity_approaching column. */
function isMissingTestAlertColumn(err: unknown): boolean {
  return /no such column|has no column named/i.test(String(err));
}

/** #2667 — the row another sender published about its Push rail (the
 *  keeper's), or null when there is none. Decoded by the caller through the
 *  shared rail's `readPublishedRail`, never trusted raw. */
export async function readPublishedPushRail(
  db: D1Database,
  sender: 'keeper',
): Promise<PublishedRailRow | null> {
  return db
    .prepare(`SELECT usable, reason, channel, observed_at FROM push_rail_status WHERE sender = ?`)
    .bind(sender)
    .first<PublishedRailRow>();
}

/** #2251 — whether this wallet/chain already has a Push opt-in stored, so a
 *  save that re-sends it during a rail outage is told it is KEPT rather than
 *  refused (only a NEW opt-in is refused). */
export async function hasStoredPushOptIn(
  db: D1Database,
  wallet: string,
  chainId: number,
): Promise<boolean> {
  const row = await db
    .prepare(`SELECT push_channel FROM user_thresholds WHERE wallet = ? AND chain_id = ?`)
    .bind(wallet.toLowerCase(), chainId)
    .first<{ push_channel: string | null }>();
  return Boolean(row?.push_channel);
}

/** UX-012 / Codex #1175 — atomically reserve this wallet's test-alert
 *  slot BEFORE sending, so parallel replays of one signed body can't all
 *  pass a read-then-write check and each fire a message. The single
 *  conditional UPDATE only flips `last_test_alert_at` when the prior
 *  stamp is at least `cooldownSeconds` old; SQLite serialises writes, so
 *  exactly one concurrent request sees the old value and wins (changes =
 *  1) while the rest match zero rows. Returns whether THIS call won the
 *  slot — the caller sends only on true and returns 429 on false.
 *
 *  Reserving before the send means a failed send still consumes the slot
 *  (the user waits out the cooldown before retrying) — the deliberate,
 *  race-free trade the atomic guarantee requires.
 *
 *  Pre-0034 rollout window (column absent): the UPDATE throws the
 *  missing-column error, which we treat as "reserved" (return true) so
 *  the feature keeps working with no cooldown until the migration
 *  lands — same fail-open rollout policy as notify_maturity. */
export async function reserveTestAlert(
  db: D1Database,
  wallet: string,
  chainId: number,
  now: number,
  cooldownSeconds: number,
): Promise<boolean> {
  try {
    const res = await db
      .prepare(
        `UPDATE user_thresholds
         SET last_test_alert_at = ?
         WHERE wallet = ? AND chain_id = ? AND last_test_alert_at <= ?`,
      )
      .bind(now, wallet.toLowerCase(), chainId, now - cooldownSeconds)
      .run();
    return (res.meta?.changes ?? 0) > 0;
  } catch (err) {
    if (!isMissingTestAlertColumn(err)) throw err;
    // Pre-0034 — no cooldown column to gate on; allow the send.
    return true;
  }
}

/** #1722 — make sure (`wallet`, `chainId`) has a `user_thresholds` row, with
 *  the default bands when it is new. Run at a completed Telegram handshake: a
 *  first-time owner can link before ever saving settings, and the keeper's
 *  watchers iterate these rows to know whose positions to watch. The chat
 *  itself is NOT stored here (it lives in the agent's Telegram state object);
 *  an existing row is left exactly as it is. The insert is safe against third
 *  parties because a link code is issued only to a caller who proved
 *  ownership of the wallet (`linkAuth.ts`). */
export async function ensureThresholdsRow(db: D1Database, wallet: string, chainId: number): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await db
    .prepare(
      `INSERT INTO user_thresholds
         (wallet, chain_id, warn_hf, alert_hf, critical_hf, push_channel, locale, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, NULL, 'en', ?, ?)
       ON CONFLICT(wallet, chain_id) DO NOTHING`,
    )
    .bind(wallet.toLowerCase(), chainId, DEFAULT_BANDS.warn_hf, DEFAULT_BANDS.alert_hf, DEFAULT_BANDS.critical_hf, now, now)
    .run();
}

/** #1040 phase 1 — persist a support ticket captured by the connected app
 *  support widget. The ticket row is the durable record: the
 *  ops-Telegram notify and the user's mailto escalation are both
 *  best-effort layers on top of it. Throws on D1 failure (including
 *  the migration not being applied yet) — the handler maps that to
 *  an honest 503 so the widget can fall back to the mailto path. */
export async function insertSupportTicket(
  db: D1Database,
  ticket: {
    ticketId: string;
    message: string;
    email: string | null;
    diagnostics: string | null;
    page: string | null;
    chainId: number | null;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO support_tickets
         (ticket_id, created_at, message, email, diagnostics, page, chain_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      ticket.ticketId,
      Math.floor(Date.now() / 1000),
      ticket.message,
      ticket.email,
      ticket.diagnostics,
      ticket.page,
      ticket.chainId,
    )
    .run();
}
