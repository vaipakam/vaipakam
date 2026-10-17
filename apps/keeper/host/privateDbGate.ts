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
 * Fail closed: anything unread declines. A pass is NOT cached blindly (#2497
 * r4): while the old shared copies exist, every later tick re-reads their
 * count and latest write time and compares them with the marker the full check
 * validated — any keeper write to an old copy stamps "now", so a legacy keeper
 * restarted or a rollback after startup is caught on its next tick, and the
 * full check (digest included) then runs again.
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
/** What a passing full check validated against, kept for the cheap re-check. */
type Basis = Marker;

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
  const r = await checkPrivateDbWithBasis(shared, priv, required);
  return r.ok ? { ok: true } : r;
}

async function checkPrivateDbWithBasis(
  shared: D1Database,
  priv: D1Database,
  required: readonly string[],
): Promise<{ ok: true; basis: Basis } | { ok: false; line: string }> {
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
  return { ok: true, basis: m };
}

/**
 * The cheap per-tick re-check against what the full check validated: each old
 * shared table's count and latest write time must still match the marker (or,
 * with no marker, the table must still hold no rows). Null when it still holds;
 * otherwise the decline line. Anything unread declines.
 */
async function sharedMovedSince(shared: D1Database, basis: Basis): Promise<string | null> {
  const names = CUTOVER_TABLES.map(({ table }) => `'${table}'`).join(', ');
  const present = await rows(shared, `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${names})`);
  if (present === null) return '[keeper-host] tick declined: could not re-read the shared tables the cutover moved; retrying next tick';
  for (const t of CUTOVER_TABLES) {
    if (!present.some((r) => r.name === t.table)) continue; // retired: nothing can write it
    const fp = await rows(shared, fingerprintSql(t));
    const n = Number(fp?.[0]?.n);
    const at = Number(fp?.[0]?.at);
    if (fp === null || !Number.isSafeInteger(n) || !Number.isSafeInteger(at)) {
      return `[keeper-host] tick declined: could not re-read ${t.table} in the shared database; retrying next tick`;
    }
    const want = basis && basis !== 'none' ? basis.fingerprint?.[t.table] : { n: 0, at: 0 };
    if (!want || want.n !== n || (n > 0 && want.at !== at)) {
      return (
        `[keeper-host] tick declined: ${t.table} in the shared database changed since this process checked the cutover ` +
        `(now n=${n} at=${at}) — a keeper wrote the old copy. Stop it, then re-run the cutover.`
      );
    }
  }
  return null;
}

/** The full check once; then, per tick, the cheap re-check against what it
 *  validated. A re-check that fails drops the basis, so the next tick runs the
 *  full check (digest included) again. */
export function createPrivateDbGate(required: readonly string[] = REQUIRED) {
  let basis: Basis | undefined;
  return {
    async check(shared: D1Database, priv: D1Database): Promise<PrivateDbCheck> {
      if (basis !== undefined) {
        const moved = await sharedMovedSince(shared, basis);
        if (moved === null) return { ok: true };
        basis = undefined;
        return { ok: false, line: moved };
      }
      const r = await checkPrivateDbWithBasis(shared, priv, required);
      if (!r.ok) return r;
      basis = r.basis;
      return { ok: true };
    },
  };
}
