/**
 * D1 helpers — thin wrappers over the prepared-statement API. Keeps
 * the watcher loop readable and centralises query shapes so schema
 * changes in `migrations/*.sql` touch only this file.
 *
 * TWO databases since #2450. Helpers over the keeper's PRIVATE tables
 * (`apps/keeper/migrations/`) take a `KeeperD1` — the branded `env.KEEPER_DB`
 * — so the compiler refuses the shared `env.DB` there. Every other helper takes
 * a plain `D1Database` and is handed `env.DB`. No statement here touches both
 * kinds of table: D1 cannot join across databases, so a helper that needs both
 * reads each side separately (see `recordHfBandNotifications`).
 */

import { chunkD1InList } from '@vaipakam/lib/d1Binds';
import type { KeeperD1 } from './env';

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
// Written by the keeper only. KEEPER-PRIVATE (#2450): schema in
// apps/keeper/migrations/0001 (it began as shared migration 0043), so every
// helper in this block takes the `KEEPER_DB` handle.
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
  db: KeeperD1,
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
  db: KeeperD1,
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
  db: KeeperD1,
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
// The remit-ack tables are KEEPER-PRIVATE (#2450): schema in
// apps/keeper/migrations/0001 (they began as shared migration 0044), so their
// helpers take the `KEEPER_DB` handle. The reconcile-rediscovery table below
// them, `keeper_commitment_reconciled`, stays SHARED — the indexer writes it —
// and its helpers take the shared `DB`.

/** The remit-ack scan state for a Base chain: the terminal-prefix
 *  frontier + the rotating scan cursor (Codex #1426 r1 — a stuck early
 *  Pending pins the frontier; the cursor keeps paging the whole ledger). */
export async function getRemitAckScanState(
  db: KeeperD1,
  baseChainId: number,
  diamond: string,
): Promise<{ frontier: number; scanCursor: number }> {
  const row = await db
    .prepare(
      `SELECT next_remit_id, scan_cursor FROM keeper_remit_ack_frontier
       WHERE base_chain_id = ?1 AND diamond = ?2`,
    )
    .bind(baseChainId, diamond.toLowerCase())
    .first<{ next_remit_id: number; scan_cursor: number }>();
  return {
    frontier: row?.next_remit_id ?? 1,
    scanCursor: row?.scan_cursor ?? 1,
  };
}

/** Persist the remit-ack scan state (frontier only ever advances). */
export async function putRemitAckScanState(
  db: KeeperD1,
  baseChainId: number,
  diamond: string,
  nextRemitId: number,
  scanCursor: number,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO keeper_remit_ack_frontier
         (base_chain_id, diamond, next_remit_id, scan_cursor, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT(base_chain_id, diamond) DO UPDATE SET
         next_remit_id = excluded.next_remit_id,
         scan_cursor = excluded.scan_cursor,
         updated_at = excluded.updated_at`,
    )
    .bind(
      baseChainId,
      diamond.toLowerCase(),
      nextRemitId,
      scanCursor,
      Math.floor(Date.now() / 1000),
    )
    .run();
}

/**
 * Last ack-attempt timestamps for a set of pending remit ids.
 *
 * CHUNKED, because this list is bounded by the BACKLOG and not by anything
 * this statement controls (#2234). The caller collects every Pending
 * reservation in a scan window `MAX_SCAN_PER_TICK = 200` ids wide, so with
 * 99 or more pending it asked for more than D1's 100-parameter cap allows and
 * threw — and threw again on every later tick, because a backlog does not
 * shrink while the pass that would drain it is failing.
 *
 * The consequence was worse than a lost tick: `putRemitAckScanState` runs
 * BEFORE this call, so the cursor had already moved past a window whose
 * acknowledgements were never attempted. Deliveries landed and the
 * bookkeeping that closes them did not follow.
 *
 * ONE SUBREQUEST, not one per chunk. `batch()` costs a single subrequest
 * however many statements it carries, which matters on a Worker with a
 * 50-per-invocation ceiling that this pass already spends against. It is also
 * transactional, which for a read of attempt counters buys consistency at no
 * cost worth naming.
 */
export async function getRemitAckAttempts(
  db: KeeperD1,
  baseChainId: number,
  diamond: string,
  remitIds: number[],
): Promise<Map<number, { attempts: number; lastAttemptAt: number }>> {
  const out = new Map<number, { attempts: number; lastAttemptAt: number }>();
  if (remitIds.length === 0) return out;
  const chunks = chunkD1InList(remitIds, {
    before: [baseChainId, diamond.toLowerCase()],
  });
  const results = await db.batch<{
    remit_id: number;
    attempts: number;
    last_attempt_at: number | null;
  }>(
    chunks.map((c) =>
      db
        .prepare(
          `SELECT remit_id, attempts, last_attempt_at FROM keeper_remit_ack
       WHERE base_chain_id = ? AND diamond = ? AND remit_id IN (${c.placeholders})`,
        )
        .bind(...c.binds),
    ),
  );
  for (const part of results) {
    for (const r of part.results ?? []) {
      out.set(r.remit_id, {
        attempts: r.attempts,
        lastAttemptAt: r.last_attempt_at ?? 0,
      });
    }
  }
  return out;
}

/** Record one ack send attempt for a reservation. */
export async function recordRemitAckAttempt(
  db: KeeperD1,
  baseChainId: number,
  diamond: string,
  remitId: number,
  mirrorChainId: number,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO keeper_remit_ack
         (base_chain_id, diamond, remit_id, mirror_chain_id, attempts, last_attempt_at)
       VALUES (?1, ?2, ?3, ?4, 1, ?5)
       ON CONFLICT(base_chain_id, diamond, remit_id) DO UPDATE SET
         attempts = keeper_remit_ack.attempts + 1,
         last_attempt_at = excluded.last_attempt_at`,
    )
    .bind(
      baseChainId,
      diamond.toLowerCase(),
      remitId,
      mirrorChainId,
      Math.floor(Date.now() / 1000),
    )
    .run();
}

