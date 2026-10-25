/**
 * The REAL indexer, projecting the scenario chain into the shared database.
 *
 * In production the keeper never reads the chain's history itself: the
 * indexer Worker ingests the Diamond's events into the shared D1
 * (`vaipakam-warm`), and passes such as the sanctions-hold observer take
 * their candidates from those rows — the loan parties (`loans`,
 * `loan_participants`) and the reward evidence and staging events
 * (`activity_events`). So a scenario that seeded those rows by hand would test
 * the keeper against the scenario's idea of the indexer, not the indexer.
 * Instead each step runs the indexer's own per-chain pass
 * (`runChainIndexerForChain`, the function the ingest Durable Object and the
 * cron lane both call) against the same node and the same shared database the
 * keeper reads.
 *
 * Two things a deployed indexer has that an in-memory database built from
 * the migrations does not, supplied here as wrangler and the deploy would:
 *
 *   - the `d1_migrations` record, which wrangler writes as it applies each
 *     migration and the indexer's schema gate reads before any write;
 *   - its outbound `fetchFn`, narrowed to the scenario's node: anything else
 *     the pass tried to reach (a third-party API it is configured not to call
 *     here) fails loudly instead of leaving the machine.
 */
import { readdirSync } from 'node:fs';
import { runChainIndexerForChain } from '../../../indexer/src/chainIndexer';
import type { Env as IndexerEnv } from '../../../indexer/src/env';
import { INDEXER_MIGRATIONS_DIR } from '../../test/helpers/schemas';
import type { SqliteD1 } from '../../test/helpers/sqliteD1';
import type { ScenarioChain } from '@vaipakam/anvil-harness/scenarioChain';
import { SETTLED_DEPTH } from './chain';

/** Record every indexer migration as applied, the way wrangler does. */
export function recordAppliedMigrations(shared: SqliteD1): void {
  shared.db.exec(
    `CREATE TABLE IF NOT EXISTS d1_migrations (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       name TEXT UNIQUE,
       applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
     )`,
  );
  const insert = shared.db.prepare('INSERT OR IGNORE INTO d1_migrations (name) VALUES (?)');
  for (const f of readdirSync(INDEXER_MIGRATIONS_DIR).filter((n) => n.endsWith('.sql')).sort()) insert.run(f);
}

/** A fetch that reaches the scenario's node and nothing else. */
function nodeOnlyFetch(nodeUrl: string): typeof fetch {
  const allowed = new URL(nodeUrl).origin;
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.origin !== allowed) throw new Error(`keeper-e2e: the indexer tried to reach ${url.origin}; only the scenario node is allowed`);
    return fetch(input, init);
  }) as typeof fetch;
}

export interface ScenarioIndexer {
  /** Indexer passes until the cursor reaches the chain head. Returns the
   *  last pass's outcome. */
  index(): Promise<string>;
}

/** The indexer's own RPC binding and display name for each chain id a
 *  scenario node presents (`apps/indexer/src/env.ts`). */
export const SCENARIO_CHAIN_BINDINGS: Readonly<Record<number, { rpcKey: 'RPC_BASE_SEPOLIA' | 'RPC_SEPOLIA'; name: string }>> = {
  84532: { rpcKey: 'RPC_BASE_SEPOLIA', name: 'Base Sepolia' },
  11155111: { rpcKey: 'RPC_SEPOLIA', name: 'Sepolia' },
};

export function bindingFor(chainId: number): { rpcKey: 'RPC_BASE_SEPOLIA' | 'RPC_SEPOLIA'; name: string } {
  const b = SCENARIO_CHAIN_BINDINGS[chainId];
  if (!b) throw new Error(`keeper-e2e: no RPC binding is known for chain ${chainId}`);
  return b;
}

/** One chain's indexer. A scenario spanning two chains runs one per chain,
 *  all writing the SAME shared database — as the deployed indexer does. */
export function scenarioIndexer(sc: ScenarioChain, shared: SqliteD1): ScenarioIndexer {
  recordAppliedMigrations(shared);
  const binding = bindingFor(sc.chain.id);
  const env = {
    DB: shared.d1,
    [binding.rpcKey]: sc.url,
    fetchFn: nodeOnlyFetch(sc.url),
  } as unknown as IndexerEnv;
  const chain = { id: sc.chain.id, name: binding.name, rpc: sc.url, diamond: sc.diamond };
  return {
    async index() {
      // A first pass on an empty database adopts the Diamond (reporting an
      // epoch reset); the passes after it scan, each up to its own range
      // bound, until the cursor reaches the head. Bounded either way.
      // A live chain has moved well past the settled depth by the time the
      // indexer's next run comes round; this node has to be told to.
      await sc.mineBlocks(SETTLED_DEPTH + 8);
      let last = '';
      for (let i = 0; i < 20; i++) {
        const r = await runChainIndexerForChain(env, chain);
        last = r.skipped ?? `scanned ${r.scannedFrom}-${r.scannedTo}`;
        if (r.skipped === 'epoch-reset') continue;
        if (r.skipped === 'caught-up') return last;
        if (r.skipped) throw new Error(`keeper-e2e: the indexer pass declined: ${r.skipped}`);
        if (r.scannedTo >= (await sc.blockNumber())) return last;
      }
      throw new Error(`keeper-e2e: the indexer pass did not reach the head: ${last}`);
    },
  };
}
