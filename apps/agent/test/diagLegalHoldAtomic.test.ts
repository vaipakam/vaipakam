/**
 * #1488 — a legal-hold action and its audit row commit together.
 *
 * Run against real SQLite carrying the shared migration that creates the
 * two tables, with a D1-shaped adapter whose `batch()` is one transaction,
 * as D1's is. The audit trail is then replayed by the restore's own
 * reconciliation (`reconcileLegalHolds`), which is the reader that treats an
 * impossible record as tampering and fails the nightly archive.
 */
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { buildLegalHoldMessage, handleDiagLegalHold } from '../src/diagErasure';
import { sha256Hex } from '../src/diagLegalDoc';
import type { Env } from '../src/env';
// The restore's replay is the oracle: it is what fails an archive on an impossible record.
import { reconcileLegalHolds } from '../../../ops/offchain-data-warm/scripts/restore-from-archive.mjs';

const MIGRATIONS = ['0003_diag_errors.sql', '0013_diag_erasure.sql'].map((f) =>
  readFileSync(new URL(`../../indexer/migrations/${f}`, import.meta.url), 'utf8'),
);
const CORS = 'https://app.vaipakam.com';
// Anvil's first two well-known dev keys — fine in a test, never a real key.
const ADMIN: PrivateKeyAccount = privateKeyToAccount(
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
);
const HELD: PrivateKeyAccount = privateKeyToAccount(
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
);
const isAdmin = async (_env: Env, a: string) => a.toLowerCase() === ADMIN.address.toLowerCase();

type SqlValue = number | string | null;

/** A D1-shaped adapter over node:sqlite. `beforeBatch` runs just before a
 *  batch opens its transaction — the last moment another request's write
 *  can land. */
function sqliteD1(beforeBatch?: (db: DatabaseSync) => void) {
  const db = new DatabaseSync(':memory:');
  for (const sql of MIGRATIONS) db.exec(sql);
  const stmt = (sql: string, args: SqlValue[] = []) => ({
    bind: (...a: SqlValue[]) => stmt(sql, a),
    first: async () => db.prepare(sql).get(...args) ?? null,
    run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...args).changes) } }),
    __exec: () => ({ meta: { changes: Number(db.prepare(sql).run(...args).changes) } }),
  });
  const d1 = {
    prepare: (sql: string) => stmt(sql),
    async batch(stmts: Array<{ __exec: () => unknown }>) {
      beforeBatch?.(db);
      db.exec('BEGIN');
      try {
        const out = stmts.map((s) => s.__exec());
        db.exec('COMMIT');
        return out;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
  };
  const env = {
    DB: d1,
    DIAG_WALLET_HMAC_KEY: 'unit-test-hmac-key',
    DIAG_LEGAL_DOCS: { put: async () => undefined },
    FRONTEND_ORIGIN: CORS,
  } as unknown as Env;
  const rows = (table: string) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
  const replay = () =>
    reconcileLegalHolds({
      d1: {
        archive: [
          { name: 'diag_legal_holds', rows: rows('diag_legal_holds') },
          { name: 'diag_legal_hold_audit', rows: rows('diag_legal_hold_audit') },
        ],
      },
    });
  return { db, env, rows, replay };
}

async function signed(req: {
  action: 'place' | 'lift' | 'set-disclosure';
  holdReason?: string;
  disclosureAllowed?: boolean;
  legalDocSha256?: string;
}) {
  const full = { ...req, wallet: HELD.address, issuedAt: Math.floor(Date.now() / 1000) };
  const signature = await ADMIN.signMessage({
    message: buildLegalHoldMessage({ ...full, signature: '0x' }),
  });
  return { ...full, signature };
}

async function place(env: Env): Promise<Response> {
  const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]);
  const form = new FormData();
  form.append(
    'payload',
    JSON.stringify(
      await signed({ action: 'place', holdReason: 'court order', legalDocSha256: await sha256Hex(pdf) }),
    ),
  );
  form.append('document', new Blob([pdf], { type: 'application/pdf' }), 'order.pdf');
  return handleDiagLegalHold(
    new Request('https://agent.test/diag/legal-hold', { method: 'POST', body: form }),
    env,
    CORS,
    isAdmin,
  );
}

async function act(env: Env, req: Parameters<typeof signed>[0]): Promise<Response> {
  return handleDiagLegalHold(
    new Request('https://agent.test/diag/legal-hold', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(await signed(req)),
    }),
    env,
    CORS,
    isAdmin,
  );
}

describe('a legal-hold action and its audit row are one transaction (#1488)', () => {
  afterEach(() => vi.useRealTimers());

  it('a lift landing just before a set-disclosure leaves no orphan audit row', async () => {
    let liftNext = false;
    const t = sqliteD1((db) => {
      if (!liftNext) return;
      liftNext = false;
      // Another admin's lift commits after this request's earlier reads
      // and before its own write.
      db.exec('DELETE FROM diag_legal_holds');
      db.prepare(
        `INSERT INTO diag_legal_hold_audit (at, action, wallet_hash, admin_wallet, detail)
         SELECT at, 'lift', wallet_hash, 'other-admin', '' FROM diag_legal_hold_audit LIMIT 1`,
      ).run();
    });
    expect((await place(t.env)).status).toBe(200);

    liftNext = true;
    const res = await act(t.env, { action: 'set-disclosure', disclosureAllowed: true });
    expect(res.status).toBe(404);
    expect(t.rows('diag_legal_hold_audit').map((r) => (r as { action: string }).action)).toEqual([
      'place',
      'lift',
    ]);
    expect(t.replay()).toEqual([]);
  });

  it('a set-disclosure with no hold answers 404 and writes nothing', async () => {
    const t = sqliteD1();
    const res = await act(t.env, { action: 'set-disclosure', disclosureAllowed: true });
    expect(res.status).toBe(404);
    expect(t.rows('diag_legal_hold_audit')).toEqual([]);
  });

  it('a hold change whose audit row cannot be written does not apply', async () => {
    const t = sqliteD1();
    t.db.exec(
      `CREATE TRIGGER refuse_audit BEFORE INSERT ON diag_legal_hold_audit
       BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END`,
    );
    await expect(place(t.env)).rejects.toThrow(/audit unavailable/);
    expect(t.rows('diag_legal_holds')).toEqual([]);
  });

  it('stamps the audit row with the database clock at the write, not the request arrival', async () => {
    // A request that waited (a slow document upload) must not be stamped
    // ahead of an action that committed before it: the replay orders by
    // `at`. Here the Worker's clock runs an hour behind the database's.
    const t = sqliteD1();
    const dbNow = () => Number((t.db.prepare('SELECT unixepoch() AS n').get() as { n: number }).n);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() - 3_600_000);
    expect((await place(t.env)).status).toBe(200);
    const [row] = t.rows('diag_legal_hold_audit') as Array<{ at: number }>;
    expect(Math.abs(row!.at - dbNow())).toBeLessThan(5);
  });

  it('a place, a disclosure and a lift replay to the archived state', async () => {
    const t = sqliteD1();
    expect((await place(t.env)).status).toBe(200);
    expect((await act(t.env, { action: 'set-disclosure', disclosureAllowed: true })).status).toBe(200);
    expect(t.replay()).toEqual([]);
    expect((await act(t.env, { action: 'lift' })).status).toBe(200);
    expect(t.rows('diag_legal_holds')).toEqual([]);
    expect(t.replay()).toEqual([]);
  });
});
