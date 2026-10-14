/**
 * `GET /health/ingest` — whether scheduled ingest is advancing, and if not,
 * the one cause this Worker can name on its own behalf (#2469).
 *
 * WHY THIS EXISTS. A stalled ingest is silent. The schema gate
 * (schemaGate.ts) declines every scheduled tick until this build's
 * migrations are applied, and it says so — in the Worker's logs, which
 * nobody reads until a user reports a stale screen. That is what happened
 * when Workers Builds published a build ahead of migration 0056: the gate
 * did exactly its job, and the stall still went unnoticed. This route puts
 * the same facts where a prober outside the Worker can read them.
 *
 * WHAT IT REPORTS — facts, not a verdict:
 *  - `schema`: the gate's own answer for THIS build, with the names of any
 *    missing migrations. The same `schemaGate` the cron consults, so the
 *    route and the tick cannot disagree about why work is declining.
 *  - `chains`: one entry per scanned chain — the last block the diamond
 *    cursor reached and when (unix seconds), with the age computed here so
 *    the prober's clock does not enter the arithmetic.
 *
 * It does NOT decide what "stale" means. The cursor advances only after a
 * scan completes and only forward (chainIndexer.ts), so its age is the
 * honest measure; the threshold depends on the cron cadence and the
 * prober's tolerance, and a chain this Worker no longer scans keeps its
 * last row forever. Both are the prober's to judge — a threshold baked in
 * here would be a claim this route cannot substantiate for every caller.
 *
 * D1 only, dispatched before `resolveEnv` (see index.ts): a health signal
 * must not depend on the Secrets Store fan-out it may be reporting on. The
 * response is never cached — a stale health answer is worse than none.
 */
import { CURSOR_KIND } from './chainIndexer';
import { schemaGate, type SchemaCheck } from './schemaGate';

/** The narrow D1 surface this route reads. */
interface D1Like {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      all<T = unknown>(): Promise<{ results?: T[] }>;
    };
    all<T = unknown>(): Promise<{ results?: T[] }>;
  };
}

/** One scanned chain's ingest position. */
export interface ChainIngestState {
  chainId: number;
  /** The last block the diamond scan completed through. */
  lastBlock: number;
  /** When the cursor last advanced (unix seconds). */
  scannedAt: number;
  /** `checkedAt − scannedAt`, never negative. */
  ageSeconds: number;
}

export interface IngestHealth {
  /** When this answer was computed (unix seconds). */
  checkedAt: number;
  schema: SchemaCheck;
  chains: ChainIngestState[];
}

/**
 * Read the ingest state. `gate` and `nowSec` are parameters so a test can
 * pin both; the route passes the Worker's singleton gate and the clock.
 */
export async function readIngestHealth(
  db: D1Like,
  gate: { check(db: D1Like): Promise<SchemaCheck> } = schemaGate,
  nowSec: number = Math.floor(Date.now() / 1000),
): Promise<IngestHealth> {
  const schema = await gate.check(db);
  const res = await db
    .prepare(
      `SELECT chain_id, last_block, updated_at FROM indexer_cursor
        WHERE kind = ? ORDER BY chain_id`,
    )
    .bind(CURSOR_KIND)
    .all<{ chain_id: number; last_block: number; updated_at: number }>();
  const chains = (res.results ?? []).map((r) => ({
    chainId: r.chain_id,
    lastBlock: r.last_block,
    scannedAt: r.updated_at,
    ageSeconds: Math.max(0, nowSec - r.updated_at),
  }));
  return { checkedAt: nowSec, schema, chains };
}

const HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
  'Access-Control-Allow-Origin': '*',
};

/**
 * The HTTP wrapper. A failed cursor read is a 503 naming that it failed —
 * never a 200 with an empty chain list, which a prober would read as
 * "nothing to be stale".
 */
export async function handleIngestHealth(db: D1Like): Promise<Response> {
  try {
    return new Response(JSON.stringify(await readIngestHealth(db)), { status: 200, headers: HEADERS });
  } catch (err) {
    console.error(`[indexer] /health/ingest read failed: ${(err as Error).message}`);
    return new Response(JSON.stringify({ error: 'ingest state could not be read' }), {
      status: 503,
      headers: HEADERS,
    });
  }
}
