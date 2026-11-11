/**
 * #1722 — the agent's private Telegram state: which chat receives a wallet's
 * alerts, the handshake codes that link one, the protected-mode waits on
 * removing one (#3246), and the Telegram LOCK requests the keeper acts on
 * (#3088).
 *
 * WHY IT IS NOT IN THE SHARED DATABASE. Every Worker bound to the shared D1
 * (indexer, agent, keeper) could write these rows, and the keeper machine
 * reaches D1 with an account-wide token that writes every D1 database in the
 * account. A writer there could redirect a wallet's alerts to its own chat,
 * insert a LOCK request, or quietly delete a pending removal. The state now
 * lives in a SQLite Durable Object bound only to the agent (`object.ts`).
 * Cloudflare has no API that reads or writes a Durable Object's storage from
 * outside its own Worker, so nothing but the agent's code can touch it (owner
 * decision 2026-11-11, #1722). The keeper reaches the two things it needs, the
 * LOCK requests and alert delivery, through the agent's keeper-only routes.
 *
 * This file is the store itself, written against a narrow SQL surface
 * ({@link SqlLike}) so the tests run it on Node's built-in SQLite. Every
 * method is synchronous and every multi-statement method runs inside one
 * transaction ({@link TxRunner}): a Durable Object runs one request at a time,
 * so a method's read and its writes are one atomic step and no other request
 * can land between them. The guards the shared-database version needed (a
 * deliberate JSON error to abort a D1 batch) are plain comparisons here.
 *
 * The store holds no locale and no thresholds: those stay in the shared
 * `user_thresholds` row, which the keeper's watchers also read.
 */

/** The SQL surface the store uses: a Durable Object's `ctx.storage.sql`, or
 *  the test harness over `node:sqlite`. */
export interface SqlLike {
  exec<T extends Record<string, unknown> = Record<string, unknown>>(query: string, ...bindings: unknown[]): SqlCursorLike<T>;
}

/** The part of a SQL cursor the store reads. */
export interface SqlCursorLike<T> {
  toArray(): T[];
  readonly rowsWritten: number;
}

/** Runs `fn` as one transaction: every write it made is rolled back when it
 *  throws. A Durable Object's `ctx.storage.transactionSync`. */
export type TxRunner = <T>(fn: () => T) => T;

/** One wallet/chain row with a chat linked. */
export interface LinkedRow {
  chainId: number;
  chatId: string;
}

/** A pending removal or move of a chat (#3246). */
export interface PendingChange {
  id: number;
  wallet: string;
  chainId: number;
  kind: 'unlink' | 'replace';
  oldChatId: string;
  newChatId: string | null;
  delaySeconds: number;
  /** Null until the old chat accepted the notice; then notice time + delay. */
  effectiveAt: number | null;
}

/** One write a channel decision makes. The whole list is applied, or none of
 *  it, by {@link TelegramStateStore.commit}. */
export type ChannelOp =
  /** Close the pending change of one chain, or of every chain (null). */
  | { op: 'supersede'; chainId: number | null }
  /** Clear one chain's chat now. */
  | { op: 'clear'; chainId: number }
  /** Record a pending change for one chain (superseding its pending one). */
  | { op: 'pend'; chainId: number; kind: 'unlink' | 'replace'; oldChatId: string; newChatId: string | null; delaySeconds: number }
  /** Revoke the handshake codes of one chain, or of every chain (null). */
  | { op: 'revokeCodes'; chainId: number | null }
  /** Link `chatId` to one chain. */
  | { op: 'link'; chainId: number; chatId: string };

/** What {@link TelegramStateStore.commit} did: nothing (the rows in scope
 *  moved after the caller read them), or every op, with the id of each
 *  pending change it recorded, in op order. */
export type CommitResult = { ok: false } | { ok: true; ids: number[] };

/** One wallet's open LOCK requests on a chain, taken together. */
export interface LockRequest {
  /** The newest open request: every open one up to it is handled together. */
  id: number;
  wallet: string;
  /** When the newest was sent, in Unix seconds. */
  requestedAt: number;
}

