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

/** The deployment a chain's rows were indexed from (#1566 / Codex #2545 r1). */
export interface AdoptedDeployment {
  diamond: string;
  deployBlock: number;
  /** When the indexer adopted this Diamond (unix seconds). */
  adoptedAt: number;
  /** True while a Diamond-change reset is claimed but its batch has not landed. */
  resetPending: boolean;
}

/** One scanned chain's ingest position. */
export interface ChainIngestState {
  chainId: number;
  /** Null before the first pass under migration 0063 records one. */
  deployment: AdoptedDeployment | null;
  /** The last block the diamond scan completed through; null when the chain
   *  has an adopted deployment but no cursor yet (an epoch reset cleared it
   *  and no scan has recreated it). */
  lastBlock: number | null;
  /** When the cursor last advanced (unix seconds); null as above. */
  scannedAt: number | null;
  /** `checkedAt − scannedAt`. NEGATIVE when the cursor's timestamp is ahead
   *  of this Worker's clock (a restored row, clock skew) — kept as it is
   *  rather than clamped to 0, which would report an unknown as fresh. Null
   *  when there is no cursor. */
  ageSeconds: number | null;
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
  // The adopted deployment per chain (#1566 / Codex #2545 r1) — which
  // Diamond the rows were indexed from, so a prober can tell a redeploy the
  // indexer has adopted from one it has not. Read separately and tolerantly:
  // before migration 0063 lands the table does not exist, and that window is
  // exactly when the schema answer above must still be served, not a 503.
  const deployments = new Map<number, AdoptedDeployment>();
  try {
    const d = await db
      .prepare(`SELECT chain_id, diamond, deploy_block, adopted_at, reset_pending FROM indexer_deployment`)
      .all<{ chain_id: number; diamond: string; deploy_block: number; adopted_at: number; reset_pending: number }>();
    for (const r of d.results ?? []) {
      deployments.set(r.chain_id, {
        diamond: r.diamond,
        deployBlock: r.deploy_block,
        adoptedAt: r.adopted_at,
        resetPending: r.reset_pending !== 0,
      });
    }
  } catch {
    // Table not there yet: every chain reports `deployment: null` below.
  }
  // The UNION of cursor rows and deployment rows (Codex #2545 r2 P2): an
  // epoch reset deletes the chain's cursor, and if the scan that follows
  // fails before it recreates one (RPC identity, head read) the chain would
  // otherwise vanish from this answer exactly while an operator is checking
  // the redeploy. A chain with a deployment and no cursor is stated as such,
  // with its cursor fields null — never omitted.
  const byChain = new Map<number, ChainIngestState>();
  for (const r of res.results ?? []) {
    byChain.set(r.chain_id, {
      chainId: r.chain_id,
      lastBlock: r.last_block,
      scannedAt: r.updated_at,
      ageSeconds: nowSec - r.updated_at,
      deployment: deployments.get(r.chain_id) ?? null,
    });
  }
  for (const [chainId, deployment] of deployments) {
    if (!byChain.has(chainId)) {
      byChain.set(chainId, { chainId, lastBlock: null, scannedAt: null, ageSeconds: null, deployment });
    }
  }
  const chains = [...byChain.values()].sort((a, b) => a.chainId - b.chainId);
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
