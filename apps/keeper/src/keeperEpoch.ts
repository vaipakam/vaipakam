/**
 * The keeper's own deployment epochs (#2497 r10).
 *
 * A fresh Diamond on a chain restarts the ids the keeper's state is keyed by —
 * loan ids, day records — so a row left from the retired Diamond would be read
 * against the new one's: an HF band already "notified" for a loan id the new
 * Diamond reuses, a commitment day already "done". The indexer resets its own
 * chain-scoped tables on a Diamond change (`apps/indexer/src/deploymentEpoch.ts`);
 * that reset cannot reach the keeper's private database, so this applies the
 * same rule there, once per tick, before any pass runs.
 *
 * WHICH TABLES. Schema-aware, like the indexer's: every private table whose DDL
 * declares a `chain_id` column and NO `diamond` column. A table that is
 * chain-scoped carries the column even where its key alone would say so (an
 * alert keyed by text, say), so this one rule finds every one. A table carrying
 * `diamond` is already namespaced by it and needs no reset; a new keyed-by-
 * chain table joins the rule by existing, not by being listed.
 *
 * NEVER AHEAD OF THE INDEXER. A change is applied only once the indexer has
 * adopted the same Diamond (its `indexer_deployment` record); until then the
 * tick declines, since the shared rows the passes read still belong to the old
 * one (#2497 r12).
 *
 * WHICH DIAMOND, the first time. The one-time copy (`scripts/keeper-cutover.mjs`)
 * SEEDS this record with the Diamond the indexer had adopted for each chain
 * when it copied, since the copied rows belong to that one. So a later
 * Diamond change resets them, however long the keeper waited before its first
 * tick. A chain with no record at all has no copied rows (a fresh environment),
 * and the configured Diamond is adopted, resetting nothing.
 */
import type { ChainConfig, Env } from './env';

/** Private tables keyed by chain and not namespaced by Diamond. */
export async function listResetOnDiamondChange(db: Env['KEEPER_DB']): Promise<string[]> {
  const r = await db
    .prepare(
      `SELECT name FROM sqlite_master
        WHERE type = 'table'
          AND name NOT LIKE 'sqlite_%'
          AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'
          AND name NOT IN ('d1_migrations', 'keeper_deployment')
          AND sql GLOB '*[^a-zA-Z0-9_]chain_id[^a-zA-Z0-9_]*'
          AND NOT sql GLOB '*[^a-zA-Z0-9_]diamond[^a-zA-Z0-9_]*'
        ORDER BY name`,
    )
    .all<{ name: string }>();
  return (r.results ?? []).map((t) => t.name);
}

/** The Diamond the indexer has COMPLETELY adopted for `chainId`: recorded AND
 *  its reset finished (`reset_pending = 0`, #2569 r1). The indexer records the
 *  new Diamond first and clears the old rows after, so while the flag is set
 *  its shared rows still belong to the old one. Null when none is complete. A
 *  failed read THROWS (#2497 r11): an unread record is not an absent one. */
async function indexerAdopted(env: Env, chainId: number): Promise<string | null> {
  const row = await env.DB.prepare('SELECT diamond, reset_pending FROM indexer_deployment WHERE chain_id = ?')
    .bind(chainId)
    .first<{ diamond: string; reset_pending: number }>();
  if (typeof row?.diamond !== 'string' || Number(row.reset_pending) !== 0) return null;
  return row.diamond.toLowerCase();
}

/**
 * Bring every chain's private state onto its configured Diamond. Returns the
 * chains it reset. Throws when a read or the reset fails, so the caller can
 * decline the tick rather than let a pass act on another Diamond's rows.
 */
export async function adoptKeeperDeployments(env: Env, chains: readonly ChainConfig[]): Promise<number[]> {
  const reset: number[] = [];
  let tables: string[] | null = null;
  const now = Math.floor(Date.now() / 1000);
  for (const chain of chains) {
    const want = String(chain.diamond).toLowerCase();
    // eslint-disable-next-line no-await-in-loop
    const rec = await env.KEEPER_DB.prepare('SELECT diamond FROM keeper_deployment WHERE chain_id = ?')
      .bind(chain.id)
      .first<{ diamond: string }>();
    let have = rec?.diamond?.toLowerCase() ?? null;
    if (have === null) {
      // No record: no copied rows for this chain (the copy seeds one), so the
      // configured Diamond is adopted and nothing is reset.
      have = want;
      // eslint-disable-next-line no-await-in-loop
      await env.KEEPER_DB.prepare('INSERT OR IGNORE INTO keeper_deployment (chain_id, diamond, adopted_at) VALUES (?, ?, ?)')
        .bind(chain.id, have, now)
        .run();
    }
    if (have === want) continue;
    // Not before the INDEXER has adopted the new Diamond (#2497 r12): until it
    // does, the shared rows the passes join to (loans, events) still belong to
    // the old one, and a loan id the new Diamond reuses would be read against
    // the retired Diamond's row. So the tick declines until it has; the
    // keeper's deploy can land before the indexer's.
    // eslint-disable-next-line no-await-in-loop
    const indexer = await indexerAdopted(env, chain.id);
    if (indexer !== want) {
      throw new Error(
        `chain ${chain.id}: the configured Diamond ${want} is not yet the indexer's (${indexer ?? 'none recorded'}); waiting for it to adopt the new deployment`,
      );
    }
    // eslint-disable-next-line no-await-in-loop
    tables ??= await listResetOnDiamondChange(env.KEEPER_DB);
    // Delete, VERIFY, and only then record (#2497 r11) — never a batch: the
    // machine reaches D1 over HTTP, whose batch atomicity is not established
    // (KeeperMachine.md). Each step is idempotent, and the record moves only
    // once every table reads empty for the chain, so a reset cut off anywhere
    // is redone whole by the next tick.
    for (const t of tables) {
      // eslint-disable-next-line no-await-in-loop
      await env.KEEPER_DB.prepare(`DELETE FROM "${t}" WHERE chain_id = ?`).bind(chain.id).run();
    }
    for (const t of tables) {
      // eslint-disable-next-line no-await-in-loop
      const left = await env.KEEPER_DB.prepare(`SELECT COUNT(*) AS n FROM "${t}" WHERE chain_id = ?`).bind(chain.id).first<{ n: number }>();
      if (Number(left?.n) !== 0) throw new Error(`reset of ${t} for chain ${chain.id} left ${String(left?.n)} row(s)`);
    }
    // eslint-disable-next-line no-await-in-loop
    await env.KEEPER_DB.prepare(
      `INSERT INTO keeper_deployment (chain_id, diamond, adopted_at) VALUES (?, ?, ?)
       ON CONFLICT (chain_id) DO UPDATE SET diamond = excluded.diamond, adopted_at = excluded.adopted_at`,
    )
      .bind(chain.id, want, now)
      .run();
    console.log(`[keeper] chain ${chain.id}: Diamond changed ${have} → ${want}; reset private ${tables.join(' ') || '(none)'}`);
    reset.push(chain.id);
  }
  return reset;
}
