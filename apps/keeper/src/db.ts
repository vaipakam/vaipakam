/**
 * D1 helpers — thin wrappers over the prepared-statement API. Keeps
 * the watcher loop readable and centralises query shapes so schema
 * changes in `migrations/*.sql` touch only this file.
 */

export type Band = 'healthy' | 'warn' | 'alert' | 'critical';

export interface UserThresholds {
  wallet: string;
  chain_id: number;
  warn_hf: number;
  alert_hf: number;
  critical_hf: number;
  tg_chat_id: string | null;
  push_channel: string | null;
  /** 2-letter ISO 639-1 locale code (`en`, `es`, ...) for the
   *  language to send Telegram / Push notifications in. Defaults to
   *  `'en'` when the user hasn't explicitly set one. */
  locale: string;
  /** #1033 — 0 = the user opted out of maturity / due-date warnings
   *  (the "message me before a payment comes due" toggle). Gates the
   *  pre-grace warning lane; HF-band alerts are governed by the
   *  bands themselves, not this flag. Column added in migration
   *  0027 (apps/indexer/migrations). */
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
  try {
    const res = await db
      .prepare(
        `SELECT wallet, chain_id, warn_hf, alert_hf, critical_hf, tg_chat_id, push_channel, locale, notify_maturity_approaching
         FROM user_thresholds
         WHERE chain_id = ?`,
      )
      .bind(chainId)
      .all<UserThresholds>();
    return res.results ?? [];
  } catch {
    // Rollout window — migration 0027 (notify_maturity_approaching)
    // not applied yet. Fall back to the legacy column set with the
    // flag defaulted to OPTED IN, so the HF watcher and pre-grace
    // lanes keep running rather than going dark; worst case an
    // opted-out user still gets a warning until the migration lands
    // — never the reverse. Same graceful-degradation pattern as the
    // preNotifyDays chain read.
    const res = await db
      .prepare(
        `SELECT wallet, chain_id, warn_hf, alert_hf, critical_hf, tg_chat_id, push_channel, locale
         FROM user_thresholds
         WHERE chain_id = ?`,
      )
      .bind(chainId)
      .all<Omit<UserThresholds, 'notify_maturity_approaching'>>();
    return (res.results ?? []).map((r) => ({
      ...r,
      notify_maturity_approaching: 1,
    }));
  }
}

/** Upsert a user's thresholds. Called from the frontend settings page
 *  via the HTTP handler. */
