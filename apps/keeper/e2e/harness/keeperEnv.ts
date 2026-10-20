/**
 * The keeper's environment for one scenario — what the Worker's bindings and
 * secrets are in production, built here for the scenario's node:
 *
 *   - `DB` and `KEEPER_DB`: in-memory SQLite databases built from the REAL
 *     migrations (the shared database from `apps/indexer/migrations`, the
 *     private one from `apps/keeper/migrations`), through the same harness
 *     the keeper's unit tests use (`test/helpers/schemas.ts`);
 *   - `RPC_BASE_SEPOLIA`: the scenario's node, which presents 84532 and whose
 *     Diamond the redirected deployments bundle names — so the keeper's own
 *     `getChainConfigs` resolves exactly one chain, the local one;
 *   - `KEEPER_ENABLED` + the pass's arming flag + `KEEPER_PRIVATE_KEY`: an
 *     Anvil well-known development key (`chain.ts`), never a real one.
 *
 * The keeper's epoch fence (`src/epochFence.ts`) refuses every send until the
 * indexer has adopted the Diamond (its `indexer_deployment` row) and a tick
 * has armed the fence for it. With `indexer: true` the REAL indexer adopts it
 * and keeps projecting the chain into the shared database (`indexer.ts`) —
 * for a pass whose candidates come from the indexer's rows. Without it, the
 * adoption row is written directly (the unit tests' `settleIndexer`), for a
 * pass that reads the chain alone.
 */
import type { Env } from '../../src/env';
import type { PassTick } from '../../src/passSchedule';
import { bindings, createKeeperD1, createSharedD1 } from '../../test/helpers/schemas';
import { armHeldFence, settleIndexer } from '../../test/helpers/epochFence';
import type { SqliteD1 } from '../../test/helpers/sqliteD1';
import { ANVIL_DEV_KEYS, type ScenarioChain } from './chain';
import { scenarioIndexer, type ScenarioIndexer } from './indexer';

export type PassFlag =
  | 'REWARD_HORIZON_HEARTBEAT_ENABLED'
  | 'REWARD_SANCTIONS_KEEPER_ENABLED'
  | 'REWARD_DELIVERY_PROOF_ENABLED';

export interface KeeperHarness {
  env: Env;
  shared: SqliteD1;
  keeperDb: SqliteD1;
  /** Present with `indexer: true`: run it before each keeper pass, as the
   *  indexer's own schedule would have. */
  indexer: ScenarioIndexer | null;
}

export async function keeperEnvFor(
  sc: ScenarioChain,
  flags: readonly PassFlag[],
  opts: { indexer?: boolean } = {},
): Promise<KeeperHarness> {
  const shared = createSharedD1();
  const keeperDb = createKeeperD1();
  const env = {
    ...bindings(shared, keeperDb),
    RPC_BASE_SEPOLIA: sc.url,
    KEEPER_ENABLED: 'true',
    KEEPER_PRIVATE_KEY: ANVIL_DEV_KEYS.keeper,
    ...Object.fromEntries(flags.map((f) => [f, 'true'])),
  } as unknown as Env;
  if (!opts.indexer) {
    settleIndexer(shared, sc.chain.id, sc.diamond);
    return { env, shared, keeperDb, indexer: null };
  }
  const indexer = scenarioIndexer(sc, shared);
  await indexer.index();
  const adopted = shared.db
    .prepare('SELECT diamond FROM indexer_deployment WHERE chain_id = ?')
    .get(sc.chain.id) as { diamond: string } | undefined;
  if (adopted?.diamond.toLowerCase() !== sc.diamond.toLowerCase()) {
    throw new Error(`keeper-e2e: the indexer adopted ${adopted?.diamond ?? 'nothing'}, not the scenario Diamond ${sc.diamond}`);
  }
  armHeldFence([{ id: sc.chain.id, diamond: sc.diamond }]);
  return { env, shared, keeperDb, indexer };
}

/** A tick as the scheduler hands one to a pass: scheduled now, with the
 *  pass's cadence (an hour, for every pass these scenarios drive) to run in. */
export function tickNow(cadenceMs = 60 * 60_000): PassTick {
  const now = Date.now();
  return { scheduledTimeMs: now, deadlineMs: now + cadenceMs - 60_000 };
}