/** A LOCK request no outcome has come back for, to tell its chat. */
export interface UnansweredLock {
  chainId: number;
  wallet: string;
  upToId: number;
  chatId: string;
}

/** One deployment of the protocol: a chain and the Diamond on it. LOCK
 *  state is kept per deployment, never per chain alone, so a request made
 *  against one Diamond is never handed to a keeper working another one on
 *  the same chain (a fresh deploy keeps the chain id). */
export interface ChainDeployment {
  chainId: number;
  diamond: string;
}

/** How a recorded LOCK went, as the agent tells the chat. */
export interface LockLink {
  wallet: string;
  chainId: number;
  /** Recorded for the keeper: a keeper is working LOCK requests on the chain. */
  recorded: boolean;
}

/** Closed changes are kept this long for the record, then pruned. */
export const CLOSED_RETENTION_SECONDS = 90 * 24 * 60 * 60;
/** Handled LOCK requests are kept this long, then pruned. */
export const LOCK_RETENTION_SECONDS = 30 * 24 * 60 * 60;

/** The schema, by version. A new version appends; nothing is edited in place,
 *  because a deployed object has already run the earlier steps. */
const SCHEMA: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS link_codes (
     code       TEXT PRIMARY KEY,
     wallet     TEXT NOT NULL,
     chain_id   INTEGER NOT NULL,
     expires_at INTEGER NOT NULL
   );
   CREATE INDEX IF NOT EXISTS idx_link_codes_exp ON link_codes(expires_at);
   CREATE INDEX IF NOT EXISTS idx_link_codes_wallet ON link_codes(wallet, chain_id);
   CREATE TABLE IF NOT EXISTS links (
     wallet    TEXT NOT NULL,
     chain_id  INTEGER NOT NULL,
     chat_id   TEXT NOT NULL,
     linked_at INTEGER NOT NULL,
     PRIMARY KEY (wallet, chain_id)
   );
   CREATE INDEX IF NOT EXISTS idx_links_chat ON links(chat_id);
   CREATE TABLE IF NOT EXISTS channel_changes (
     id                INTEGER PRIMARY KEY AUTOINCREMENT,
     wallet            TEXT    NOT NULL,
     chain_id          INTEGER NOT NULL,
     kind              TEXT    NOT NULL CHECK (kind IN ('unlink', 'replace')),
     old_chat_id       TEXT    NOT NULL,
     new_chat_id       TEXT,
     requested_at      INTEGER NOT NULL,
     delay_seconds     INTEGER NOT NULL,
     notified_at       INTEGER,
     notice_attempt_at INTEGER,
     effective_at      INTEGER,
     state             TEXT    NOT NULL DEFAULT 'pending'
                       CHECK (state IN ('pending', 'applied', 'cancelled', 'superseded')),
     closed_at         INTEGER
   );
   CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_changes_one_pending
     ON channel_changes (wallet, chain_id) WHERE state = 'pending';
   CREATE INDEX IF NOT EXISTS idx_channel_changes_due ON channel_changes (state, effective_at);
   CREATE INDEX IF NOT EXISTS idx_channel_changes_unnotified ON channel_changes (state, notified_at, notice_attempt_at);
   CREATE INDEX IF NOT EXISTS idx_channel_changes_old_chat ON channel_changes (old_chat_id, state);
   CREATE TABLE IF NOT EXISTS lock_requests (
     id           INTEGER PRIMARY KEY AUTOINCREMENT,
     chain_id     INTEGER NOT NULL,
     diamond      TEXT NOT NULL,
     wallet       TEXT NOT NULL,
     update_id    INTEGER NOT NULL,
     requested_at INTEGER NOT NULL,
     handled_at   INTEGER,
     outcome      TEXT,
     warned_at    INTEGER,
     UNIQUE (update_id, chain_id, wallet)
   );
   CREATE INDEX IF NOT EXISTS idx_lock_requests_open ON lock_requests(chain_id, diamond, handled_at, id);
   CREATE TABLE IF NOT EXISTS lock_readiness (
     chain_id INTEGER NOT NULL,
     diamond  TEXT NOT NULL,
     seen_at  INTEGER NOT NULL,
     PRIMARY KEY (chain_id, diamond)
   );`,
];

/** Bring the schema to the current version. Idempotent. */
export function migrate(sql: SqlLike, tx: TxRunner): void {
  tx(() => {
    sql.exec(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)`);
    const row = sql.exec<{ version: number }>(`SELECT version FROM schema_version`).toArray()[0];
    let version = row ? Number(row.version) : 0;
    if (!row) sql.exec(`INSERT INTO schema_version (version) VALUES (0)`);
    for (; version < SCHEMA.length; version++) {
      for (const stmt of SCHEMA[version]!.split(';').map((s) => s.trim()).filter(Boolean)) sql.exec(stmt);
      sql.exec(`UPDATE schema_version SET version = ?`, version + 1);
    }
  });
}

