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
      `SELECT wallet, chain_id, warn_hf, alert_hf, critical_hf, tg_chat_id, push_channel
       FROM user_thresholds
       WHERE chain_id = ?`,
    )
    .bind(chainId)
    .all<UserThresholds>();
  return res.results ?? [];
}

/** Upsert a user's thresholds. Called from the frontend settings page
 *  via the HTTP handler. */
export async function upsertThresholds(
  db: D1Database,
  t: Omit<UserThresholds, 'tg_chat_id' | 'push_channel'> & {
    tg_chat_id?: string | null;
    push_channel?: string | null;
  },
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await db
    .prepare(
      `INSERT INTO user_thresholds
         (wallet, chain_id, warn_hf, alert_hf, critical_hf, tg_chat_id, push_channel, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(wallet, chain_id) DO UPDATE SET
         warn_hf = excluded.warn_hf,
         alert_hf = excluded.alert_hf,
         critical_hf = excluded.critical_hf,
         tg_chat_id = COALESCE(excluded.tg_chat_id, user_thresholds.tg_chat_id),
         push_channel = COALESCE(excluded.push_channel, user_thresholds.push_channel),
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
 *  a user DMs the code. Returns the linked wallet/chain, or null if
 *  expired / unknown. */
export async function consumeTelegramLinkCode(
  db: D1Database,
  code: string,
): Promise<{ wallet: string; chainId: number } | null> {
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
  return { wallet: row.wallet, chainId: row.chain_id };
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