export async function upsertThresholds(
  db: D1Database,
  // notify_maturity_approaching is read-side only here — writes rely
  // on the column default (opted in); the agent owns the opt-out
  // write path.
  t: Omit<
    UserThresholds,
    'tg_chat_id' | 'push_channel' | 'locale' | 'notify_maturity_approaching'
  > & {
    tg_chat_id?: string | null;
    push_channel?: string | null;
    locale?: string | null;
  },
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await db
    .prepare(
      `INSERT INTO user_thresholds
         (wallet, chain_id, warn_hf, alert_hf, critical_hf, tg_chat_id, push_channel, locale, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(wallet, chain_id) DO UPDATE SET
         warn_hf = excluded.warn_hf,
         alert_hf = excluded.alert_hf,
         critical_hf = excluded.critical_hf,
         tg_chat_id = COALESCE(excluded.tg_chat_id, user_thresholds.tg_chat_id),
         push_channel = COALESCE(excluded.push_channel, user_thresholds.push_channel),
         locale = COALESCE(excluded.locale, user_thresholds.locale),
         updated_at = excluded.updated_at`,
    )
    .bind(
      t.wallet.toLowerCase(),
      t.chain_id,
      t.warn_hf,
      t.alert_hf,
      t.critical_hf,
      t.tg_chat_id ?? null,
      t.push_channel ?? null,
      t.locale ?? 'en',
      now,
      now,
    )
    .run();
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

/** T-092-C (#532) — read the last pre-grace warning timestamp for
 *  a borrower's loan. Returns 0 when no warning has been sent yet
 *  (new loan, or never reached the grace-approach window). The
 *  caller compares against `now - WINDOW_SECONDS` to throttle. */
export async function getPreGraceNotifyState(
  db: D1Database,
  wallet: string,
  chainId: number,
  loanId: number,
): Promise<number> {
  const res = await db
    .prepare(
      `SELECT last_sent_ts FROM pre_grace_notify_state
       WHERE wallet = ? AND chain_id = ? AND loan_id = ?`,
    )
    .bind(wallet, chainId, loanId)
    .first<{ last_sent_ts: number }>();
  return res?.last_sent_ts ?? 0;
}

/** T-092-C (#532) — stamp the pre-grace warning timestamp. Upserts
 *  the (wallet, chain_id, loan_id) triple. */
export async function putPreGraceNotifyState(
  db: D1Database,
  wallet: string,
  chainId: number,
  loanId: number,
  lastSentTs: number,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO pre_grace_notify_state
         (wallet, chain_id, loan_id, last_sent_ts)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(wallet, chain_id, loan_id) DO UPDATE SET
         last_sent_ts = excluded.last_sent_ts`,
    )
    .bind(wallet, chainId, loanId, lastSentTs)
    .run();
}

/** 6-digit numeric Telegram handshake code with a 10-minute expiry.
 *  Collisions are exceedingly rare (1-in-10^6 per window) but we
 *  regenerate on ON CONFLICT just in case. */
export async function issueTelegramLinkCode(
  db: D1Database,
  wallet: string,
  chainId: number,
): Promise<string> {
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  const expiresAt = Math.floor(Date.now() / 1000) + 600;
  try {
    await db
      .prepare(
        `INSERT INTO telegram_links (code, wallet, chain_id, expires_at)
         VALUES (?, ?, ?, ?)`,
      )
      .bind(code, wallet.toLowerCase(), chainId, expiresAt)
      .run();
    return code;
  } catch {
    // Retry once on code-collision.
    return issueTelegramLinkCode(db, wallet, chainId);
  }
}

/** Consume a handshake code — called by the Telegram bot webhook when
 *  a user DMs the code. Returns the linked wallet/chain plus the
 *  user's stored locale (so the handshake confirmation message can
 *  be sent in the right language), or null if expired / unknown. */
export async function consumeTelegramLinkCode(
  db: D1Database,
  code: string,
): Promise<{ wallet: string; chainId: number; locale: string } | null> {
  const now = Math.floor(Date.now() / 1000);
  const row = await db
    .prepare(
      `SELECT wallet, chain_id, expires_at
       FROM telegram_links
       WHERE code = ?`,
    )
    .bind(code)
    .first<{ wallet: string; chain_id: number; expires_at: number }>();
  if (!row || row.expires_at < now) return null;
  await db
    .prepare(`DELETE FROM telegram_links WHERE code = ?`)
    .bind(code)
    .run();
  // Look up the user's stored locale on user_thresholds. Falls back
  // to 'en' if the row doesn't exist yet (the link flow can run before
  // the first upsertThresholds call in some race orderings).
  const locRow = await db
    .prepare(
      `SELECT locale FROM user_thresholds WHERE wallet = ? AND chain_id = ?`,
    )
    .bind(row.wallet, row.chain_id)
    .first<{ locale: string }>();
  return {
    wallet: row.wallet,
    chainId: row.chain_id,
    locale: locRow?.locale ?? 'en',
  };
}

/** Store the Telegram chat id on the user's thresholds row. Called
 *  after a successful handshake. */
export async function linkTelegram(
  db: D1Database,
  wallet: string,
  chainId: number,
  chatId: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE user_thresholds
       SET tg_chat_id = ?, updated_at = ?
       WHERE wallet = ? AND chain_id = ?`,
    )
    .bind(chatId, Math.floor(Date.now() / 1000), wallet.toLowerCase(), chainId)
    .run();
}

/** Sweep expired handshake codes — run at the start of each cron tick
 *  to keep the table bounded. */
export async function sweepExpiredLinks(db: D1Database): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await db.prepare(`DELETE FROM telegram_links WHERE expires_at < ?`).bind(now).run();
}

// ─── Depth-tiered LTV — liquidity-confidence relay state ──────────────
// One row per (chain, collateral asset). Tracks the off-chain
// aggregator-confirmed tier and the consecutive-eligible-tick streak the
// promotion rule consumes. See `liquidityConfidence.ts` for the state
// machine; migration `apps/indexer/migrations/0011_liquidity_confidence.sql`.

export interface LiquidityConfidenceRow {
  chain_id: number;
  /** lowercased 0x address of the collateral asset */
  asset: string;
  /** the aggregator-confirmed tier at the last check (0-3) */
  agg_tier: number;
  /** the on-chain `keeperTier` at the last check (1-3) */
  on_chain_tier: number;
  /** consecutive ticks where `agg_tier > on_chain_tier` (eligible-to-promote) */
  healthy_streak: number;
  /** ts of the first tick in the current eligible streak, or null */
  first_eligible_ts: number | null;
  last_check_ts: number;
}

/** Read the confidence row for (chain, asset). `null` if unseen. */
export async function getLiquidityConfidence(
  db: D1Database,
  chainId: number,
  asset: string,
): Promise<LiquidityConfidenceRow | null> {
  const row = await db
    .prepare(
      `SELECT chain_id, asset, agg_tier, on_chain_tier, healthy_streak, first_eligible_ts, last_check_ts
       FROM liquidity_confidence
       WHERE chain_id = ? AND asset = ?`,
    )
    .bind(chainId, asset.toLowerCase())
    .first<LiquidityConfidenceRow>();
  return row ?? null;
}