const lower = (w: string) => w.toLowerCase();

/** The store. Construct once per object; {@link migrate} runs first. */
export class TelegramStateStore {
  constructor(
    private readonly sql: SqlLike,
    private readonly tx: TxRunner,
  ) {
    migrate(sql, tx);
  }

  // ─── Handshake codes ──────────────────────────────────────────────────

  /** Store a handshake code. False when the code is already taken (a
   *  collision; the caller draws another). */
  issueLinkCode(code: string, wallet: string, chainId: number, expiresAt: number): boolean {
    const taken = this.sql.exec(`SELECT 1 FROM link_codes WHERE code = ?`, code).toArray().length > 0;
    if (taken) return false;
    this.sql.exec(
      `INSERT INTO link_codes (code, wallet, chain_id, expires_at) VALUES (?, ?, ?, ?)`,
      code,
      lower(wallet),
      chainId,
      expiresAt,
    );
    return true;
  }

  /** Consume a code: it is deleted whatever happens, so it is good once.
   *  Null when unknown or expired. */
  consumeLinkCode(code: string, now: number): { wallet: string; chainId: number } | null {
    return this.tx(() => {
      const row = this.sql
        .exec<{ wallet: string; chain_id: number; expires_at: number }>(
          `SELECT wallet, chain_id, expires_at FROM link_codes WHERE code = ?`,
          code,
        )
        .toArray()[0];
      if (!row) return null;
      this.sql.exec(`DELETE FROM link_codes WHERE code = ?`, code);
      if (Number(row.expires_at) < now) return null;
      return { wallet: row.wallet, chainId: Number(row.chain_id) };
    });
  }

  /** Delete expired codes; returns how many. */
  sweepExpiredCodes(now: number): number {
    return this.sql.exec(`DELETE FROM link_codes WHERE expires_at < ?`, now).rowsWritten;
  }

  // ─── Links ────────────────────────────────────────────────────────────

  /** The rows of `wallet` with a chat linked, on one chain or every chain. */
  linkedRows(wallet: string, chainId: number | null): LinkedRow[] {
    const rows =
      chainId === null
        ? this.sql
            .exec<{ chain_id: number; chat_id: string }>(
              `SELECT chain_id, chat_id FROM links WHERE wallet = ? ORDER BY chain_id`,
              lower(wallet),
            )
            .toArray()
        : this.sql
            .exec<{ chain_id: number; chat_id: string }>(
              `SELECT chain_id, chat_id FROM links WHERE wallet = ? AND chain_id = ?`,
              lower(wallet),
              chainId,
            )
            .toArray();
    return rows.map((r) => ({ chainId: Number(r.chain_id), chatId: String(r.chat_id) }));
  }

  /** The chat each (wallet, chain) is linked to, in input order (null: none). */
  chatsOf(pairs: readonly { wallet: string; chainId: number }[]): (string | null)[] {
    return pairs.map((p) => {
      const row = this.sql
        .exec<{ chat_id: string }>(`SELECT chat_id FROM links WHERE wallet = ? AND chain_id = ?`, lower(p.wallet), p.chainId)
        .toArray()[0];
      return row ? String(row.chat_id) : null;
    });
  }

