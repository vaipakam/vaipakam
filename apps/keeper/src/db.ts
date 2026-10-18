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

import { getDeployment } from '@vaipakam/contracts/deployments';
import { chunkD1InList } from '@vaipakam/lib/d1Binds';
import { encodeAbiParameters, keccak256, type Hex } from 'viem';
import type { KeeperD1 } from './env';
import { assertGuardedWriteLanded, epochWriteGuard } from './epochFence';


/**
 * The first block of the ACTIVE Diamond on `chainId` (#2497 r3). The event
 * ledger (`activity_events`) is append-only and outlives a redeploy, while
 * every keeper done set is keyed by the Diamond — so a read of the ledger
 * without this floor would hand the new Diamond the old one's history to
 * re-check forever. ONE floor for every keeper read of the ledger; 0 (read
 * everything) only for a chain the deployment record does not know.
 */
export function deploymentFloor(chainId: number): number {
  const b = getDeployment(chainId)?.deployBlock;
  return typeof b === 'number' && Number.isSafeInteger(b) && b > 0 ? b : 0;
}

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
  // Guarded in the statement (epochFence.ts): written only while the
  // indexer's epoch for the chain is the one this process runs under.
  const guard = epochWriteGuard(s.chain_id);
  const result = await db
    .prepare(
      `INSERT INTO notify_state
         (wallet, chain_id, loan_id, last_band, last_hf_milli, last_sent_ts)
       SELECT ?, ?, ?, ?, ?, ? WHERE ${guard.where}
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
      ...guard.binds,
    )
    .run();
  assertGuardedWriteLanded(result, `notify_state for chain ${s.chain_id} loan ${s.loan_id}`);
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
  const guard = epochWriteGuard(chainId); // epochFence.ts: atomic with the write
  const result = await db
    .prepare(
      `INSERT INTO pre_grace_notify_state
         (wallet, chain_id, loan_id, last_sent_ts)
       SELECT ?, ?, ?, ? WHERE ${guard.where}
       ON CONFLICT(wallet, chain_id, loan_id) DO UPDATE SET
         last_sent_ts = excluded.last_sent_ts`,
    )
    .bind(wallet, chainId, loanId, lastSentTs, ...guard.binds)
    .run();
  assertGuardedWriteLanded(result, `pre_grace_notify_state for chain ${chainId} loan ${loanId}`);
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
  const guard = epochWriteGuard(row.chain_id); // epochFence.ts: atomic with the write
  const result = await db
    .prepare(
      `INSERT INTO liquidity_confidence
         (chain_id, asset, agg_tier, on_chain_tier, healthy_streak, first_eligible_ts, last_check_ts)
       SELECT ?, ?, ?, ?, ?, ?, ? WHERE ${guard.where}
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
      ...guard.binds,
    )
    .run();
  assertGuardedWriteLanded(result, `liquidity_confidence for chain ${row.chain_id} asset ${row.asset}`);
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
  /** The packet's block, for the pass's done frontier (#2497 r4). */
  block: number;
}

/** Budget-packet kind (`LibRewardCustody.PACKET_KIND_BUDGET`). */
const PACKET_KIND_BUDGET = 1;

/**
 * EVERY budget delivery recorded on the ACTIVE Diamond of `chainId`, oldest
 * first, each packet paired with the event that carries its day list — the
 * flat list itself, or the rooted wire's marker.
 *
 * PAIRING IS VERIFIED, never inferred (#2497 r3, root fix). The packet's own
 * stamp event names it AND its commitment: `IngressPacketDayListRecorded
 * (packetHash, dayListHash)` for a flat list, `IngressPacketDayListRooted
 * (packetHash, dayListRoot)` for a rooted one. A delivery event in the same
 * transaction belongs to the packet only when it carries THAT commitment: its
 * `dayListRoot` equals the stamped root, or `keccak256(abi.encode(dayIds))`
 * equals the stamped hash — the contract's own formula
 * (`LibRewardCustody.stampPacketDayList`). Two zero-id deliveries in one
 * transaction can no longer swap lists, and a packet with no verified match is
 * left out (a pre-3a packet with no commitment is not provable anyway).
 *
 * No age and no count bound on what is WORK (Codex #2489 r1): a delivery is
 * work until the chain shows it whole. The READ is bounded instead (#2497 r8):
 * the pass discovers deliveries a page at a time past its cursor
 * ({@link discoverBudgetDeliveries}) into its open-work queue, and the active
 * Diamond's first block ({@link deploymentFloor}) keeps a redeploy's history out.
 */
export async function listBudgetDeliveries(db: D1Database, chainId: number, fromBlock: number): Promise<BudgetDeliveryRow[]> {
  return pairBudgetDeliveries(await budgetEvents(db, chainId, fromBlock, Number.MAX_SAFE_INTEGER, null));
}

