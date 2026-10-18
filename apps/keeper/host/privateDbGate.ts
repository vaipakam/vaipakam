/**
 * The keeper's PRIVATE database, checked before a machine tick runs (#2450).
 *
 * A Worker's deploy (`scripts/deploy-keeper.mjs`) applies the keeper-private
 * migrations, verifies them, and refuses to publish while the one-time cutover
 * is pending. A machine has no deploy step — pulling new code and restarting
 * IS the release — so each tick asks the same two questions itself, and
 * declines, by name, while either answer is no:
 *
 *   1. SCHEMA: does `KEEPER_DB` record every migration this build carries
 *      (`src/requiredKeeperMigrations.json`, pinned to `migrations/` by a
 *      test)? The machine never APPLIES them — one applier per database, and
 *      for this one it is the keeper's deploy (`pnpm --filter @vaipakam/keeper
 *      run migrate`).
 *   2. CUTOVER: the same verdict the deploy uses (`cutoverVerdict`, the same
 *      tables and fingerprint SQL, from `scripts/lib/keeper-cutover.mjs`), read
 *      over the D1 HTTP API instead of wrangler. While the shared copies still
 *      hold rows and the private database records no matching cutover, the
 *      keeper would otherwise start from empty private state — re-sending what
 *      its old log already recorded.
 *
 * Fail closed: anything unread declines. A pass is NEVER cached (#2497 r4,
 * r8): every tick runs the full check, digest included, so a legacy keeper
 * that writes an old copy after startup — even rewriting a row within the same
 * second — stops the machine on its next tick.
 */
import {
  CUTOVER_TABLES,
  cutoverVerdict,
  fingerprintFromReads,
  fingerprintSql,
  rowsSql,
  type FingerprintRead,
  type Marker,
} from '../scripts/lib/keeper-cutover.mjs';
import REQUIRED from '../src/requiredKeeperMigrations.json';

export type PrivateDbCheck = { ok: true } | { ok: false; line: string };

async function rows(db: D1Database, sql: string): Promise<Record<string, unknown>[] | null> {
  try {
    const r = await db.prepare(sql).all<Record<string, unknown>>();
    return Array.isArray(r.results) ? r.results : null;
  } catch {
    return null;
  }
}

async function sharedFingerprints(shared: D1Database): Promise<Record<string, FingerprintRead>> {
  const names = CUTOVER_TABLES.map(({ table }) => `'${table}'`).join(', ');
  const present = await rows(shared, `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${names})`);
  const out: Record<string, FingerprintRead> = {};
  for (const t of CUTOVER_TABLES) {
    if (present === null) out[t.table] = null;
    else if (!present.some((r) => r.name === t.table)) out[t.table] = 'absent';
    else out[t.table] = fingerprintFromReads(await rows(shared, fingerprintSql(t)), await rows(shared, rowsSql(t)));
  }
  return out;
}

async function marker(priv: D1Database): Promise<Marker> {
  const r = await rows(priv, 'SELECT completed_at, fingerprint FROM keeper_cutover WHERE id = 1');
  if (r === null) return null;
  if (r.length === 0) return 'none';
  try {
    return { completedAt: Number(r[0].completed_at), fingerprint: JSON.parse(String(r[0].fingerprint)) };
  } catch {
    return null;
  }
}

export async function checkPrivateDb(
  shared: D1Database,
  priv: D1Database,
  required: readonly string[] = REQUIRED,
): Promise<PrivateDbCheck> {
  const applied = await rows(priv, 'SELECT name FROM d1_migrations');
  if (applied === null) {
    return { ok: false, line: '[keeper-host] tick declined: could not read the keeper database\'s d1_migrations; retrying next tick' };
  }
  const have = new Set(applied.map((r) => String(r.name)));
  const missing = required.filter((m) => !have.has(m));
  if (missing.length > 0) {
    return {
      ok: false,
      line:
        `[keeper-host] tick declined: keeper-private migration(s) ${missing.join(', ')} not applied; ` +
        'apply them with `pnpm --filter @vaipakam/keeper run migrate` (the keeper deploy is their one applier)',
    };
  }
  const m = await marker(priv);
  const verdict = cutoverVerdict(await sharedFingerprints(shared), m);
  if (!verdict.ok) return { ok: false, line: `[keeper-host] tick declined: ${verdict.why}` };
  return { ok: true };
}

/**
 * The gate a host runs before every tick: the FULL check, every time (#2497
 * r8). An earlier version ran it once and then re-read only each old table's
 * count and latest write time, which a same-second rewrite of an existing row
 * slips past. No cheap substitute is needed: once the cutover is recorded, the
 * keeper writes only the private database, so the old shared copies are FROZEN
 * and the full check — digest included — reads a fixed amount, whatever the
 * keeper does next. Before the cutover it declines, so its cost is moot.
 */
export function createPrivateDbGate(required: readonly string[] = REQUIRED) {
  return {
    check: (shared: D1Database, priv: D1Database): Promise<PrivateDbCheck> => checkPrivateDb(shared, priv, required),
  };
}
