/**
 * One use per signed alert request (#2753), against real SQLite running
 * the shared migration itself, so the claim's ON CONFLICT … RETURNING
 * behaves as D1's SQLite does rather than as a fake says it would.
 */
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import type { Env } from '../src/env';
import type { ChainSigChecker } from '../src/walletSigVerify';
import {
  LINK_SIGNATURE_MAX_AGE_SECONDS,
  authoriseAlertRequest,
  buildTelegramLinkMessage,
  parseSignedLinkRequest,
} from '../src/linkAuth';
import { SignedRequestLedgerUnavailableError, claimSignedRequest } from '../src/signedRequestUse';

const MIGRATION = readFileSync(
  new URL('../../indexer/migrations/0076_signed_request_use.sql', import.meta.url),
  'utf8',
);

/** The slice of D1 the ledger uses — prepare / bind / batch — over an
 *  in-memory SQLite database. A batch runs in one transaction, as D1's does. */
function sqliteD1(migrated = true) {
  const db = new DatabaseSync(':memory:');
  if (migrated) db.exec(MIGRATION);
  const prepare = (sql: string) => {
    let args: unknown[] = [];
    const stmt = {
      bind(...a: unknown[]) {
        args = a;
        return stmt;
      },
      all() {
        return { results: db.prepare(sql).all(...(args as never[])) };
      },
    };
    return stmt;
  };
  const d1 = {
    prepare,
    async batch(stmts: Array<ReturnType<typeof prepare>>) {
      db.exec('BEGIN');
      try {
        const out = stmts.map((s) => s.all());
        db.exec('COMMIT');
        return out;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
  };
  const rows = () =>
    db.prepare('SELECT message_sha256, expires_at FROM signed_request_use').all() as Array<{
      message_sha256: string;
      expires_at: number;
    }>;
  return { d1: d1 as unknown as D1Database, rows };
}

const NOW = 1_800_000_000;

describe('claimSignedRequest', () => {
  it('accepts a message once and refuses its repeat', async () => {
    const { d1, rows } = sqliteD1();
    expect(await claimSignedRequest(d1, 'message A', NOW + 600, NOW)).toBe(true);
    expect(await claimSignedRequest(d1, 'message A', NOW + 600, NOW)).toBe(false);
    expect(await claimSignedRequest(d1, 'message B', NOW + 600, NOW)).toBe(true);
    // The row is the digest and the expiry, nothing of the message.
    expect(rows().map((r) => r.message_sha256)).toHaveLength(2);
    for (const r of rows()) {
      expect(r.message_sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(r.expires_at).toBe(NOW + 600 + 60);
    }
  });

  it('keeps a row until its request is no longer presentable, then drops it', async () => {
    const { d1, rows } = sqliteD1();
    await claimSignedRequest(d1, 'message A', NOW + 600, NOW);
    // Still inside the window: the repeat is refused and the row stays.
    expect(await claimSignedRequest(d1, 'message A', NOW + 600, NOW + 660)).toBe(false);
    expect(rows()).toHaveLength(1);
    // Past it, the next claim of anything clears the row.
    await claimSignedRequest(d1, 'message B', NOW + 1300, NOW + 661);
    expect(rows()).toHaveLength(1);
  });

  it('names a schema without the ledger instead of accepting unrecorded', async () => {
    const { d1 } = sqliteD1(false);
    await expect(claimSignedRequest(d1, 'message A', NOW + 600, NOW)).rejects.toBeInstanceOf(
      SignedRequestLedgerUnavailableError,
    );
  });
});

describe('authoriseAlertRequest', () => {
  // Anvil's first well-known dev key — fine in a test, never a real key.
  const ACCOUNT = privateKeyToAccount(
    '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  );
  const OTHER = privateKeyToAccount(
    '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  );
  const CHAIN_ID = 84532;
  const DENY: ChainSigChecker = async () => false;
  const httpReq = new Request('https://agent.test/link/telegram', { method: 'POST' });

  async function linkRequest(signer = ACCOUNT) {
    const signature = await signer.signMessage({
      message: buildTelegramLinkMessage(ACCOUNT.address, CHAIN_ID, NOW),
    });
    const parsed = parseSignedLinkRequest({
      wallet: ACCOUNT.address,
      chain_id: CHAIN_ID,
      issuedAt: NOW,
      signature,
    });
    if (!parsed.ok) throw new Error('parse failed');
    return parsed.req;
  }

  it('accepts a signed request once; the same request again is 409', async () => {
    const { d1, rows } = sqliteD1();
    const env = { DB: d1 } as Env;
    const req = await linkRequest();
    expect((await authoriseAlertRequest(httpReq, env, req, 'link', NOW, DENY)).ok).toBe(true);
    const again = await authoriseAlertRequest(httpReq, env, req, 'link', NOW + 5, DENY);
    expect(again).toMatchObject({ ok: false, status: 409 });
    expect(rows()).toHaveLength(1);
    expect(rows()[0]!.expires_at).toBe(NOW + LINK_SIGNATURE_MAX_AGE_SECONDS + 60);
  });

  it('never records a request whose signature fails', async () => {
    const { d1, rows } = sqliteD1();
    const env = { DB: d1, RPC_BASE_SEPOLIA: 'http://rpc.test' } as unknown as Env;
    const forged = await linkRequest(OTHER);
    expect((await authoriseAlertRequest(httpReq, env, forged, 'link', NOW, DENY)).ok).toBe(false);
    expect(rows()).toHaveLength(0);
    // …so the owner's real request for the same moment is still accepted.
    expect((await authoriseAlertRequest(httpReq, env, await linkRequest(), 'link', NOW, DENY)).ok).toBe(
      true,
    );
  });

  it('is 503, not an acceptance, while the ledger migration is pending', async () => {
    const { d1 } = sqliteD1(false);
    const v = await authoriseAlertRequest(httpReq, { DB: d1 } as Env, await linkRequest(), 'link', NOW, DENY);
    expect(v).toMatchObject({ ok: false, status: 503 });
  });
});
