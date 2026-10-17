/**
 * Deployment epochs — the Diamond a chain's rows were indexed from
 * (#1566, Codex #2545 r1–r3).
 *
 * THE DEFECT THIS CLOSES. Offers and loans are keyed by `(chain_id, id)` and
 * the scan cursor by `(chain_id, kind)`; nothing in D1 named the Diamond the
 * rows came from. So a fresh redeploy — a NEW Diamond at a NEW deploy block on
 * the same chain — did not start a new epoch for a running indexer: the old
 * bundle's Worker kept advancing the cursor past the new deploy block until
 * the new bundle rolled out, the new Worker then resumed from that cursor and
 * skipped the interval forever, the retired Diamond's rows stayed, and their
 * ids collided with the ids the fresh Diamond restarts at. The deploy script's
 * row purge was the only enforcement — run OUTSIDE the indexer, against a
 * schema it introspected by hand, and it failed silently on the 2026-10-17
 * redeploy (its single-query introspection returns nothing on D1).
 *
 * THE RULE. `indexer_deployment` holds, per chain, the Diamond and deploy
 * block the indexer has ADOPTED. Every pass calls {@link adoptDeployment}
 * before it reads its cursor, and scans only if {@link isAdoptedEpoch}:
 *
 *   - no row            → record the bundle's Diamond as adopted BLIND
 *                         (`adopted_blind = 1`); reset NOTHING. There is no
 *                         prior record to compare, so there is no way to tell
 *                         which Diamond the existing rows came from. A deploy
 *                         that retires a Diamond SEEDS it (the deploy scripts
 *                         do, between migration apply and publish — see
 *                         `scripts/lib/retiredDeploymentSeed.mjs`); the seed
 *                         may correct a blind record, and the next pass does
 *                         the rest.
 *   - same Diamond      → nothing to do (compared case-insensitively — the
 *                         bundle carries checksummed addresses, a hand-written
 *                         row may not).
 *   - OLDER deployment  → REFUSED: a Worker built from a stale branch names a
 *                         Diamond deployed before the adopted one. A new
 *                         epoch only moves forward; the pass does not scan.
 *   - different, newer  → a NEW EPOCH: claim it with a conditional UPDATE
 *                         (one winner), then in ONE batch delete this chain's
 *                         rows from every chain-scoped table (see below) and
 *                         clear `reset_pending` — every statement of that
 *                         batch is guarded by the claim (chain, Diamond,
 *                         deploy block, flag still set), so a pass whose claim
 *                         was overtaken by a later deployment deletes nothing
 *                         and is told so. A pass that dies between claim and
 *                         batch leaves the flag set; the next pass under the
 *                         same Diamond finishes the reset. The cursor rows go
 *                         with the rest, so the scan that follows reseeds from
 *                         `deployBlock - 1` exactly as a cold start does.
 *
 * WHICH TABLES. Schema-aware, not a hand-kept list, and found in ONE query:
 * every table whose DDL in `sqlite_master` declares a `chain_id` column, MINUS
 * the user-owned tables `diamondEpochKeep.json` names and the record itself.
 * One query because a pass has a 50-query D1 budget (`subrequestBudget.ts`)
 * and a per-table `pragma_table_info` walk alone would spend it; the test
 * suite pins the one-query answer to a per-table pragma oracle on the real
 * schema, so a DDL comment that merely mentions the column cannot drift in
 * unnoticed. The default is therefore RESET: a chain-scoped table added
 * tomorrow is cleared with the others unless someone writes down why its rows
 * are the user's and not the chain's.
 *
 * The user-owned exception is deliberately narrow. `notify_state` and
 * `pre_grace_notify_state` are born off-chain for RESTORE purposes (they are
 * archived nightly), but they are keyed by loan id: a dedupe row left over
 * from a retired Diamond would SUPPRESS the first alert on a fresh loan that
 * reuses the id. Restore treatment and epoch treatment are different axes.
 */