/** Stamp a reservation observed Acked on Base (audit trail terminal). */
export async function markRemitAcked(
  db: KeeperD1,
  baseChainId: number,
  diamond: string,
  remitId: number,
): Promise<void> {
  await db
    .prepare(
      `UPDATE keeper_remit_ack SET acked_at = ?4
       WHERE base_chain_id = ?1 AND diamond = ?2 AND remit_id = ?3
         AND acked_at IS NULL`,
    )
    .bind(baseChainId, diamond.toLowerCase(), remitId, Math.floor(Date.now() / 1000))
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
  baseDiamond: string,
  mirrorChainId: number,
): Promise<number[]> {
  const rows = await db
    .prepare(
      `SELECT day_id FROM keeper_commitment_reconciled
       WHERE base_chain_id = ?1 AND base_diamond = ?2
         AND mirror_chain_id = ?3 AND consumed_at IS NULL`,
    )
    .bind(baseChainId, baseDiamond.toLowerCase(), mirrorChainId)
    .all<{ day_id: number }>();
  return (rows.results ?? []).map((r) => r.day_id);
}

/** Mark a reconciled (day, mirror) rediscovery consumed (report sent / terminal). */
export async function markReconciledDayConsumed(
  db: D1Database,
  baseChainId: number,
  baseDiamond: string,
  mirrorChainId: number,
  dayId: number,
): Promise<void> {
  await db
    .prepare(
      `UPDATE keeper_commitment_reconciled SET consumed_at = ?5
       WHERE base_chain_id = ?1 AND base_diamond = ?2
         AND mirror_chain_id = ?3 AND day_id = ?4 AND consumed_at IS NULL`,
    )
    .bind(
      baseChainId,
      baseDiamond.toLowerCase(),
      mirrorChainId,
      dayId,
      Math.floor(Date.now() / 1000),
    )
    .run();
}

// ─── #2450 — the sanctions-hold observer's reads, and ops-alert de-dup ──────

/**
 * The wallets whose sanctions-evidence chain is OPEN on `chainId`: those whose
 * LATEST evidence event is a `RewardSanctionsEvidenceRecorded` (a chain start
 * no clean read has ended since), lowercased. The indexer decodes every
 * Diamond event into `activity_events`, so the observer reads the chain's own
 * record of who was flagged instead of scanning logs itself.
 *
 * One row per wallet, decided per wallet, so nothing bounds it but the number
 * of open chains (Codex #2489 r1). The earlier read took the newest 5,000 rows
 * and decided from those, so a wallet whose chain started before the newest
 * 5,000 events dropped out while its chain still stood. A wallet whose chain
 * was CLEARED is not listed here: what it can still be owed by the pass is the
 * resolution of a staging record or domain, and {@link listOpenStagingOwners}
 * lists every owner of one of those, however old.
 */
