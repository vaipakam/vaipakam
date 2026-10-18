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
 * declares a `chain_id` column and NO `diamond` column. A table carrying
 * `diamond` is already namespaced by it and needs no reset; a new keyed-by-
 * chain table joins the rule by existing, not by being listed.
 *
 * WHICH DIAMOND, the first time. With no record for a chain, the rows here are
 * the ones the cutover copied from the shared database, and those belong to the
 * Diamond the INDEXER had adopted (its `indexer_deployment` record). So that is
 * what is recorded first; if it is not the configured Diamond, the very next
 * comparison resets. When the indexer's record cannot be read either, the
 * configured Diamond is adopted (a fresh environment, nothing to reset).
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

async function indexerAdopted(env: Env, chainId: number): Promise<string | null> {
  try {
    const row = await env.DB.prepare('SELECT diamond FROM indexer_deployment WHERE chain_id = ?').bind(chainId).first<{ diamond: string }>();
    return typeof row?.diamond === 'string' ? row.diamond.toLowerCase() : null;
  } catch {
    return null;
  }
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
      // eslint-disable-next-line no-await-in-loop
      have = (await indexerAdopted(env, chain.id)) ?? want;
      // eslint-disable-next-line no-await-in-loop
      await env.KEEPER_DB.prepare('INSERT OR IGNORE INTO keeper_deployment (chain_id, diamond, adopted_at) VALUES (?, ?, ?)')
        .bind(chain.id, have, now)
        .run();
    }
    if (have === want) continue;
    // eslint-disable-next-line no-await-in-loop
    tables ??= await listResetOnDiamondChange(env.KEEPER_DB);
    // One batch: the rows go and the new Diamond is recorded together, so an
    // interrupted reset is simply redone next tick.
    // eslint-disable-next-line no-await-in-loop
    await env.KEEPER_DB.batch([
      ...tables.map((t) => env.KEEPER_DB.prepare(`DELETE FROM "${t}" WHERE chain_id = ?`).bind(chain.id)),
      env.KEEPER_DB.prepare(
        `INSERT INTO keeper_deployment (chain_id, diamond, adopted_at) VALUES (?, ?, ?)
         ON CONFLICT (chain_id) DO UPDATE SET diamond = excluded.diamond, adopted_at = excluded.adopted_at`,
      ).bind(chain.id, want, now),
    ]);
    console.log(`[keeper] chain ${chain.id}: Diamond changed ${have} → ${want}; reset private ${tables.join(' ') || '(none)'}`);
    reset.push(chain.id);
  }
  return reset;
}