  /** The wallets with a chat linked on `chainId`. */
  linkedWallets(chainId: number): string[] {
    return this.sql
      .exec<{ wallet: string }>(`SELECT wallet FROM links WHERE chain_id = ? ORDER BY wallet`, chainId)
      .toArray()
      .map((r) => r.wallet);
  }

  /** Every (wallet, chain) a chat is linked to. */
  linksOfChat(chatId: string): { wallet: string; chainId: number }[] {
    return this.sql
      .exec<{ wallet: string; chain_id: number }>(
        `SELECT wallet, chain_id FROM links WHERE chat_id = ? ORDER BY chain_id, wallet`,
        chatId,
      )
      .toArray()
      .map((r) => ({ wallet: r.wallet, chainId: Number(r.chain_id) }));
  }

  /**
   * Apply `ops` for `wallet` only while its linked rows in scope (`chainId`
   * null = every chain) are still exactly `observed`, as the caller read them
   * before deciding. One transaction: when the rows moved, nothing is written
   * and the caller reads and decides again. This is what makes a decision
   * that needed a chain read in between (the protection status) and its
   * writes one atomic step.
   */
  commit(wallet: string, chainId: number | null, observed: readonly LinkedRow[], ops: readonly ChannelOp[], now: number): CommitResult {
    const w = lower(wallet);
    return this.tx(() => {
      if (!sameRows(this.linkedRows(w, chainId), observed)) return { ok: false };
      const ids: number[] = [];
      for (const o of ops) {
        switch (o.op) {
          case 'supersede':
            this.supersede(w, o.chainId, now);
            break;
          case 'clear':
            this.sql.exec(`DELETE FROM links WHERE wallet = ? AND chain_id = ?`, w, o.chainId);
            break;
          case 'pend':
            this.supersede(w, o.chainId, now);
            ids.push(
              Number(
                this.sql
                  .exec<{ id: number }>(
                    `INSERT INTO channel_changes
                       (wallet, chain_id, kind, old_chat_id, new_chat_id, requested_at, delay_seconds, state)
                     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending') RETURNING id`,
                    w,
                    o.chainId,
                    o.kind,
                    o.oldChatId,
                    o.newChatId,
                    now,
                    o.delaySeconds,
                  )
                  .toArray()[0]!.id,
              ),
            );
            break;
          case 'revokeCodes':
            if (o.chainId === null) this.sql.exec(`DELETE FROM link_codes WHERE wallet = ?`, w);
            else this.sql.exec(`DELETE FROM link_codes WHERE wallet = ? AND chain_id = ?`, w, o.chainId);
            break;
          case 'link':
            this.sql.exec(
              `INSERT INTO links (wallet, chain_id, chat_id, linked_at) VALUES (?, ?, ?, ?)
               ON CONFLICT (wallet, chain_id) DO UPDATE SET chat_id = excluded.chat_id, linked_at = excluded.linked_at`,
              w,
              o.chainId,
              o.chatId,
              now,
            );
            break;
        }
      }
      return { ok: true, ids };
    });
  }

  private supersede(w: string, chainId: number | null, now: number): void {
    if (chainId === null) {
      this.sql.exec(`UPDATE channel_changes SET state = 'superseded', closed_at = ? WHERE wallet = ? AND state = 'pending'`, now, w);
    } else {
      this.sql.exec(
        `UPDATE channel_changes SET state = 'superseded', closed_at = ? WHERE wallet = ? AND chain_id = ? AND state = 'pending'`,
        now,
        w,
        chainId,
      );
    }
  }

  // ─── Pending changes (#3246) ──────────────────────────────────────────

  /** The old chat accepted the notice for `ids`: their wait starts now. Only
   *  the ids the notice named, and only while still pending and untold. */
  markNotified(ids: readonly number[], now: number): void {
    if (ids.length === 0) return;
    this.sql.exec(
      `UPDATE channel_changes SET notified_at = ?, effective_at = ? + delay_seconds, notice_attempt_at = ?
        WHERE state = 'pending' AND notified_at IS NULL AND id IN (${ids.map(() => '?').join(', ')})`,
      now,
      now,
      now,
      ...ids,
    );
  }