import keep from './diamondEpochKeep.json';

/** The D1 surface this module uses; the sqlite test adapter provides the same. */
export interface EpochDb {
  prepare(sql: string): {
    bind(...args: unknown[]): {
      first<T = unknown>(): Promise<T | null>;
      all<T = unknown>(): Promise<{ results?: T[] }>;
      run(): Promise<{ meta?: { changes?: number } }>;
    };
    first<T = unknown>(): Promise<T | null>;
    all<T = unknown>(): Promise<{ results?: T[] }>;
  };
  batch(statements: unknown[]): Promise<unknown>;
}

/** Tables a Diamond change on a chain leaves alone, with the reason each is the user's. */
export const KEEP_ON_DIAMOND_CHANGE: Readonly<Record<string, string>> = keep.keep;

/** The epoch record itself carries `chain_id`; it is what the reset is ABOUT, never what it clears. */
const EPOCH_RECORD_TABLE = 'indexer_deployment';

export interface DeploymentRecord {
  chainId: number;
  diamond: string;
  deployBlock: number;
  adoptedAt: number;
  resetPending: boolean;
  /** Recorded by a first adoption with no prior record: nothing was reset, and a retired-Diamond seed may still correct it. */
  adoptedBlind: boolean;
}

export type AdoptOutcome =
  | { outcome: 'first' }
  | { outcome: 'same' }
  | { outcome: 'reset'; previous: string; tables: string[] }
  | { outcome: 'reset-resumed'; tables: string[] }
  /** Another pass adopted a DIFFERENT Diamond between this pass's read and its claim (or overtook its reset). */
  | { outcome: 'raced'; adopted: string }
  /** The bundle names a Diamond deployed BEFORE the adopted one: a stale build, never a new epoch. */
  | { outcome: 'refused-older'; adopted: string; adoptedDeployBlock: number };

/**
 * Whether the pass that got this outcome may scan: only when ITS Diamond is
 * the adopted epoch and no reset is pending. A pass refused as stale, or one
 * that lost the claim to a different Diamond, must return without scanning —
 * it would read the retired or losing Diamond, repopulate rows after the
 * reset and advance the shared cursor (Codex #2545 r2 P1).
 */
export function isAdoptedEpoch(r: AdoptOutcome): boolean {
  return r.outcome === 'first' || r.outcome === 'same' || r.outcome === 'reset' || r.outcome === 'reset-resumed';
}

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** The adopted deployment for a chain, or null before the first pass records one. */
export async function readAdoptedDeployment(db: EpochDb, chainId: number): Promise<DeploymentRecord | null> {
  const row = await db
    .prepare(
      `SELECT diamond, deploy_block, adopted_at, reset_pending, adopted_blind FROM indexer_deployment WHERE chain_id = ?`,
    )
    .bind(chainId)
    .first<{ diamond: string; deploy_block: number; adopted_at: number; reset_pending: number; adopted_blind: number }>();
  if (!row) return null;
  return {
    chainId,
    diamond: row.diamond,
    deployBlock: row.deploy_block,
    adoptedAt: row.adopted_at,
    resetPending: row.reset_pending !== 0,
    adoptedBlind: row.adopted_blind !== 0,
  };
}

/**
 * Every table carrying a `chain_id` column, by name, sorted — in ONE query.
 * The DDL text in `sqlite_master` is matched on a `chain_id` token bounded by
 * non-identifier characters, which is how a column declaration appears
 * (`  chain_id INTEGER …`) and how `source_chain_id` or `chain_ids` do not.
 * Tooling tables (`d1_migrations`, `sqlite_sequence`, `_cf_KV`) carry no such
 * column and are excluded by name as well. `deploymentEpoch.test.ts` pins
 * this answer to a per-table `pragma_table_info` oracle on the real schema.
 */
