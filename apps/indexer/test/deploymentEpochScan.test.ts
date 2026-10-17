/**
 * Only the adopted deployment epoch scans (Codex #2545 r2 P1). A pass whose
 * bundle is not the adopted epoch for its chain — a stale build, or a claim
 * lost to a different Diamond — returns before its first RPC request and
 * before any cursor write, and the ingest loop treats that as a declined
 * pass (finish, not rearm), the way it treats a schema decline.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { getDeployment } from '@vaipakam/contracts/deployments';
import { createSqliteD1 } from './helpers/sqliteD1';
import { REQUIRED_D1_MIGRATIONS } from '../src/requiredMigrations';
import { isEpochDeclinedSkip, runChainIndexerForChain } from '../src/chainIndexer';
import { alarmNextStep } from '../src/chainIngestDO';
import { readAdoptedDeployment } from '../src/deploymentEpoch';
import type { ChainConfig, Env } from '../src/env';

const MIGRATIONS_DIR = new URL('../migrations/', import.meta.url);
const migrations = () =>
  readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => readFileSync(new URL(f, MIGRATIONS_DIR), 'utf8'));

/** wrangler's own DDL for the migrations table, with every required migration recorded. */
const MIGRATIONS_DDL = `CREATE TABLE d1_migrations(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE,
  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
)`;

const BASE = 84532;
const bundle = getDeployment(BASE);
if (!bundle) throw new Error('deployments.json carries no Base Sepolia (84532) entry');
/** A Diamond "deployed later" than the bundle's: the record a NEWER build adopted. */
const LATER_DIAMOND = '0x00000000000000000000000000000000000000ff';

function migratedDb() {
  const h = createSqliteD1([...migrations(), MIGRATIONS_DDL]);
  for (const n of REQUIRED_D1_MIGRATIONS) h.db.prepare('INSERT INTO d1_migrations (name) VALUES (?)').run(n);
  return h;
}

describe('a pass whose bundle is not the adopted epoch does not scan', () => {
  const chain = { id: BASE, rpc: 'https://rpc.invalid', diamond: bundle.diamond } as unknown as ChainConfig;

  it('a stale build is refused before any RPC request and writes no cursor', async () => {
    const h = migratedDb();
    // The chain already adopted a Diamond deployed AFTER this build's bundle.
    h.db
      .prepare('INSERT INTO indexer_deployment (chain_id, diamond, deploy_block, adopted_at, reset_pending) VALUES (?, ?, ?, ?, 0)')
      .run(BASE, LATER_DIAMOND, bundle.deployBlock + 1_000_000, 1_000);
    const fetchSpy = vi.fn(async () => {
      throw new Error('RPC reached by a pass that is not the adopted epoch');
    });
    const env = { DB: h.d1, fetchFn: fetchSpy } as unknown as Env;

    const r = await runChainIndexerForChain(env, chain);

    expect(r.skipped).toBe('epoch-not-adopted');
    expect(r.scannedTo).toBe(0n);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(h.db.prepare(`SELECT count(*) AS n FROM indexer_cursor WHERE chain_id = ?`).get(BASE)).toEqual({ n: 0 });
    // The adopted record is untouched: the later Diamond still holds the epoch.
    expect(await readAdoptedDeployment(h.d1 as never, BASE)).toMatchObject({
      diamond: LATER_DIAMOND,
      deployBlock: bundle.deployBlock + 1_000_000,
      resetPending: false,
    });
  });

  it('the ingest loop finishes, rather than rearming, on the declined pass', () => {
    expect(isEpochDeclinedSkip('epoch-not-adopted')).toBe(true);
    expect(isEpochDeclinedSkip('caught-up')).toBe(false);
    expect(
      alarmNextStep({
        schemaDeclined: isEpochDeclinedSkip('epoch-not-adopted'),
        retryableFailure: false,
        scannedTo: 0n,
        target: 500n,
        headBlock: undefined,
      }),
    ).toBe('finish');
  });
});