/** Upsert the confidence row. */
export async function upsertLiquidityConfidence(
  db: D1Database,
  row: LiquidityConfidenceRow,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO liquidity_confidence
         (chain_id, asset, agg_tier, on_chain_tier, healthy_streak, first_eligible_ts, last_check_ts)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(chain_id, asset) DO UPDATE SET
         agg_tier = excluded.agg_tier,
         on_chain_tier = excluded.on_chain_tier,
         healthy_streak = excluded.healthy_streak,
         first_eligible_ts = excluded.first_eligible_ts,
         last_check_ts = excluded.last_check_ts`,
    )
    .bind(
      row.chain_id,
      row.asset.toLowerCase(),
      row.agg_tier,
      row.on_chain_tier,
      row.healthy_streak,
      row.first_eligible_ts,
      row.last_check_ts,
    )
    .run();
}

// ─── #1222 M3 B2-d1 — commitment-report scan state (Codex #1425 r2) ────────
// Written by the keeper only; schema owned by apps/indexer/migrations/0043.
// The scan frontier lets the entry-id walk cross arbitrarily long
// non-covering gaps across stateless invocations; the day marker lets
// resolved days be skipped with zero RPC reads.

export interface CommitmentScanRow {
  side: number;
  scan_next: string;
  last_cursor: string;
}

/** Resolved-day ids + per-(day, side) scan frontiers for one chain/range. */
export async function getCommitmentScanState(
  db: D1Database,
  chainId: number,
  fromDay: number,
  toDay: number,
): Promise<{
  resolved: Set<number>;
  scans: Map<string, { scanNext: bigint; lastCursor: bigint }>;
}> {
  const [days, rows] = await Promise.all([
    db
      .prepare(
        `SELECT day_id FROM keeper_commitment_day
         WHERE chain_id = ?1 AND day_id >= ?2 AND day_id < ?3`,
      )
      .bind(chainId, fromDay, toDay)
      .all<{ day_id: number }>(),
    db
      .prepare(
        `SELECT day_id, side, scan_next, last_cursor FROM keeper_commitment_scan
         WHERE chain_id = ?1 AND day_id >= ?2 AND day_id < ?3`,
      )
      .bind(chainId, fromDay, toDay)
      .all<{ day_id: number; side: number; scan_next: string; last_cursor: string }>(),
  ]);
  const resolved = new Set<number>((days.results ?? []).map((r) => r.day_id));
  const scans = new Map<string, { scanNext: bigint; lastCursor: bigint }>();
  for (const r of rows.results ?? []) {
    scans.set(`${r.day_id}:${r.side}`, {
      scanNext: BigInt(r.scan_next),
      lastCursor: BigInt(r.last_cursor),
    });
  }
  return { resolved, scans };
}

/** Persist a (day, side) scan frontier + the on-chain cursor it was built on. */
export async function putCommitmentScanFrontier(
  db: D1Database,
  chainId: number,
  dayId: number,
  side: number,
  scanNext: bigint,
  lastCursor: bigint,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO keeper_commitment_scan
         (chain_id, day_id, side, scan_next, last_cursor, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT(chain_id, day_id, side) DO UPDATE SET
         scan_next = excluded.scan_next,
         last_cursor = excluded.last_cursor,
         updated_at = excluded.updated_at`,
    )
    .bind(chainId, dayId, side, scanNext.toString(), lastCursor.toString(), Math.floor(Date.now() / 1000))
    .run();
}

