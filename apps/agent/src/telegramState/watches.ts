/**
 * #3769 — the loans a wallet watches without holding them, kept in the
 * agent's private state object beside the Telegram links they are delivered
 * through (see `store.ts` for why that state is not in the shared database).
 * Which loans a wallet watches is the wallet's own setting: nothing serves it
 * publicly, and only a request the wallet signed reads it back.
 *
 * Schema version 2 in `store.ts`. Every method runs inside the object's
 * single-threaded request loop, and each multi-statement one inside one
 * transaction, so a limit check and the write it guards are one step.
 */
import type { ChainDeployment, SqlLike, TxRunner } from './store';

/** The limits a change is checked against (the agent's configuration). */
export interface WatchLimits {
  maxLoansPerWallet: number;
  maxChangesPerDay: number;
}

export type WatchAddOutcome = 'added' | 'already-watching' | 'too-many-loans' | 'changes-spent';
export type WatchRemoveOutcome = 'removed' | 'not-watching' | 'changes-spent';

/** One watch, as its wallet reads it back. */
export interface WatchedLoan {
  chainId: number;
  loanId: number;
  watchedAt: number;
}

/** One watch, as the alert lane reads it. */
export interface WatchRow {
  wallet: string;
  loanId: number;
  lastBand: string;
  dueToldFor: number;
}

/** What the alert lane decided for one watch. `end` removes it (the loan
 *  ended); otherwise the given fields are stored and the watch is marked
 *  checked. */
export interface WatchUpdate {
  wallet: string;
  loanId: number;
  end?: boolean;
  lastBand?: string;
  dueToldFor?: number;
}

/** Change counts are kept this long, then pruned. */
const CHANGE_RETENTION_DAYS = 2;

const lower = (w: string) => w.toLowerCase();
const dayOf = (now: number) => Math.floor(now / 86_400);

export class WatchStore {
  constructor(
    private readonly sql: SqlLike,
    private readonly tx: TxRunner,
  ) {}

  /** Take one change from `wallet`'s daily allowance; false when spent. */
  private takeChange(wallet: string, now: number, limits: WatchLimits): boolean {
    const day = dayOf(now);
    const row = this.sql
      .exec<{ count: number }>(`SELECT count FROM watch_changes WHERE wallet = ? AND day = ?`, wallet, day)
      .toArray()[0];
    const used = row ? Number(row.count) : 0;
    if (used >= limits.maxChangesPerDay) return false;
    this.sql.exec(
      `INSERT INTO watch_changes (wallet, day, count) VALUES (?, ?, 1)
       ON CONFLICT (wallet, day) DO UPDATE SET count = count + 1`,
      wallet,
      day,
    );
    this.sql.exec(`DELETE FROM watch_changes WHERE day < ?`, day - CHANGE_RETENTION_DAYS);
    return true;
  }