  /** A notice for `ids` that Telegram did not accept: the retry waits, and
   *  the retry order rotates past it. */
  markNoticeAttempt(ids: readonly number[], now: number): void {
    if (ids.length === 0) return;
    this.sql.exec(
      `UPDATE channel_changes SET notice_attempt_at = ?
        WHERE state = 'pending' AND notified_at IS NULL AND id IN (${ids.map(() => '?').join(', ')})`,
      now,
      ...ids,
    );
  }

  /** Pending changes whose notice still has to reach the old chat, last
   *  tried at or before `retryBefore` (or never), least recently tried first
   *  so a chat that keeps refusing cannot starve the rest. */
  unnotifiedChanges(retryBefore: number, limit: number): PendingChange[] {
    return this.readChanges(
      `state = 'pending' AND notified_at IS NULL AND (notice_attempt_at IS NULL OR notice_attempt_at <= ?)`,
      retryBefore,
      limit,
      'COALESCE(notice_attempt_at, 0), id',
    );
  }

  /** Pending changes due at `now` (told, and their wait passed), oldest first. */
  dueChanges(now: number, limit: number): PendingChange[] {
    return this.readChanges(`state = 'pending' AND effective_at IS NOT NULL AND effective_at <= ?`, now, limit, 'id');
  }

  private readChanges(where: string, arg: number, limit: number, orderBy: string): PendingChange[] {
    return this.sql
      .exec<{
        id: number;
        wallet: string;
        chain_id: number;
        kind: 'unlink' | 'replace';
        old_chat_id: string;
        new_chat_id: string | null;
        delay_seconds: number;
        effective_at: number | null;
      }>(
        `SELECT id, wallet, chain_id, kind, old_chat_id, new_chat_id, delay_seconds, effective_at
           FROM channel_changes WHERE ${where} ORDER BY ${orderBy} LIMIT ?`,
        arg,
        limit,
      )
      .toArray()
      .map((r) => ({
        id: Number(r.id),
        wallet: r.wallet,
        chainId: Number(r.chain_id),
        kind: r.kind,
        oldChatId: String(r.old_chat_id),
        newChatId: r.new_chat_id === null ? null : String(r.new_chat_id),
        delaySeconds: Number(r.delay_seconds),
        effectiveAt: r.effective_at === null ? null : Number(r.effective_at),
      }));
  }

  /** CANCEL from `chatId`: close every pending change that would remove that
   *  chat. Only that chat may cancel: it is the one the change would silence. */
  cancelPendingForChat(chatId: string, now: number): { wallet: string; chainId: number; kind: 'unlink' | 'replace' }[] {
    return this.sql
      .exec<{ wallet: string; chain_id: number; kind: 'unlink' | 'replace' }>(
        `UPDATE channel_changes SET state = 'cancelled', closed_at = ?
          WHERE old_chat_id = ? AND state = 'pending' RETURNING wallet, chain_id, kind`,
        now,
        chatId,
      )
      .toArray()
      .map((r) => ({ wallet: r.wallet, chainId: Number(r.chain_id), kind: r.kind }));
  }