export async function listOpenSanctionsChains(db: D1Database, chainId: number): Promise<string[]> {
  const rows = await db
    .prepare(
      `SELECT who FROM (
         SELECT lower(json_extract(args_json, '$.who')) AS who, kind,
                ROW_NUMBER() OVER (
                  PARTITION BY lower(json_extract(args_json, '$.who'))
                  ORDER BY block_number DESC, log_index DESC
                ) AS rn
           FROM activity_events
          WHERE chain_id = ?1
            AND kind IN ('RewardSanctionsEvidenceRecorded', 'RewardSanctionsEvidenceCleared')
       )
        WHERE rn = 1 AND kind = 'RewardSanctionsEvidenceRecorded'
        ORDER BY who`,
    )
    .bind(chainId)
    .all<{ who: string | null }>();
  return (rows.results ?? [])
    .map((r) => r.who)
    .filter((w): w is string => typeof w === 'string' && /^0x[0-9a-f]{40}$/.test(w));
}

/**
 * The open staging work the indexer's event log records on `chainId`, decided
 * per record and per domain (Codex #2489 r1): a record is open when its latest
 * `StagingRecordOpened` has no later `StagingRecordClosed`, a domain when its
 * latest `StagingDomainOpened` has no later `StagingDomainCleared`. Every close
 * path emits the close event (`LibRewardStaging._close`, both domain clears);
 * a record that is deleted without one was never announced as opened.
 *
 * Nothing bounds this by age or count: a Resolving record stays work until the
 * chain closes it, however long a held claimant waits. The earlier read took
 * the owners of records opened in the last 30 days, so a record still waiting
 * past that dropped out of the pass with its page never run.
 *
 * Positions compare `(block_number, log_index)` as one integer; a block's log
 * index is far below the multiplier.
 */
const OPEN_STAGING_SQL = `
  WITH ev AS (
    SELECT kind,
           lower(json_extract(args_json, '$.user')) AS who,
           lower(COALESCE(json_extract(args_json, '$.key'), json_extract(args_json, '$.domainKey'))) AS k,
           block_number * 1000000 + log_index AS pos
      FROM activity_events
     WHERE chain_id = ?1
       AND kind IN ('StagingRecordOpened', 'StagingRecordClosed', 'StagingDomainOpened', 'StagingDomainCleared')
  ),
  opened AS (
    SELECT CASE kind WHEN 'StagingRecordOpened' THEN 'record' ELSE 'domain' END AS what, k, who, MAX(pos) AS pos
      FROM ev WHERE kind IN ('StagingRecordOpened', 'StagingDomainOpened')
     GROUP BY what, k
  ),
  closed AS (
    SELECT CASE kind WHEN 'StagingRecordClosed' THEN 'record' ELSE 'domain' END AS what, k, MAX(pos) AS pos
      FROM ev WHERE kind IN ('StagingRecordClosed', 'StagingDomainCleared')
     GROUP BY what, k
  )
  SELECT o.what AS what, o.k AS k, o.who AS who, o.pos AS pos
    FROM opened o LEFT JOIN closed c ON c.what = o.what AND c.k = o.k
   WHERE c.pos IS NULL OR c.pos < o.pos`;

/** Distinct owners of an open staging record or domain on `chainId` —
 *  candidates the sanctions-hold pass classifies even when no evidence event
 *  names them (a claimant held with no observation chain, a cleared one). */
export async function listOpenStagingOwners(db: D1Database, chainId: number): Promise<string[]> {
  const rows = await db
    .prepare(`SELECT DISTINCT who FROM (${OPEN_STAGING_SQL}) ORDER BY who`)
    .bind(chainId)
    .all<{ who: string | null }>();
  return (rows.results ?? [])
    .map((r) => r.who)
    .filter((w): w is string => typeof w === 'string' && /^0x[0-9a-f]{40}$/.test(w));
}

/** The keys of `user`'s OPEN staging records on `chainId`, oldest first. A
 *  record key is the input to the permissionless resolution page; the record's
 *  own phase, read on chain, decides whether there is anything to resolve. */