/** One discovery page of {@link listBudgetDeliveries}: the deliveries in
 *  `[from, through]`, read `limit` events at a time and cut at a block
 *  boundary ({@link pageByBlock}), so a packet's events — one transaction —
 *  are always paired together. */
export async function discoverBudgetDeliveries(
  db: D1Database,
  chainId: number,
  from: number,
  through: number,
  limit: number,
): Promise<{ rows: BudgetDeliveryRow[]; next: number }> {
  const page = await pageByBlock((f, t, l) => budgetEvents(db, chainId, f, t, l), from, through, limit);
  return { rows: pairBudgetDeliveries(page.rows), next: page.next };
}

type BudgetEventRow = { kind: string; tx_hash: string; args_json: string; block_at: number; block_number: number };

async function budgetEvents(db: D1Database, chainId: number, from: number, through: number, limit: number | null): Promise<BudgetEventRow[]> {
  const rows = await db
    .prepare(
      `SELECT kind, tx_hash, args_json, block_at, block_number
         FROM activity_events
        WHERE chain_id = ?1 AND block_number >= ?2 AND block_number <= ?3
          AND kind IN ('IngressPacketRecorded', 'IngressPacketDayListRecorded', 'IngressPacketDayListRooted',
                       'RewardBudgetReceived', 'RewardBudgetRootReceived')
        ORDER BY block_number ASC, log_index ASC
        LIMIT ?4`,
    )
    .bind(chainId, from, through, limit ?? -1)
    .all<BudgetEventRow>();
  return rows.results ?? [];
}

function pairBudgetDeliveries(eventRows: readonly BudgetEventRow[]): BudgetDeliveryRow[] {
  type Ev = { kind: string; tx: string; args: Record<string, unknown>; block_at: number; block: number };
  const evs: Ev[] = [];
  for (const r of eventRows) {
    try {
      evs.push({
        kind: r.kind,
        tx: r.tx_hash,
        args: JSON.parse(r.args_json) as Record<string, unknown>,
        block_at: r.block_at,
        block: Number(r.block_number),
      });
    } catch {
      /* an unreadable row pairs with nothing */
    }
  }
  const lower = (v: unknown) => (typeof v === 'string' ? v.toLowerCase() : '');
  const flatStamp = new Map<string, string>(); // packetHash -> dayListHash
  const rootStamp = new Map<string, string>(); // packetHash -> dayListRoot
  const deliveriesByTx = new Map<string, Ev[]>();
  for (const e of evs) {
    if (e.kind === 'IngressPacketDayListRecorded') flatStamp.set(lower(e.args.packetHash), lower(e.args.dayListHash));
    else if (e.kind === 'IngressPacketDayListRooted') rootStamp.set(lower(e.args.packetHash), lower(e.args.dayListRoot));
    else if (e.kind === 'RewardBudgetReceived' || e.kind === 'RewardBudgetRootReceived') {
      const list = deliveriesByTx.get(e.tx) ?? [];
      list.push(e);
      deliveriesByTx.set(e.tx, list);
    }
  }
  const out: BudgetDeliveryRow[] = [];
  for (const p of evs) {
    if (p.kind !== 'IngressPacketRecorded' || Number(p.args.kind) !== PACKET_KIND_BUDGET) continue;
    const packetHash = lower(p.args.packetHash);
    if (!/^0x[0-9a-f]{64}$/.test(packetHash)) continue;
    const candidates = deliveriesByTx.get(p.tx) ?? [];
    const root = rootStamp.get(packetHash);
    const hash = flatStamp.get(packetHash);
    let matched: { flat: string[] | null; rooted: boolean } | null = null;
    if (root !== undefined) {
      if (candidates.some((d) => d.kind === 'RewardBudgetRootReceived' && lower(d.args.dayListRoot) === root)) {
        matched = { flat: null, rooted: true };
      }
    } else if (hash !== undefined) {
      for (const d of candidates) {
        if (d.kind !== 'RewardBudgetReceived' || !Array.isArray(d.args.dayIds)) continue;
        const ids = (d.args.dayIds as unknown[]).map((x) => String(x));
        let ok = false;
        try {
          ok = flatDayListHash(ids) === hash;
        } catch {
          ok = false;
        }
        if (ok) {
          matched = { flat: ids, rooted: false };
          break;
        }
      }
    }
    if (matched === null) continue;
    out.push({
      packetHash: p.args.packetHash as string,
      remitId: String(p.args.remitId ?? '0'),
      flatDayIds: matched.flat,
      rooted: matched.rooted,
      block_at: p.block_at,
      block: p.block,
    });
  }
  return out;
}

