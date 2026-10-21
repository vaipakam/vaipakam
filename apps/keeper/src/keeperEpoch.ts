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
 * NEVER AHEAD OF — OR BEHIND — THE INDEXER. A chain runs only while the
 * indexer has adopted the SAME Diamond the keeper is configured with (its
 * `indexer_deployment` record), checked on EVERY tick and not only when the
 * keeper's own record is due to change (#2569 r3): the shared rows the passes
 * join to (loans, events) belong to whatever Diamond the indexer has settled
 * on, so a keeper whose record already matches its bundle is still reading
 * another deployment's ids while the indexer is mid-reset, or has moved to a
 * Diamond the keeper's bundle does not yet name. Either way the tick declines
 * (#2497 r12). What counts as adopted is defined ONCE, in
 * `scripts/lib/indexer-adoption.mjs`, shared with the epoch fence: a record
 * whose `reset_pending` is still set is NOT an adoption (#2569 r1) — the
 * indexer writes the new Diamond first and clears the old rows after, and in
 * between the shared rows still belong to the old one.
 *
 * WHICH DIAMOND, the first time. The one-time copy of #2450 (retired in #2560,
 * its job done) SEEDED this record with the Diamond the indexer had adopted
 * for each chain when it copied, since the copied rows belong to that one, and
 * refused to record a copy whose rows were keyed by a chain the indexer had
 * not adopted. So a later Diamond change resets them, however long the keeper
 * waited before its first tick. A chain with no record at all and NO private rows
 * (a fresh environment) adopts the configured Diamond, resetting nothing. A
 * chain with no record but WITH private rows is not assumed either way: the
 * Diamond those rows belong to is unknown, so the tick declines, naming the
 * tables, until the record exists (#2569 r1) — the assumption "no record
 * means no copied rows" is checked, never trusted.
 */
import { INDEXER_DEPLOYMENT_SQL, indexerAdopted } from '../scripts/lib/indexer-adoption.mjs';
import type { ChainConfig, Env } from './env';
import { sendOpsNoticeDigest } from './opsAlert';

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

/** The Diamond the indexer has adopted for `chainId`, or null when it has
 *  recorded NONE or its reset is still pending (`indexer-adoption.mjs`). A
 *  failed read THROWS (#2497 r11): an unread record is not an absent one, and
 *  adopting the configured Diamond on a read error could accept another
 *  Diamond's rows for good. */
async function indexerAdoptedFor(env: Env, chainId: number): Promise<string | null> {
  const row = await env.DB.prepare(INDEXER_DEPLOYMENT_SQL).bind(chainId).first<{ diamond: string; reset_pending: number }>();
  return indexerAdopted(row);
}

/** The reset tables that still hold a row for `chainId`, by name. */
async function tablesHolding(db: Env['KEEPER_DB'], tables: readonly string[], chainId: number): Promise<string[]> {
  const held: string[] = [];
  for (const t of tables) {
    // eslint-disable-next-line no-await-in-loop
    const left = await db.prepare(`SELECT COUNT(*) AS n FROM "${t}" WHERE chain_id = ?`).bind(chainId).first<{ n: number }>();
    if (Number(left?.n) !== 0) held.push(`${t} (${String(left?.n)} row(s))`);
  }
  return held;
}

/**
 * Say which open ops alerts a reset is about to close (#2616 r11). The alert
 * table is one of the reset tables (its `chain_id` column), so a Diamond
 * change forgets every open alert of the chain, whichever pass raised it, and
 * the pass that would have closed each with a notice never sees it again. An
 * operator told of a condition is told here that it is no longer followed,
 * rather than never hearing of it. Best-effort like every ops notice (the
 * journal names each key), so a chat that is down does not hold the reset.
 */
async function announceAlertsClosed(env: Env, chainId: number, from: string, to: string): Promise<void> {
  const r = await env.KEEPER_DB.prepare('SELECT alert_key FROM keeper_ops_alert WHERE chain_id = ? ORDER BY alert_key').bind(chainId).all<{ alert_key: string }>();
  const keys = (r.results ?? []).map((x) => x.alert_key);
  if (keys.length === 0) return;
  for (const k of keys) console.log(`[keeper] chain ${chainId}: Diamond changed ${from} → ${to}; open ops alert closed unjudged: ${k}`);
  await sendOpsNoticeDigest(
    env,
    `[chain ${chainId}] keeper: the Diamond changed from ${from} to ${to}, so ${keys.length} open ops alert(s) about the retired Diamond are closed without being judged again`,
    keys,
    'Each was raised about the retired Diamond and is not followed against the new one. What it reported may still stand on the retired Diamond: check there directly where it matters. Conditions on the new Diamond are alerted afresh.',
  );
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
    // The INDEXER first, every tick (#2497 r12, #2569 r3): until it has
    // settled on the configured Diamond, the shared rows the passes join to
    // (loans, events) belong to another deployment, and a loan id the new
    // Diamond reuses would be read against the retired Diamond's row. That
    // holds whether the keeper's own record is behind (the keeper's deploy
    // landed before the indexer's), already matches (the indexer is mid-reset
    // on the same Diamond, or has moved on to one this bundle does not name),
    // or does not exist yet (a first record is never written against rows
    // the indexer has not settled). So the tick declines, and nothing below
    // runs, until the indexer's adoption equals the keeper's configuration.
    // eslint-disable-next-line no-await-in-loop
    const indexer = await indexerAdoptedFor(env, chain.id);
    if (indexer !== want) {
      throw new Error(
        `chain ${chain.id}: the configured Diamond ${want} is not the indexer's (${indexer ?? 'none settled: no record, or one whose reset is still pending'}); waiting for it to adopt the same deployment`,
      );
    }
    // eslint-disable-next-line no-await-in-loop
    const rec = await env.KEEPER_DB.prepare('SELECT diamond FROM keeper_deployment WHERE chain_id = ?')
      .bind(chain.id)
      .first<{ diamond: string }>();
    const have = rec?.diamond?.toLowerCase() ?? null;
    if (have === null) {
      // No record. The copy seeded one for every chain its rows were keyed
      // by, and every later record is written here, so no record should mean
      // no private rows — CHECKED, not assumed: rows
      // with no record belong to a Diamond nobody wrote down, and adopting
      // the configured one over them could keep a loan id the new Diamond
      // reuses "already notified" (#2569 r1).
      // eslint-disable-next-line no-await-in-loop
      tables ??= await listResetOnDiamondChange(env.KEEPER_DB);
      // eslint-disable-next-line no-await-in-loop
      const held = await tablesHolding(env.KEEPER_DB, tables, chain.id);
      if (held.length > 0) {
        throw new Error(
          `chain ${chain.id}: ${held.join(', ')} hold private rows but keeper_deployment records no Diamond they belong to; ` +
            'nothing writes that record for rows already there (the one-time copy that seeded it is retired, #2560): ' +
            'insert the Diamond they belong to into keeper_deployment, or delete those rows if they are known stale',
        );
      }
      // eslint-disable-next-line no-await-in-loop
      await env.KEEPER_DB.prepare('INSERT OR IGNORE INTO keeper_deployment (chain_id, diamond, adopted_at) VALUES (?, ?, ?)')
        .bind(chain.id, want, now)
        .run();
      continue;
    }
    if (have === want) continue;
    // eslint-disable-next-line no-await-in-loop
    tables ??= await listResetOnDiamondChange(env.KEEPER_DB);
    // Delete, VERIFY, and only then record (#2497 r11) — never a batch: the
    // machine reaches D1 over HTTP, whose batch atomicity is not established
    // (KeeperMachine.md). Each step is idempotent, and the record moves only
    // once every table reads empty for the chain, so a reset cut off anywhere
    // is redone whole by the next tick.
    // eslint-disable-next-line no-await-in-loop
    if (tables.includes('keeper_ops_alert')) await announceAlertsClosed(env, chain.id, have, want);
    for (const t of tables) {
      // eslint-disable-next-line no-await-in-loop
      await env.KEEPER_DB.prepare(`DELETE FROM "${t}" WHERE chain_id = ?`).bind(chain.id).run();
    }
    // eslint-disable-next-line no-await-in-loop
    const left = await tablesHolding(env.KEEPER_DB, tables, chain.id);
    if (left.length > 0) throw new Error(`reset for chain ${chain.id} left rows: ${left.join(', ')}`);
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