export async function listOpenStagingRecordKeysForUser(
  db: D1Database,
  chainId: number,
  user: string,
): Promise<string[]> {
  const rows = await db
    .prepare(
      `SELECT k FROM (${OPEN_STAGING_SQL})
        WHERE what = 'record' AND who = ?2
        ORDER BY pos`,
    )
    .bind(chainId, user.toLowerCase())
    .all<{ k: string | null }>();
  return (rows.results ?? [])
    .map((r) => r.k)
    .filter((k): k is string => typeof k === 'string' && /^0x[0-9a-f]{64}$/.test(k));
}

/**
 * The loan parties of `chainId` — every lender and borrower the indexer has
 * recorded, original or current holder, lowercased, in address order — after
 * `after`, at most `limit`. The universe the sanctions-hold pass SCREENS
 * (Codex #2489 r2): interaction reward is earned by loan parties, and a party
 * flagged while it holds only ordinary (unstaged) reward leaves no evidence
 * event or staging record behind, so the oracle is the only signal and every
 * party has to be read against it. Address order makes the screen a stable
 * rotation.
 */
const LOAN_PARTIES_SQL = `
  SELECT addr FROM (
    SELECT lower(lender) AS addr FROM loans WHERE chain_id = ?1
    UNION SELECT lower(borrower) FROM loans WHERE chain_id = ?1
    UNION SELECT lower(lender_current_owner) FROM loans WHERE chain_id = ?1
    UNION SELECT lower(borrower_current_owner) FROM loans WHERE chain_id = ?1
  )
  WHERE addr LIKE '0x%' AND length(addr) = 42`;

export async function listLoanPartiesAfter(
  db: D1Database,
  chainId: number,
  after: string,
  limit: number,
): Promise<string[]> {
  const rows = await db
    .prepare(`${LOAN_PARTIES_SQL} AND addr > ?2 ORDER BY addr LIMIT ?3`)
    .bind(chainId, after.toLowerCase(), limit)
    .all<{ addr: string }>();
  return (rows.results ?? []).map((r) => r.addr);
}

/** How many loan parties {@link listLoanPartiesAfter} rotates through. */
export async function countLoanParties(db: D1Database, chainId: number): Promise<number> {
  const row = await db.prepare(`SELECT COUNT(*) AS n FROM (${LOAN_PARTIES_SQL})`).bind(chainId).first<{ n: number }>();
  return Number(row?.n ?? 0);
}

// The reads above are SHARED (the indexer's `activity_events`); the ops-alert
// helpers below are KEEPER-PRIVATE (#2450, apps/keeper/migrations/0001) — ops
// alert state stays out of the user-facing database — and take `KEEPER_DB`.

/** The ops-alert record for `key`, or null when none was sent. */
export async function getOpsAlert(
  db: KeeperD1,
  key: string,
): Promise<{ firstSeenAt: number; lastSentAt: number } | null> {
  const row = await db
    .prepare(`SELECT first_seen_at, last_sent_at FROM keeper_ops_alert WHERE alert_key = ?1`)
    .bind(key)
    .first<{ first_seen_at: number; last_sent_at: number }>();
  return row ? { firstSeenAt: row.first_seen_at, lastSentAt: row.last_sent_at } : null;
}