  /** Watch a loan. Watching a loan already watched changes nothing and
   *  spends nothing. */
  add(dep: ChainDeployment, walletRaw: string, loanId: number, now: number, limits: WatchLimits): WatchAddOutcome {
    const wallet = lower(walletRaw);
    const diamond = lower(dep.diamond);
    return this.tx(() => {
      const exists =
        this.sql
          .exec(
            `SELECT 1 FROM watched_loans WHERE wallet = ? AND chain_id = ? AND diamond = ? AND loan_id = ?`,
            wallet,
            dep.chainId,
            diamond,
            loanId,
          )
          .toArray().length > 0;
      if (exists) return 'already-watching';
      // Counted across every chain: the limit bounds what one wallet can ask
      // the alert service to follow, wherever the loans are.
      const held = Number(
        this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM watched_loans WHERE wallet = ?`, wallet).toArray()[0]?.n ?? 0,
      );
      if (held >= limits.maxLoansPerWallet) return 'too-many-loans';
      if (!this.takeChange(wallet, now, limits)) return 'changes-spent';
      this.sql.exec(
        `INSERT INTO watched_loans (wallet, chain_id, diamond, loan_id, created_at) VALUES (?, ?, ?, ?, ?)`,
        wallet,
        dep.chainId,
        diamond,
        loanId,
        now,
      );
      return 'added';
    });
  }

  /** Stop watching a loan, on this chain's current Diamond. */
  remove(dep: ChainDeployment, walletRaw: string, loanId: number, now: number, limits: WatchLimits): WatchRemoveOutcome {
    const wallet = lower(walletRaw);
    const diamond = lower(dep.diamond);
    return this.tx(() => {
      const exists =
        this.sql
          .exec(
            `SELECT 1 FROM watched_loans WHERE wallet = ? AND chain_id = ? AND diamond = ? AND loan_id = ?`,
            wallet,
            dep.chainId,
            diamond,
            loanId,
          )
          .toArray().length > 0;
      if (!exists) return 'not-watching';
      if (!this.takeChange(wallet, now, limits)) return 'changes-spent';
      this.sql.exec(
        `DELETE FROM watched_loans WHERE wallet = ? AND chain_id = ? AND diamond = ? AND loan_id = ?`,
        wallet,
        dep.chainId,
        diamond,
        loanId,
      );
      return 'removed';
    });
  }

  /** The wallet's watches on the deployments it is given (the bundle's
   *  current Diamond per chain); a watch kept for a retired Diamond is not
   *  listed, since its loan id no longer names that loan. */
  list(walletRaw: string, deps: readonly ChainDeployment[]): WatchedLoan[] {
    const wallet = lower(walletRaw);
    const out: WatchedLoan[] = [];
    for (const dep of deps) {
      for (const r of this.sql
        .exec<{ loan_id: number; created_at: number }>(
          `SELECT loan_id, created_at FROM watched_loans
            WHERE wallet = ? AND chain_id = ? AND diamond = ? ORDER BY loan_id`,
          wallet,
          dep.chainId,
          lower(dep.diamond),
        )
        .toArray()) {
        out.push({ chainId: dep.chainId, loanId: Number(r.loan_id), watchedAt: Number(r.created_at) });
      }
    }
    return out;
  }

  /**
   * The watches on one deployment to check now, least recently checked
   * first, so a long list is worked through in turn. Watches kept for any
   * other Diamond on the chain are deleted first: their loan ids belong to a
   * retired deployment, and a wallet that wants the new loan watches it anew.
   */
  due(dep: ChainDeployment, limit: number): WatchRow[] {
    const diamond = lower(dep.diamond);
    return this.tx(() => {
      this.sql.exec(`DELETE FROM watched_loans WHERE chain_id = ? AND diamond <> ?`, dep.chainId, diamond);
      return this.sql
        .exec<{ wallet: string; loan_id: number; last_band: string; due_told_for: number }>(
          `SELECT wallet, loan_id, last_band, due_told_for FROM watched_loans
            WHERE chain_id = ? AND diamond = ?
            ORDER BY checked_at, wallet, loan_id LIMIT ?`,
          dep.chainId,
          diamond,
          limit,
        )
        .toArray()
        .map((r) => ({
          wallet: r.wallet,
          loanId: Number(r.loan_id),
          lastBand: String(r.last_band),
          dueToldFor: Number(r.due_told_for),
        }));
    });
  }

  /** Record what the lane decided, all together. */
  record(dep: ChainDeployment, updates: readonly WatchUpdate[], now: number): void {
    const diamond = lower(dep.diamond);
    this.tx(() => {
      for (const u of updates) {
        const key = [lower(u.wallet), dep.chainId, diamond, u.loanId] as const;
        if (u.end) {
          this.sql.exec(
            `DELETE FROM watched_loans WHERE wallet = ? AND chain_id = ? AND diamond = ? AND loan_id = ?`,
            ...key,
          );
          continue;
        }
        this.sql.exec(
          `UPDATE watched_loans
              SET last_band = COALESCE(?, last_band),
                  due_told_for = COALESCE(?, due_told_for),
                  checked_at = ?
            WHERE wallet = ? AND chain_id = ? AND diamond = ? AND loan_id = ?`,
          u.lastBand ?? null,
          u.dueToldFor ?? null,
          now,
          ...key,
        );
      }
    });
  }
}