/** The contract's flat day-list commitment: `keccak256(abi.encode(uint256[]))`. */
export function flatDayListHash(dayIds: readonly string[]): string {
  return keccak256(encodeAbiParameters([{ type: 'uint256[]' }], [dayIds.map((d) => BigInt(d))])).toLowerCase() as Hex;
}

/** EVERY remit id the canonical chain RELEASED, oldest first, from the
 *  indexer's record of `RemitReservationReleased`. The ack pass's frontier scan
 *  treats a released reservation as terminal, so a delivery that executes after
 *  its release is found here instead.
 *
 *  No count bound on what is work (Codex #2489 r1): the earlier newest-50 read
 *  let a release still awaiting its late acknowledgement drop out behind 50
 *  newer ones. The pass discovers releases a page at a time
 *  ({@link discoverReleasedRemits}) into its open-work queue (#2497 r8). */
export async function listReleasedRemitIds(db: D1Database, chainId: number, fromBlock: number): Promise<number[]> {
  return (await listReleasedRemits(db, chainId, fromBlock)).map((r) => r.remitId);
}

/** {@link listReleasedRemitIds} with each release's first block. */
export async function listReleasedRemits(
  db: D1Database,
  chainId: number,
  fromBlock: number,
): Promise<{ remitId: number; block: number }[]> {
  return firstReleases(await releaseEvents(db, chainId, fromBlock, Number.MAX_SAFE_INTEGER, null));
}

/** One discovery page of {@link listReleasedRemits} in `[from, through]`, cut
 *  at a block boundary ({@link pageByBlock}). A remit released twice is listed
 *  once per page; the queue's insert is idempotent across pages. */
export async function discoverReleasedRemits(
  db: D1Database,
  chainId: number,
  from: number,
  through: number,
  limit: number,
): Promise<{ rows: { remitId: number; block: number }[]; next: number }> {
  const page = await pageByBlock((f, t, l) => releaseEvents(db, chainId, f, t, l), from, through, limit);
  return { rows: firstReleases(page.rows), next: page.next };
}

type ReleaseEventRow = { remit_id: number | null; block_number: number };

async function releaseEvents(db: D1Database, chainId: number, from: number, through: number, limit: number | null): Promise<ReleaseEventRow[]> {
  const rows = await db
    .prepare(
      `SELECT CAST(json_extract(args_json, '$.remitId') AS INTEGER) AS remit_id, block_number
         FROM activity_events
        WHERE chain_id = ?1 AND block_number >= ?2 AND block_number <= ?3 AND kind = 'RemitReservationReleased'
        ORDER BY block_number ASC, log_index ASC
        LIMIT ?4`,
    )
    .bind(chainId, from, through, limit ?? -1)
    .all<ReleaseEventRow>();
  return rows.results ?? [];
}

function firstReleases(rows: readonly ReleaseEventRow[]): { remitId: number; block: number }[] {
  const seen = new Map<number, number>();
  for (const r of rows) {
    const id = r.remit_id;
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) continue;
    if (!seen.has(id)) seen.set(id, Number(r.block_number));
  }
  return [...seen].map(([remitId, block]) => ({ remitId, block }));
}

// ─── #2497 r8 — the OPEN-WORK queue (keeper-private, migration 0003) ─

/** The passes that keep an open-work queue, by the `kind` each records under. */
export type WorkKind = 'delivery_proof' | 'late_ack';

/** The last block the shared indexer has completely recorded on `chainId`
 *  (its `diamond` cursor, advanced only after a whole window is written), or
 *  null when it cannot be read. The keeper's done frontiers never pass it. */
export async function indexedThrough(db: D1Database, chainId: number): Promise<number | null> {
  try {
    const row = await db
      .prepare(`SELECT last_block FROM indexer_cursor WHERE chain_id = ? AND kind = 'diamond'`)
      .bind(chainId)
      .first<{ last_block: number }>();
    const b = Number(row?.last_block);
    return row && Number.isSafeInteger(b) && b >= 0 ? b : null;
  } catch {
    return null;
  }
}

/** The first ledger block the pass has not yet discovered work in; 0 when none
 *  is recorded (the caller floors it at the active Diamond's deploy block). */
export async function getWorkCursor(db: KeeperD1, chainId: number, diamond: string, kind: WorkKind): Promise<number> {
  const row = await db
    .prepare('SELECT next_block FROM keeper_work_cursor WHERE chain_id = ? AND diamond = ? AND kind = ?')
    .bind(chainId, diamond.toLowerCase(), kind)
    .first<{ next_block: number }>();
  const b = Number(row?.next_block ?? 0);
  return Number.isSafeInteger(b) && b > 0 ? b : 0;
}