/** Record a DELIVERED ops alert (first delivery keeps `first_seen_at`). */
export async function recordOpsAlertSent(db: KeeperD1, key: string, nowSec: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO keeper_ops_alert (alert_key, first_seen_at, last_sent_at)
       VALUES (?1, ?2, ?2)
       ON CONFLICT(alert_key) DO UPDATE SET last_sent_at = excluded.last_sent_at`,
    )
    .bind(key, nowSec)
    .run();
}

/** The open ops-alert keys matching a SQL `LIKE` pattern (a pass's own key
 *  prefix), so a pass clears only the alerts that are actually open. */
export async function listOpsAlertKeys(db: KeeperD1, likePattern: string): Promise<string[]> {
  const rows = await db
    .prepare(`SELECT alert_key FROM keeper_ops_alert WHERE alert_key LIKE ?1`)
    .bind(likePattern)
    .all<{ alert_key: string }>();
  return (rows.results ?? []).map((r) => r.alert_key);
}

/** Forget `key` once its condition has cleared, so a recurrence alerts at once. */
export async function clearOpsAlert(db: KeeperD1, key: string): Promise<void> {
  await db.prepare(`DELETE FROM keeper_ops_alert WHERE alert_key = ?1`).bind(key).run();
}

// ─── #1944 / transport epochs — the delivery-proof pass's discovery read ─────

/** One budget delivery a mirror recorded, joined to its day-list event. */
export interface BudgetDeliveryRow {
  /** The packet's ingress stamp (`IngressPacketRecorded.packetHash`). */
  packetHash: string;
  /** Base's remittance id (0 for a manual / legacy delivery). */
  remitId: string;
  /** The FLAT day list from `RewardBudgetReceived` (decimal strings), or null
   *  for a rooted (d6) delivery, whose list is rebuilt from Base. */
  flatDayIds: string[] | null;
  /** True for a rooted (d6) delivery (`RewardBudgetRootReceived`). */
  rooted: boolean;
  block_at: number;
}

/** Budget-packet kind (`LibRewardCustody.PACKET_KIND_BUDGET`). */
const PACKET_KIND_BUDGET = 1;

/**
 * EVERY budget delivery recorded on `chainId`, oldest first: each packet joined
 * (same transaction) to the event that carries its day list — the flat list
 * itself, or the rooted wire's marker. The indexer decodes every Diamond event
 * into `activity_events`, so no log scan is needed.
 *
 * No age and no count bound (Codex #2489 r1): a delivery is work until the
 * chain shows it whole, and the earlier 45-day / 200-row window let one still
 * waiting on its proof drop out for good. What keeps a tick's chain work
 * bounded is the keeper's DONE set ({@link listWorkDone}): the pass skips every
 * packet it has seen finished, so only open deliveries are read on chain. The
 * rows read here grow by one per delivery ever made to this mirror.
 */
export async function listBudgetDeliveries(db: D1Database, chainId: number): Promise<BudgetDeliveryRow[]> {
  const rows = await db
    .prepare(
      `SELECT json_extract(p.args_json, '$.packetHash') AS packet_hash,
              json_extract(p.args_json, '$.remitId')    AS remit_id,
              d.kind                                     AS day_kind,
              json_extract(d.args_json, '$.dayIds')      AS day_ids,
              p.block_at                                 AS block_at
         FROM activity_events p
         LEFT JOIN activity_events d
           ON d.chain_id = p.chain_id AND d.tx_hash = p.tx_hash
          AND d.kind IN ('RewardBudgetReceived', 'RewardBudgetRootReceived')
          -- One CCIP execution can land more than one delivery: pair each packet
          -- with ITS delivery event (one receipt per remit and source), never
          -- with every delivery of the transaction.
          AND CAST(json_extract(d.args_json, '$.remitId') AS TEXT) = CAST(json_extract(p.args_json, '$.remitId') AS TEXT)
          AND CAST(json_extract(d.args_json, '$.sourceChainId') AS TEXT) = CAST(json_extract(p.args_json, '$.sourceChainId') AS TEXT)
        WHERE p.chain_id = ?1
          AND p.kind = 'IngressPacketRecorded'
          AND CAST(json_extract(p.args_json, '$.kind') AS INTEGER) = ?2
        ORDER BY p.block_number ASC, p.log_index ASC`,
    )
    .bind(chainId, PACKET_KIND_BUDGET)
    .all<{ packet_hash: string | null; remit_id: string | number | null; day_kind: string | null; day_ids: string | null; block_at: number }>();
  const out: BudgetDeliveryRow[] = [];
  for (const r of rows.results ?? []) {
    if (typeof r.packet_hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(r.packet_hash)) continue;
    if (r.day_kind !== 'RewardBudgetReceived' && r.day_kind !== 'RewardBudgetRootReceived') continue;
    let flat: string[] | null = null;
    if (r.day_kind === 'RewardBudgetReceived') {
      try {
        const parsed = JSON.parse(r.day_ids ?? '[]');
        if (!Array.isArray(parsed)) continue;
        flat = parsed.map((x) => String(x));
      } catch {
        continue;
      }
    }
    out.push({
      packetHash: r.packet_hash,
      remitId: String(r.remit_id ?? '0'),
      flatDayIds: flat,
      rooted: r.day_kind === 'RewardBudgetRootReceived',
      block_at: r.block_at,
    });
  }
  return out;
}

// ─── #1461 — released remittances whose delivery may still land ─────────────

/** EVERY remit id the canonical chain RELEASED, oldest first, from the
 *  indexer's record of `RemitReservationReleased`. The ack pass's frontier scan
 *  treats a released reservation as terminal, so a delivery that executes after
 *  its release is found here instead.
 *
 *  No count bound (Codex #2489 r1): the earlier newest-50 read let a release
 *  still awaiting its late acknowledgement drop out behind 50 newer ones. The
 *  pass skips every release in the keeper's DONE set ({@link listWorkDone}), so
 *  only open ones are read on chain. */
export async function listReleasedRemitIds(db: D1Database, chainId: number): Promise<number[]> {
  const rows = await db
    .prepare(
      `SELECT CAST(json_extract(args_json, '$.remitId') AS INTEGER) AS remit_id
         FROM activity_events
        WHERE chain_id = ?1 AND kind = 'RemitReservationReleased'
        GROUP BY remit_id
        ORDER BY MIN(block_number)`,
    )
    .bind(chainId)
    .all<{ remit_id: number | null }>();
  return (rows.results ?? [])
    .map((r) => r.remit_id)
    .filter((id): id is number => typeof id === 'number' && Number.isSafeInteger(id) && id > 0);
}

// ─── #2489 r1 — the keeper's DONE set (keeper-private, migration 0002) ───────

/** The passes that keep a done set, by the `kind` each records under. */
export type WorkKind = 'delivery_proof' | 'late_ack';

/**
 * The items `kind` has CONFIRMED DONE on chain for `(chainId, diamond)`. A pass
 * reads every candidate the shared event log holds and skips these, so an item
 * stays a candidate until the chain shows it finished, never until it ages out
 * of a window. Keyed by the Diamond too: a fresh redeploy restarts the ids a
 * pass records (remit ids count from 1 again).
 */
export async function listWorkDone(
  db: KeeperD1,
  chainId: number,
  diamond: string,
  kind: WorkKind,
): Promise<Set<string>> {
  const rows = await db
    .prepare(`SELECT item FROM keeper_work_done WHERE chain_id = ?1 AND diamond = ?2 AND kind = ?3`)
    .bind(chainId, diamond.toLowerCase(), kind)
    .all<{ item: string }>();
  return new Set((rows.results ?? []).map((r) => r.item));
}

/** Record `items` as done — only on an on-chain read that shows them finished.
 *  Idempotent; one statement per item, all in one batch. */
export async function markWorkDone(
  db: KeeperD1,
  chainId: number,
  diamond: string,
  kind: WorkKind,
  items: readonly string[],
): Promise<void> {
  if (items.length === 0) return;
  const now = Math.floor(Date.now() / 1000);
  await db.batch(
    items.map((item) =>
      db
        .prepare(
          `INSERT OR IGNORE INTO keeper_work_done (chain_id, diamond, kind, item, done_at) VALUES (?1, ?2, ?3, ?4, ?5)`,
        )
        .bind(chainId, diamond.toLowerCase(), kind, item, now),
    ),
  );
}

// ─── #2489 r2 — the sanctions-hold screen cursor (keeper-private, 0002) ──────

/** Where the sanctions-hold screen resumes on `(chainId, diamond)`: the last
 *  address screened, or '' to start from the first. */
export async function getSanctionsScreenCursor(db: KeeperD1, chainId: number, diamond: string): Promise<string> {
  const row = await db
    .prepare(`SELECT cursor FROM keeper_sanctions_screen WHERE chain_id = ?1 AND diamond = ?2`)
    .bind(chainId, diamond.toLowerCase())
    .first<{ cursor: string }>();
  return row?.cursor ?? '';
}

/** Record where the screen resumes. */
export async function putSanctionsScreenCursor(
  db: KeeperD1,
  chainId: number,
  diamond: string,
  cursor: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO keeper_sanctions_screen (chain_id, diamond, cursor, updated_at) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT (chain_id, diamond) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at`,
    )
    .bind(chainId, diamond.toLowerCase(), cursor.toLowerCase(), Math.floor(Date.now() / 1000))
    .run();
}