export async function listChainScopedTables(db: EpochDb): Promise<string[]> {
  const tables = await db
    .prepare(
      `SELECT name FROM sqlite_master
        WHERE type = 'table'
          AND name NOT LIKE 'sqlite_%'
          AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'
          AND name <> 'd1_migrations'
          AND sql GLOB '*[^a-zA-Z0-9_]chain_id[^a-zA-Z0-9_]*'
        ORDER BY name`,
    )
    .all<{ name: string }>();
  return (tables.results ?? []).map((t) => t.name);
}

/** The chain-scoped tables a Diamond change resets: every one with `chain_id`, minus the record and the keep list. */
export async function listTablesResetOnDiamondChange(db: EpochDb): Promise<string[]> {
  return (await listChainScopedTables(db)).filter(
    (t) => t !== EPOCH_RECORD_TABLE && !Object.hasOwn(KEEP_ON_DIAMOND_CHANGE, t),
  );
}

/** What a pass claimed when it marked the epoch: every reset statement is guarded by it. */
export interface EpochClaim {
  chainId: number;
  diamond: string;
  deployBlock: number;
}

/**
 * Delete one chain's rows from every reset table and clear the pending flag,
 * atomically and ONLY IF the claim still holds. One D1 batch is one
 * transaction; every DELETE carries the ownership predicate (the record still
 * names this claim's Diamond and deploy block with the flag set), so a claim
 * overtaken by a later deployment deletes nothing — the final UPDATE's change
 * count says whether this pass owned the reset (Codex #2545 r3 P1).
 */
export async function resetChainAs(db: EpochDb, claim: EpochClaim): Promise<{ owned: boolean; tables: string[] }> {
  const { chainId, diamond, deployBlock } = claim;
  const tables = await listTablesResetOnDiamondChange(db);
  const owns =
    `EXISTS (SELECT 1 FROM indexer_deployment d
              WHERE d.chain_id = ? AND lower(d.diamond) = lower(?) AND d.deploy_block = ? AND d.reset_pending = 1)`;
  const statements: unknown[] = tables.map((t) =>
    db.prepare(`DELETE FROM "${t}" WHERE chain_id = ? AND ${owns}`).bind(chainId, chainId, diamond, deployBlock),
  );
  statements.push(
    db
      .prepare(
        `UPDATE indexer_deployment SET reset_pending = 0, adopted_blind = 0
          WHERE chain_id = ? AND lower(diamond) = lower(?) AND deploy_block = ? AND reset_pending = 1`,
      )
      .bind(chainId, diamond, deployBlock),
  );
  const results = (await db.batch(statements)) as Array<{ meta?: { changes?: number } }> | undefined;
  const completion = Array.isArray(results) ? results[results.length - 1] : undefined;
  const owned = (completion?.meta?.changes ?? 0) === 1;
  return { owned, tables };
}

/**
 * Adopt the bundle's deployment for a chain, resetting the chain's rows when
 * the Diamond changed. Call at the top of every pass, before the cursor read
 * and before any write; scan only if {@link isAdoptedEpoch}. Cheap on the
 * steady state: one SELECT.
 */