  /** Apply the due change `id`, atomically with marking it applied. Null when
   *  it is not pending any more (applied or cancelled meanwhile); otherwise
   *  whether the chat row changed, which it does only while the chat it moves
   *  away from is still the linked one (anything else means a later immediate
   *  change already decided it). */
  applyChange(id: number, now: number): { change: PendingChange; applied: boolean } | null {
    return this.tx(() => {
      const [c] = this.readChanges(`id = ? AND state = 'pending'`, id, 1, 'id');
      if (!c) return null;
      if (c.effectiveAt === null || c.effectiveAt > now) return null;
      this.sql.exec(`UPDATE channel_changes SET state = 'applied', closed_at = ? WHERE id = ?`, now, id);
      let changed: number;
      if (c.kind === 'unlink') {
        changed = this.sql.exec(
          `DELETE FROM links WHERE wallet = ? AND chain_id = ? AND chat_id = ?`,
          c.wallet,
          c.chainId,
          c.oldChatId,
        ).rowsWritten;
        // As the immediate unlink does: a live handshake code for the row
        // could otherwise re-link it at once.
        this.sql.exec(`DELETE FROM link_codes WHERE wallet = ? AND chain_id = ?`, c.wallet, c.chainId);
      } else {
        changed = this.sql.exec(
          `UPDATE links SET chat_id = ?, linked_at = ? WHERE wallet = ? AND chain_id = ? AND chat_id = ?`,
          c.newChatId,
          now,
          c.wallet,
          c.chainId,
          c.oldChatId,
        ).rowsWritten;
      }
      return { change: c, applied: changed > 0 };
    });
  }

  /** Drop closed changes and handled LOCK requests past their retention. */
  pruneClosed(now: number): void {
    this.sql.exec(`DELETE FROM channel_changes WHERE state <> 'pending' AND closed_at < ?`, now - CLOSED_RETENTION_SECONDS);
    this.sql.exec(`DELETE FROM lock_requests WHERE handled_at IS NOT NULL AND handled_at < ?`, now - LOCK_RETENTION_SECONDS);
  }

  // ─── Telegram LOCK (#3088) ────────────────────────────────────────────

  /**
   * Record a LOCK from `chatId` for every (wallet, chain) the chat is linked
   * to on which a keeper is working LOCK requests for the chain's CURRENT
   * Diamond now (its last poll for that Diamond at or after `freshFrom`).
   * `diamonds` is the agent's own deployment list, chain id to Diamond; a
   * request is recorded against that Diamond, and a keeper still polling a
   * retired one counts for nothing. Returns every link with whether it was
   * recorded.
   * `requestedAt` null records nothing (a request too old, or with no send
   * time): the links come back unrecorded and the caller says why. A
   * redelivered update records nothing new: a row is unique on (update,
   * chain, wallet).
   */
  recordLockRequests(
    chatId: string,
    updateId: number,
    requestedAt: number | null,
    freshFrom: number,
    diamonds: Readonly<Record<number, string>>,
  ): LockLink[] {
    return this.tx(() => {
      const links = this.linksOfChat(chatId);
      const running = new Set(
        this.sql
          .exec<{ chain_id: number; diamond: string }>(`SELECT chain_id, diamond FROM lock_readiness WHERE seen_at >= ?`, freshFrom)
          .toArray()
          .filter((r) => diamonds[Number(r.chain_id)]?.toLowerCase() === r.diamond)
          .map((r) => Number(r.chain_id)),
      );
      return links.map((l) => {
        const recordable = requestedAt !== null && running.has(l.chainId);
        if (recordable) {
          this.sql.exec(
            `INSERT OR IGNORE INTO lock_requests (chain_id, diamond, wallet, update_id, requested_at) VALUES (?, ?, ?, ?, ?)`,
            l.chainId,
            lower(diamonds[l.chainId]!),
            l.wallet,
            updateId,
            requestedAt,
          );
        }
        return { wallet: l.wallet, chainId: l.chainId, recorded: recordable };
      });
    });
  }

  /**
   * The keeper's poll for deployment `dep`: it says a keeper able to sign is
   * working LOCK requests for that Diamond now (the agent records a LOCK only while that is
   * fresh), and returns at most `limit` wallets with open requests, one entry
   * per wallet, in the order of each wallet's oldest open request.
   */
  keeperPoll(dep: ChainDeployment, now: number, limit: number): LockRequest[] {
    const diamond = lower(dep.diamond);
    return this.tx(() => {
      this.sql.exec(
        `INSERT INTO lock_readiness (chain_id, diamond, seen_at) VALUES (?, ?, ?)
         ON CONFLICT (chain_id, diamond) DO UPDATE SET seen_at = excluded.seen_at`,
        dep.chainId,
        diamond,
        now,
      );
      return this.sql
        .exec<{ id: number; wallet: string; requested_at: number }>(
          `SELECT MAX(id) AS id, wallet, MAX(requested_at) AS requested_at, MIN(id) AS first_id
             FROM lock_requests WHERE chain_id = ? AND diamond = ? AND handled_at IS NULL
            GROUP BY wallet ORDER BY first_id ASC LIMIT ?`,
          dep.chainId,
          diamond,
          limit,
        )
        .toArray()
        .map((r) => ({ id: Number(r.id), wallet: r.wallet, requestedAt: Number(r.requested_at) }));
    });
  }

