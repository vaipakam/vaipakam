/**
 * #3771 — a wallet's goals (FeaturesOverExistingPartsDesign.md §4), kept in
 * the agent's private state object for the same reason as its Telegram links
 * (see `store.ts`): nothing but the agent's code can read or write them, and
 * the agent does so only for a request the wallet signed. A goal is a note.
 * It locks nothing and changes nothing on chain.
 *
 * Schema version 3 in `store.ts`. A goal is saved against the deployment of
 * the chain the wallet signed for, because the slot or loan ids it names
 * name something only on that Diamond. Goals saved against a retired Diamond
 * are not listed (they are the wallet's own notes, so they are not deleted
 * either; a later prune may).
 */
import type { GoalAttachment, GoalInput } from '@vaipakam/lib/goals';
import type { ChainDeployment, SqlLike, TxRunner } from './store';

export interface GoalLimits {
  maxPerWallet: number;
  maxChangesPerDay: number;
}

/** A stored goal, as its wallet reads it back. */
export interface Goal extends GoalInput {
  id: number;
  chainId: number;
  createdAt: number;
  updatedAt: number;
}

export type GoalSaveOutcome =
  | { kind: 'saved'; id: number }
  | { kind: 'not-found' }
  | { kind: 'too-many-goals' }
  | { kind: 'changes-spent' };

export type GoalDeleteOutcome = 'deleted' | 'not-found' | 'changes-spent';

const CHANGE_RETENTION_DAYS = 2;
const lower = (w: string) => w.toLowerCase();
const dayOf = (now: number) => Math.floor(now / 86_400);

type GoalRowDb = {
  id: number;
  chain_id: number;
  name: string;
  asset: string;
  target_amount: string;
  target_date: number;
  attach_kind: 'slot' | 'loans';
  attach_ids: string;
  created_at: number;
  updated_at: number;
};

function attachmentOf(kind: 'slot' | 'loans', ids: string): GoalAttachment {
  const list = (JSON.parse(ids) as number[]).map(Number);
  return kind === 'slot' ? { kind: 'slot', slotId: list[0]! } : { kind: 'loans', loanIds: list };
}

export class GoalStore {
  constructor(
    private readonly sql: SqlLike,
    private readonly tx: TxRunner,
  ) {}

  private takeChange(wallet: string, now: number, limits: GoalLimits): boolean {
    const day = dayOf(now);
    const used = Number(
      this.sql.exec<{ count: number }>(`SELECT count FROM goal_changes WHERE wallet = ? AND day = ?`, wallet, day).toArray()[0]
        ?.count ?? 0,
    );
    if (used >= limits.maxChangesPerDay) return false;
    this.sql.exec(
      `INSERT INTO goal_changes (wallet, day, count) VALUES (?, ?, 1)
       ON CONFLICT (wallet, day) DO UPDATE SET count = count + 1`,
      wallet,
      day,
    );
    this.sql.exec(`DELETE FROM goal_changes WHERE day < ?`, day - CHANGE_RETENTION_DAYS);
    return true;
  }

  /** Save a new goal (`id` null) or replace one of the wallet's own on this
   *  deployment. Another wallet's goal id reads as not found. */
  save(dep: ChainDeployment, walletRaw: string, id: number | null, goal: GoalInput, now: number, limits: GoalLimits): GoalSaveOutcome {
    const wallet = lower(walletRaw);
    const diamond = lower(dep.diamond);
    const ids = JSON.stringify(goal.attachTo.kind === 'slot' ? [goal.attachTo.slotId] : goal.attachTo.loanIds);
    return this.tx((): GoalSaveOutcome => {
      if (id !== null) {
        const mine =
          this.sql
            .exec(`SELECT 1 FROM goals WHERE id = ? AND wallet = ? AND chain_id = ? AND diamond = ?`, id, wallet, dep.chainId, diamond)
            .toArray().length > 0;
        if (!mine) return { kind: 'not-found' };
        if (!this.takeChange(wallet, now, limits)) return { kind: 'changes-spent' };
        this.sql.exec(
          `UPDATE goals SET name = ?, asset = ?, target_amount = ?, target_date = ?, attach_kind = ?, attach_ids = ?, updated_at = ?
            WHERE id = ?`,
          goal.name,
          lower(goal.asset),
          goal.targetAmount,
          goal.targetDate,
          goal.attachTo.kind,
          ids,
          now,
          id,
        );
        return { kind: 'saved', id };
      }
      const held = Number(
        this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM goals WHERE wallet = ?`, wallet).toArray()[0]?.n ?? 0,
      );
      if (held >= limits.maxPerWallet) return { kind: 'too-many-goals' };
      if (!this.takeChange(wallet, now, limits)) return { kind: 'changes-spent' };
      const inserted = this.sql.exec<{ id: number }>(
        `INSERT INTO goals (wallet, chain_id, diamond, name, asset, target_amount, target_date, attach_kind, attach_ids, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
        wallet,
        dep.chainId,
        diamond,
        goal.name,
        lower(goal.asset),
        goal.targetAmount,
        goal.targetDate,
        goal.attachTo.kind,
        ids,
        now,
        now,
      );
      return { kind: 'saved', id: Number(inserted.toArray()[0]!.id) };
    });
  }

  /** Delete one of the wallet's goals on this deployment. */
  delete(dep: ChainDeployment, walletRaw: string, id: number, now: number, limits: GoalLimits): GoalDeleteOutcome {
    const wallet = lower(walletRaw);
    return this.tx(() => {
      const mine =
        this.sql
          .exec(`SELECT 1 FROM goals WHERE id = ? AND wallet = ? AND chain_id = ? AND diamond = ?`, id, wallet, dep.chainId, lower(dep.diamond))
          .toArray().length > 0;
      if (!mine) return 'not-found';
      if (!this.takeChange(wallet, now, limits)) return 'changes-spent';
      this.sql.exec(`DELETE FROM goals WHERE id = ?`, id);
      return 'deleted';
    });
  }

  /** The wallet's goals on the given deployments (the bundle's current ones). */
  list(walletRaw: string, deps: readonly ChainDeployment[]): Goal[] {
    const wallet = lower(walletRaw);
    const out: Goal[] = [];
    for (const dep of deps) {
      for (const r of this.sql
        .exec<GoalRowDb>(
          `SELECT id, chain_id, name, asset, target_amount, target_date, attach_kind, attach_ids, created_at, updated_at
             FROM goals WHERE wallet = ? AND chain_id = ? AND diamond = ? ORDER BY id`,
          wallet,
          dep.chainId,
          lower(dep.diamond),
        )
        .toArray()) {
        out.push({
          id: Number(r.id),
          chainId: Number(r.chain_id),
          name: r.name,
          asset: r.asset,
          targetAmount: r.target_amount,
          targetDate: Number(r.target_date),
          attachTo: attachmentOf(r.attach_kind, r.attach_ids),
          createdAt: Number(r.created_at),
          updatedAt: Number(r.updated_at),
        });
      }
    }
    return out;
  }
}
