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
  /** True when a first pass recorded this Diamond with nothing reset; a
   *  retired-Diamond seed may still replace it (see deploymentEpoch.ts). */
  adoptedBlind: boolean;
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
  // ONE statement, ONE snapshot (Codex #2545 r6 P2): the UNION of cursor rows
  // and deployment rows is read atomically, so an epoch reset committing
  // between two separate reads cannot pair the retired epoch's cursor with
  // the new Diamond's record. A chain is listed from its cursor OR its
  // deployment (#2545 r2 P2): right after a reset it may have a deployment
  // and no cursor yet, and is stated with null cursor fields, never omitted.
  type Row = {
    chain_id: number;
    last_block: number | null;
    updated_at: number | null;
    diamond: string | null;
    deploy_block: number | null;
    adopted_at: number | null;
    reset_pending: number | null;
    adopted_blind: number | null;
  };
  const joined =
    `SELECT c.chain_id, c.last_block, c.updated_at,
            d.diamond, d.deploy_block, d.adopted_at, d.reset_pending, d.adopted_blind
       FROM indexer_cursor c LEFT JOIN indexer_deployment d ON d.chain_id = c.chain_id
      WHERE c.kind = ?
     UNION ALL
     SELECT d.chain_id, NULL, NULL,
            d.diamond, d.deploy_block, d.adopted_at, d.reset_pending, d.adopted_blind
       FROM indexer_deployment d
      WHERE NOT EXISTS (SELECT 1 FROM indexer_cursor c WHERE c.chain_id = d.chain_id AND c.kind = ?)
      ORDER BY 1`;
  let rows: Row[];
  try {
    rows = (await db.prepare(joined).bind(CURSOR_KIND, CURSOR_KIND).all<Row>()).results ?? [];
  } catch (err) {
    // Only the KNOWN pre-migration case is tolerated: before migration 0063
    // the deployment table does not exist, and that window is exactly when
    // the schema answer above must still be served, not a 503. Any other
    // failure propagates to the route's 503, so a failed read never
    // masquerades as "no adopted epoch" (Codex #2545 r3 P2).
    if (!/no such table/i.test((err as Error).message ?? '')) throw err;
    const cursorOnly = await db
      .prepare(`SELECT chain_id, last_block, updated_at FROM indexer_cursor WHERE kind = ? ORDER BY chain_id`)
      .bind(CURSOR_KIND)
      .all<{ chain_id: number; last_block: number; updated_at: number }>();
    rows = (cursorOnly.results ?? []).map((r) => ({
      chain_id: r.chain_id,
      last_block: r.last_block,
      updated_at: r.updated_at,
      diamond: null,
      deploy_block: null,
      adopted_at: null,
      reset_pending: null,
      adopted_blind: null,
    }));
  }
  const chains: ChainIngestState[] = rows.map((r) => ({
    chainId: r.chain_id,
    lastBlock: r.last_block,
    scannedAt: r.updated_at,
    ageSeconds: r.updated_at === null ? null : nowSec - r.updated_at,
    deployment:
      r.diamond === null
        ? null
        : {
            diamond: r.diamond,
            deployBlock: r.deploy_block ?? 0,
            adoptedAt: r.adopted_at ?? 0,
            resetPending: (r.reset_pending ?? 0) !== 0,
            adoptedBlind: (r.adopted_blind ?? 0) !== 0,
          },
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