  /** The wallets with a LOCK request on deployment `dep` sent at or after
   *  `since` and not handled yet (the keeper holds their releases). */
  pendingLockWallets(dep: ChainDeployment, since: number): string[] {
    return this.sql
      .exec<{ wallet: string }>(
        `SELECT DISTINCT wallet FROM lock_requests
          WHERE chain_id = ? AND diamond = ? AND handled_at IS NULL AND requested_at >= ?`,
        dep.chainId,
        lower(dep.diamond),
        since,
      )
      .toArray()
      .map((r) => r.wallet);
  }

  /** Record that `wallet`'s open requests on deployment `dep` up to `upToId` are
   *  finished, and how. Returns the chat the wallet is linked to now (where
   *  the answer goes; null once unlinked), or undefined when no open request
   *  matched (already handled, or never made: nothing is answered). */
  markLockHandled(dep: ChainDeployment, wallet: string, upToId: number, outcome: string, at: number): { chatId: string | null } | undefined {
    const w = lower(wallet);
    const chainId = dep.chainId;
    return this.tx(() => {
      const changed = this.sql.exec(
        `UPDATE lock_requests SET handled_at = ?, outcome = ?
          WHERE chain_id = ? AND diamond = ? AND wallet = ? AND id <= ? AND handled_at IS NULL`,
        at,
        outcome,
        chainId,
        lower(dep.diamond),
        w,
        upToId,
      ).rowsWritten;
      if (changed === 0) return undefined;
      const [chatId] = this.chatsOf([{ wallet: w, chainId }]);
      return { chatId: chatId ?? null };
    });
  }

  /** Open LOCK requests sent at or before `sentBefore` that no outcome has
   *  come back for and whose chat has not been warned, one entry per wallet
   *  and chain, with the chat linked now. Marks them warned, so each is told
   *  once. Requests of a wallet no longer linked are marked and skipped. */
  takeUnansweredLocks(sentBefore: number, now: number, limit: number): UnansweredLock[] {
    return this.tx(() => {
      const rows = this.sql
        .exec<{ chain_id: number; wallet: string; up_to: number }>(
          `SELECT chain_id, wallet, MAX(id) AS up_to FROM lock_requests
            WHERE handled_at IS NULL AND warned_at IS NULL AND requested_at <= ?
            GROUP BY chain_id, wallet ORDER BY MIN(id) LIMIT ?`,
          sentBefore,
          limit,
        )
        .toArray();
      const out: UnansweredLock[] = [];
      for (const r of rows) {
        const chainId = Number(r.chain_id);
        this.sql.exec(
          `UPDATE lock_requests SET warned_at = ? WHERE chain_id = ? AND wallet = ? AND id <= ? AND handled_at IS NULL`,
          now,
          chainId,
          r.wallet,
          Number(r.up_to),
        );
        const [chatId] = this.chatsOf([{ wallet: r.wallet, chainId }]);
        if (chatId) out.push({ chainId, wallet: r.wallet, upToId: Number(r.up_to), chatId });
      }
      return out;
    });
  }
}

/** Whether two sets of linked rows are the same (order-insensitive). */
function sameRows(a: readonly LinkedRow[], b: readonly LinkedRow[]): boolean {
  if (a.length !== b.length) return false;
  const key = (r: LinkedRow) => `${r.chainId}|${r.chatId}`;
  const set = new Set(a.map(key));
  return b.every((r) => set.has(key(r)));
}