/** Mark a chain-day's commitment report as complete + sent (skip forever). */
export async function markCommitmentDayResolved(
  db: D1Database,
  chainId: number,
  dayId: number,
): Promise<void> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO keeper_commitment_day (chain_id, day_id, resolved_at)
       VALUES (?1, ?2, ?3)`,
    )
    .bind(chainId, dayId, Math.floor(Date.now() / 1000))
    .run();
}

// ─── #1222 M3 B2-d2 — remit-ack scan state + reconcile rediscovery ─────────
// Written by the keeper only; schema owned by apps/indexer/migrations/0044.

/** The remit-ack scan state for a Base chain: the terminal-prefix
 *  frontier + the rotating scan cursor (Codex #1426 r1 — a stuck early
 *  Pending pins the frontier; the cursor keeps paging the whole ledger). */
export async function getRemitAckScanState(
  db: D1Database,
  baseChainId: number,
): Promise<{ frontier: number; scanCursor: number }> {
  const row = await db
    .prepare(
      `SELECT next_remit_id, scan_cursor FROM keeper_remit_ack_frontier
       WHERE base_chain_id = ?1`,
    )
    .bind(baseChainId)
    .first<{ next_remit_id: number; scan_cursor: number }>();
  return {
    frontier: row?.next_remit_id ?? 1,
    scanCursor: row?.scan_cursor ?? 1,
  };
}

/** Persist the remit-ack scan state (frontier only ever advances). */
export async function putRemitAckScanState(
  db: D1Database,
  baseChainId: number,
  nextRemitId: number,
  scanCursor: number,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO keeper_remit_ack_frontier
         (base_chain_id, next_remit_id, scan_cursor, updated_at)
       VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(base_chain_id) DO UPDATE SET
         next_remit_id = excluded.next_remit_id,
         scan_cursor = excluded.scan_cursor,
         updated_at = excluded.updated_at`,
    )
    .bind(baseChainId, nextRemitId, scanCursor, Math.floor(Date.now() / 1000))
    .run();
}

/** Last ack-attempt timestamps for a set of pending remit ids. */
export async function getRemitAckAttempts(
  db: D1Database,
  baseChainId: number,
  remitIds: number[],
): Promise<Map<number, { attempts: number; lastAttemptAt: number }>> {
  const out = new Map<number, { attempts: number; lastAttemptAt: number }>();
  if (remitIds.length === 0) return out;
  const placeholders = remitIds.map(() => '?').join(',');
  const rows = await db
    .prepare(
      `SELECT remit_id, attempts, last_attempt_at FROM keeper_remit_ack
       WHERE base_chain_id = ? AND remit_id IN (${placeholders})`,
    )
    .bind(baseChainId, ...remitIds)
    .all<{ remit_id: number; attempts: number; last_attempt_at: number | null }>();
  for (const r of rows.results ?? []) {
    out.set(r.remit_id, {
      attempts: r.attempts,
      lastAttemptAt: r.last_attempt_at ?? 0,
    });
  }
  return out;
}

/** Record one ack send attempt for a reservation. */
export async function recordRemitAckAttempt(
  db: D1Database,
  baseChainId: number,
  remitId: number,
  mirrorChainId: number,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO keeper_remit_ack
         (base_chain_id, remit_id, mirror_chain_id, attempts, last_attempt_at)
       VALUES (?1, ?2, ?3, 1, ?4)
       ON CONFLICT(base_chain_id, remit_id) DO UPDATE SET
         attempts = keeper_remit_ack.attempts + 1,
         last_attempt_at = excluded.last_attempt_at`,
    )
    .bind(baseChainId, remitId, mirrorChainId, Math.floor(Date.now() / 1000))
    .run();
}

/** Stamp a reservation observed Acked on Base (audit trail terminal). */
export async function markRemitAcked(
  db: D1Database,
  baseChainId: number,
  remitId: number,
): Promise<void> {
  await db
    .prepare(
      `UPDATE keeper_remit_ack SET acked_at = ?3
       WHERE base_chain_id = ?1 AND remit_id = ?2 AND acked_at IS NULL`,
    )
    .bind(baseChainId, remitId, Math.floor(Date.now() / 1000))
    .run();
}

/** Open (un-consumed) reconciled day ids for a mirror chain (P7 union).
 *  Codex #1426 r3 — scoped to the mirror's CURRENT base chain: the shared
 *  D1 can hold rows from more than one canonical mesh (or a base
 *  rotation), and a stale mesh's days must not drive reports toward the
 *  current base. */
export async function getOpenReconciledDays(
  db: D1Database,
  baseChainId: number,
  mirrorChainId: number,
): Promise<number[]> {
  const rows = await db
    .prepare(
      `SELECT day_id FROM keeper_commitment_reconciled
       WHERE base_chain_id = ?1 AND mirror_chain_id = ?2 AND consumed_at IS NULL`,
    )
    .bind(baseChainId, mirrorChainId)
    .all<{ day_id: number }>();
  return (rows.results ?? []).map((r) => r.day_id);
}

/** Mark a reconciled (day, mirror) rediscovery consumed (report sent / terminal). */
export async function markReconciledDayConsumed(
  db: D1Database,
  baseChainId: number,
  mirrorChainId: number,
  dayId: number,
): Promise<void> {
  await db
    .prepare(
      `UPDATE keeper_commitment_reconciled SET consumed_at = ?4
       WHERE base_chain_id = ?1 AND mirror_chain_id = ?2 AND day_id = ?3
         AND consumed_at IS NULL`,
    )
    .bind(baseChainId, mirrorChainId, dayId, Math.floor(Date.now() / 1000))
    .run();
}
