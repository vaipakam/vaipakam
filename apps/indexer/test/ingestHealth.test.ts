/**
 * `GET /health/ingest` (#2469): the facts a prober outside the Worker needs
 * to tell a stalled ingest from a healthy one, and — when the schema gate is
 * the cause — which migration it is waiting for.
 */
import { describe, expect, it } from 'vitest';
import { createSqliteD1 } from './helpers/sqliteD1';
import { handleIngestHealth, readIngestHealth } from '../src/healthRoutes';
import { createSchemaGate } from '../src/schemaGate';
import { REQUIRED_D1_MIGRATIONS } from '../src/requiredMigrations';

const DDL = [
  `CREATE TABLE d1_migrations(
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     name TEXT UNIQUE,
     applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
   )`,
  `CREATE TABLE indexer_cursor (
     chain_id INTEGER NOT NULL, kind TEXT NOT NULL,
     last_block INTEGER NOT NULL, updated_at INTEGER NOT NULL,
     PRIMARY KEY (chain_id, kind)
   )`,
  `CREATE TABLE indexer_deployment (
     chain_id INTEGER PRIMARY KEY, diamond TEXT NOT NULL,
     deploy_block INTEGER NOT NULL, adopted_at INTEGER NOT NULL,
     reset_pending INTEGER NOT NULL DEFAULT 0
   )`,
];
const DIAMOND = '0x2535baC87F3df287268fC697F2f31cf418365303';

function seeded(migrations: readonly string[]) {
  const h = createSqliteD1(DDL);
  for (const n of migrations) h.db.prepare('INSERT INTO d1_migrations (name) VALUES (?)').run(n);
  const cursor = h.db.prepare(
    'INSERT INTO indexer_cursor (chain_id, kind, last_block, updated_at) VALUES (?, ?, ?, ?)',
  );
  cursor.run(84532, 'diamond', 500, 1_000);
  cursor.run(97, 'diamond', 900, 1_090);
  // Other cursor kinds are watermarks, not the scan position.
  cursor.run(84532, 'loan_reconcile', 7, 10);
  // Base has adopted a deployment; 97 has not been through a pass under 0063 yet.
  h.db
    .prepare(
      'INSERT INTO indexer_deployment (chain_id, diamond, deploy_block, adopted_at, reset_pending) VALUES (?, ?, ?, ?, ?)',
    )
    .run(84532, DIAMOND, 400, 950, 0);
  return h;
}

describe('readIngestHealth', () => {
  it('reports each scanned chain from the diamond cursor only, with its age', async () => {
    const h = seeded(REQUIRED_D1_MIGRATIONS);
    const out = await readIngestHealth(h.d1 as never, createSchemaGate(), 1_100);
    expect(out).toEqual({
      checkedAt: 1_100,
      schema: { state: 'current' },
      chains: [
        { chainId: 97, lastBlock: 900, scannedAt: 1_090, ageSeconds: 10, deployment: null },
        {
          chainId: 84532,
          lastBlock: 500,
          scannedAt: 1_000,
          ageSeconds: 100,
          deployment: { diamond: DIAMOND, deployBlock: 400, adoptedAt: 950, resetPending: false },
        },
      ],
    });
  });

  it('states a chain that has an adopted deployment but no cursor yet, with null cursor fields — never omits it', async () => {
    // An epoch reset cleared 421614's cursor and the scan that followed died
    // before recreating one: the deployment row is the only trace, and it is
    // exactly what an operator checking the redeploy needs to see.
    const h = seeded(REQUIRED_D1_MIGRATIONS);
    h.db
      .prepare('INSERT INTO indexer_deployment (chain_id, diamond, deploy_block, adopted_at, reset_pending) VALUES (?, ?, ?, ?, ?)')
      .run(421614, DIAMOND, 320_151_741, 1_050, 0);
    const out = await readIngestHealth(h.d1 as never, createSchemaGate(), 1_100);
    expect(out.chains.map((c) => c.chainId)).toEqual([97, 84532, 421614]);
    expect(out.chains[2]).toEqual({
      chainId: 421614,
      lastBlock: null,
      scannedAt: null,
      ageSeconds: null,
      deployment: { diamond: DIAMOND, deployBlock: 320_151_741, adoptedAt: 1_050, resetPending: false },
    });
  });

  it('reports every chain with `deployment: null` while the deployment table does not exist yet', async () => {
    // The deploy-before-migration window for 0063: the schema answer must
    // still be served, never a 503 because the new table is missing.
    const h = createSqliteD1([DDL[0], DDL[1]]);
    for (const n of REQUIRED_D1_MIGRATIONS) h.db.prepare('INSERT INTO d1_migrations (name) VALUES (?)').run(n);
    h.db.prepare('INSERT INTO indexer_cursor (chain_id, kind, last_block, updated_at) VALUES (?, ?, ?, ?)').run(84532, 'diamond', 500, 1_000);
    const out = await readIngestHealth(h.d1 as never, createSchemaGate(), 1_100);
    expect(out.chains).toEqual([{ chainId: 84532, lastBlock: 500, scannedAt: 1_000, ageSeconds: 100, deployment: null }]);
  });

  it('names the missing migration when the gate is the reason ingest declines', async () => {
    const h = seeded(REQUIRED_D1_MIGRATIONS.slice(0, -1));
    const out = await readIngestHealth(h.d1 as never, createSchemaGate(), 1_100);
    expect(out.schema).toEqual({
      state: 'pending',
      missing: [REQUIRED_D1_MIGRATIONS[REQUIRED_D1_MIGRATIONS.length - 1]],
    });
  });

  it('reports the gate as unknown, not current, when the migration record cannot be read', async () => {
    const h = createSqliteD1([DDL[1]]);
    const out = await readIngestHealth(h.d1 as never, createSchemaGate(), 1_100);
    expect(out.schema).toEqual({ state: 'unknown' });
  });

  it('reports a cursor ahead of the clock as a NEGATIVE age, never as fresh (#2482 r2)', async () => {
    const h = seeded(REQUIRED_D1_MIGRATIONS);
    const out = await readIngestHealth(h.d1 as never, createSchemaGate(), 900);
    // 84532 was stamped at 1_000 and 97 at 1_090: both ahead of 900.
    expect(out.chains.map((c) => c.ageSeconds)).toEqual([-190, -100]);
  });
});

describe('handleIngestHealth', () => {
  it('answers uncached with open CORS', async () => {
    const res = await handleIngestHealth(seeded(REQUIRED_D1_MIGRATIONS).d1 as never);
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });

  it('is a 503, never an empty 200, when the cursor cannot be read', async () => {
    // No indexer_cursor table: an empty chain list here would read as
    // "nothing is stale".
    const res = await handleIngestHealth(createSqliteD1([DDL[0]]).d1 as never);
    expect(res.status).toBe(503);
  });
});