/** Move the discovery cursor forward — never back (`MAX`). */
export async function putWorkCursor(db: KeeperD1, chainId: number, diamond: string, kind: WorkKind, nextBlock: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO keeper_work_cursor (chain_id, diamond, kind, next_block, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (chain_id, diamond, kind) DO UPDATE SET next_block = MAX(next_block, excluded.next_block), updated_at = excluded.updated_at`,
    )
    .bind(chainId, diamond.toLowerCase(), kind, nextBlock, Math.floor(Date.now() / 1000))
    .run();
}

/** One discovered item: its id, ledger block and what the pass needs to work it. */
export interface WorkItem<T> {
  item: string;
  block: number;
  payload: T;
}

/** Queue `items` as open. Idempotent: an item already queued keeps its row,
 *  so re-discovering a block is harmless. */
export async function enqueueWork<T>(
  db: KeeperD1,
  chainId: number,
  diamond: string,
  kind: WorkKind,
  items: readonly WorkItem<T>[],
): Promise<void> {
  if (items.length === 0) return;
  const now = Math.floor(Date.now() / 1000);
  await db.batch(
    items.map((w) =>
      db
        .prepare(
          `INSERT OR IGNORE INTO keeper_work_open (chain_id, diamond, kind, item, block, payload, checked_at, added_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7)`,
        )
        .bind(chainId, diamond.toLowerCase(), kind, w.item, w.block, JSON.stringify(w.payload), now),
    ),
  );
}

/** A bounded slice of the open items, the least recently checked first (then
 *  the oldest), so every open item is reached in turn however many there are,
 *  and one that never finishes holds back nothing but its own slot. */
export async function listOpenWork<T>(
  db: KeeperD1,
  chainId: number,
  diamond: string,
  kind: WorkKind,
  limit: number,
): Promise<WorkItem<T>[]> {
  const rows = await db
    .prepare(
      `SELECT item, block, payload FROM keeper_work_open
        WHERE chain_id = ?1 AND diamond = ?2 AND kind = ?3
        ORDER BY checked_at ASC, block ASC, item ASC LIMIT ?4`,
    )
    .bind(chainId, diamond.toLowerCase(), kind, limit)
    .all<{ item: string; block: number; payload: string }>();
  const out: WorkItem<T>[] = [];
  for (const r of rows.results ?? []) {
    try {
      out.push({ item: r.item, block: Number(r.block), payload: JSON.parse(r.payload) as T });
    } catch {
      console.warn(`[keeper] open work ${kind} item=${r.item}: unreadable payload, left queued`);
    }
  }
  return out;
}

/** Stamp `items` as checked now, moving them to the back of the rotation. */
export async function touchOpenWork(db: KeeperD1, chainId: number, diamond: string, kind: WorkKind, items: readonly string[]): Promise<void> {
  if (items.length === 0) return;
  const now = Math.floor(Date.now() / 1000);
  for (const c of chunkD1InList(items, { before: [now, chainId, diamond.toLowerCase(), kind] })) {
    await db
      .prepare(`UPDATE keeper_work_open SET checked_at = ? WHERE chain_id = ? AND diamond = ? AND kind = ? AND item IN (${c.placeholders})`)
      .bind(...c.binds)
      .run();
  }
}

/** Retire `items` — only on an on-chain read that shows them finished. */
export async function finishWork(db: KeeperD1, chainId: number, diamond: string, kind: WorkKind, items: readonly string[]): Promise<void> {
  if (items.length === 0) return;
  for (const c of chunkD1InList(items, { before: [chainId, diamond.toLowerCase(), kind] })) {
    await db
      .prepare(`DELETE FROM keeper_work_open WHERE chain_id = ? AND diamond = ? AND kind = ? AND item IN (${c.placeholders})`)
      .bind(...c.binds)
      .run();
  }
}

/**
 * One discovery PAGE of ledger rows in `[from, through]`, cut at a block
 * boundary so no block — and so no transaction — is split across pages:
 * `limit + 1` rows are read, and when the page overflows, the rows of its last
 * block are left for the next page. A single block holding more than a page is
 * read whole. `next` is the first block the next page starts at. Pure over
 * `fetch`; pinned by the tests.
 */
export async function pageByBlock<R extends { block_number: number }>(
  fetch: (from: number, through: number, limit: number | null) => Promise<R[]>,
  from: number,
  through: number,
  limit: number,
): Promise<{ rows: R[]; next: number }> {
  const rows = await fetch(from, through, limit + 1);
  if (rows.length <= limit) return { rows, next: through + 1 };
  const cut = Number(rows[limit].block_number);
  const below = rows.filter((r) => Number(r.block_number) < cut);
  if (below.length > 0) return { rows: below, next: cut };
  return { rows: await fetch(cut, cut, null), next: cut + 1 };
}