export async function adoptDeployment(
  db: EpochDb,
  args: { chainId: number; diamond: string; deployBlock: bigint | number; nowSec?: number },
): Promise<AdoptOutcome> {
  const { chainId, diamond } = args;
  const deployBlock = Number(args.deployBlock);
  const nowSec = args.nowSec ?? Math.floor(Date.now() / 1000);
  const current = await readAdoptedDeployment(db, chainId);

  if (current === null) {
    await db
      .prepare(
        `INSERT INTO indexer_deployment (chain_id, diamond, deploy_block, adopted_at, reset_pending, adopted_blind)
         VALUES (?, ?, ?, ?, 0, 1)
         ON CONFLICT(chain_id) DO NOTHING`,
      )
      .bind(chainId, diamond, deployBlock, nowSec)
      .run();
    return { outcome: 'first' };
  }

  if (same(current.diamond, diamond)) {
    if (!current.resetPending) return { outcome: 'same' };
    // A prior pass under this Diamond marked the epoch and died before its
    // batch landed: finish it, under the same claim.
    const r = await resetChainAs(db, { chainId, diamond: current.diamond, deployBlock: current.deployBlock });
    if (r.owned) return { outcome: 'reset-resumed', tables: r.tables };
    const now = await readAdoptedDeployment(db, chainId);
    return { outcome: 'raced', adopted: now?.diamond ?? '(none)' };
  }

  // A new epoch only ever moves FORWARD. A Worker built from a stale branch
  // carries a bundle naming an OLDER deployment than the one adopted; letting
  // it "adopt" would wipe a live chain's index for a Diamond that was retired.
  // The reset is reserved for a Diamond deployed after the adopted one; this
  // case is refused loudly and the pass does not scan.
  if (deployBlock < current.deployBlock) {
    return { outcome: 'refused-older', adopted: current.diamond, adoptedDeployBlock: current.deployBlock };
  }

  // A different Diamond: claim the epoch with a conditional write so that two
  // concurrent passes cannot both own the reset — only the one whose UPDATE
  // changed a row proceeds; the other re-reads the record.
  const claimed = await db
    .prepare(
      `UPDATE indexer_deployment
          SET diamond = ?, deploy_block = ?, adopted_at = ?, reset_pending = 1, adopted_blind = 0
        WHERE chain_id = ? AND lower(diamond) = lower(?)`,
    )
    .bind(diamond, deployBlock, nowSec, chainId, current.diamond)
    .run();
  if ((claimed.meta?.changes ?? 0) === 0) {
    // The record moved under us. If a sibling pass of THIS bundle won, its
    // Diamond is ours and the epoch is adopted; otherwise a different
    // Diamond holds it and this pass must not scan.
    const now = await readAdoptedDeployment(db, chainId);
    if (now !== null && same(now.diamond, diamond) && !now.resetPending) return { outcome: 'same' };
    return { outcome: 'raced', adopted: now?.diamond ?? '(none)' };
  }
  const r = await resetChainAs(db, { chainId, diamond, deployBlock });
  if (r.owned) return { outcome: 'reset', previous: current.diamond, tables: r.tables };
  // A later deployment overtook this claim between the claim and the batch:
  // the guarded batch deleted nothing, and this pass must not scan.
  const now = await readAdoptedDeployment(db, chainId);
  return { outcome: 'raced', adopted: now?.diamond ?? '(none)' };
}

/** One line for the pass log; silent on the steady state. */
export function describeAdoption(chainId: number, diamond: string, deployBlock: bigint | number, r: AdoptOutcome): string | null {
  switch (r.outcome) {
    case 'same':
      return null;
    case 'first':
      return (
        `[deploymentEpoch] chain ${chainId}: adopted Diamond ${diamond} (deploy block ${deployBlock}) blind — ` +
        `first record, no reset; seed the retired Diamond if rows predate it`
      );
    case 'reset':
      return (
        `[deploymentEpoch] chain ${chainId}: Diamond changed ${r.previous} → ${diamond} (deploy block ${deployBlock}); ` +
        `reset ${r.tables.length} chain-scoped table(s): ${r.tables.join(' ')}`
      );
    case 'reset-resumed':
      return `[deploymentEpoch] chain ${chainId}: finished an interrupted reset for Diamond ${diamond} (${r.tables.length} table(s))`;
    case 'raced':
      return `[deploymentEpoch] chain ${chainId}: another pass adopted Diamond ${r.adopted} while this one (${diamond}) was claiming — not scanning`;
    case 'refused-older':
      return (
        `[deploymentEpoch] chain ${chainId}: REFUSED to adopt Diamond ${diamond} (deploy block ${deployBlock}) — ` +
        `the adopted ${r.adopted} was deployed later (block ${r.adoptedDeployBlock}); this build carries a stale bundle`
      );
  }
}
