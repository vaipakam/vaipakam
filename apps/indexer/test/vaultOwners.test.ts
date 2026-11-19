/**
 * #3388 — a `VaultOutflow` paid into a vault is filed under that vault's
 * owner. Run against the REAL migrations in SQLite: the migration's seed and
 * backfill, the ingest lookup and the pair writes are all SQL.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createSqliteD1 } from './helpers/sqliteD1';
import { recordActivityEvents } from '../src/chainIndexer';
import { loadVaultOwners, unresolvedRecipients, vaultOwnerStatements, vaultPairsOf, withRecipientOwner } from '../src/vaultOwners';

const MIGRATIONS_DIR = new URL('../migrations/', import.meta.url);
const files = () => readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
const sql = (f: string) => readFileSync(new URL(f, MIGRATIONS_DIR), 'utf8');
const VAULT_OWNERS = '0107_vault_owners.sql';

const CHAIN = 84532;
const A = '0x00000000000000000000000000000000000000aa'; // holder
const B = '0x00000000000000000000000000000000000000bb'; // payer
const VA = '0x0000000000000000000000000000000000000a0a';
const VB = '0x0000000000000000000000000000000000000b0b';
const LIQ = '0x00000000000000000000000000000000000000cc'; // a wallet recipient
// The chain hands checksummed addresses; the rule lower-cases.
const upper = (a: string) => a.replace(/[a-f]/g, (c) => c.toUpperCase()).replace('0X', '0x');

function outflow(to: string) {
  return { owner: upper(B), vault: upper(VB), asset: upper(LIQ), tokenId: '0', amount: '5', delivered: '5', to: upper(to), class_: 3, reason: 0, ref: '7' };
}

function insertEvent(h: ReturnType<typeof createSqliteD1>, block: number, kind: string, args: Record<string, unknown>) {
  h.db
    .prepare(
      `INSERT INTO activity_events (chain_id, block_number, log_index, tx_hash, kind, loan_id, actor, args_json, block_at)
       VALUES (?, ?, 0, ?, ?, NULL, NULL, ?, ?)`,
    )
    .run(CHAIN, block, `0x${block.toString(16)}`, kind, JSON.stringify(args), 1_000 + block);
}

describe('migration 0107', () => {
  it('seeds each vault’s owner and files stored payouts into a vault under its owner', () => {
    const h = createSqliteD1(files().filter((f) => f !== VAULT_OWNERS).map(sql));
    insertEvent(h, 1, 'UserVaultCreated', { user: upper(A), proxy: upper(VA) });
    insertEvent(h, 2, 'VaultOutflow', outflow(VA)); // into A's vault
    insertEvent(h, 3, 'VaultOutflow', outflow(LIQ)); // to a wallet
    insertEvent(h, 4, 'UserVaultCreated', 'not json' as never);
    h.db.exec(sql(VAULT_OWNERS));
    h.db.exec(sql(VAULT_OWNERS)); // idempotent

    expect(h.db.prepare('SELECT vault, owner FROM vault_owners ORDER BY vault').all()).toEqual([
      { vault: VA, owner: A },
      { vault: VB, owner: B },
    ]);
    const args = (block: number) =>
      JSON.parse((h.db.prepare('SELECT args_json FROM activity_events WHERE block_number = ?').get(block) as { args_json: string }).args_json);
    expect(args(2).recipientOwner).toBe(A);
    expect(args(3).recipientOwner).toBeUndefined();
    expect(h.db.prepare('SELECT block_number, wallet FROM activity_participants').all()).toEqual([{ block_number: 2, wallet: A }]);
  });
});

describe('vault owners at ingest', () => {
  const log = (eventName: string, args: Record<string, unknown>, n: number) => ({
    eventName,
    args,
    blockNumber: BigInt(100 + n),
    transactionHash: `0x${String(n).padStart(64, '0')}`,
    logIndex: n,
  });

  it('reads the pairs a batch states and leaves an owner’s own withdrawal alone', () => {
    const logs = [log('UserVaultCreated', { user: upper(A), proxy: upper(VA) }, 1), log('VaultOutflow', { ...outflow(B) }, 2)];
    expect([...vaultPairsOf(logs)]).toEqual([
      [VA, A],
      [VB, B],
    ]);
    expect(unresolvedRecipients(logs, vaultPairsOf(logs))).toEqual([]);
    expect(unresolvedRecipients([log('VaultOutflow', outflow(LIQ), 3)], new Map())).toEqual([LIQ]);
  });

  it('files a payout into a vault created in an EARLIER batch under its owner, and records new pairs', async () => {
    const h = createSqliteD1(files().map(sql));
    for (const s of vaultOwnerStatements(h.d1 as D1Database, CHAIN, new Map([[VA, A]]))) await s.run();

    const logs = [log('VaultOutflow', outflow(VA), 1), log('VaultOutflow', outflow(LIQ), 2)];
    const owners = await loadVaultOwners(h.d1 as D1Database, CHAIN, logs);
    expect(withRecipientOwner('VaultOutflow', outflow(VA), owners).recipientOwner).toBe(A);
    expect(withRecipientOwner('VaultOutflow', outflow(LIQ), owners).recipientOwner).toBeUndefined();

    await recordActivityEvents(logs as never, { DB: h.d1 } as never, CHAIN, new Map(logs.map((l) => [l.blockNumber, 1_700_000_000])));
    const stored = h.db.prepare('SELECT block_number, args_json FROM activity_events ORDER BY block_number').all() as {
      block_number: number;
      args_json: string;
    }[];
    expect(JSON.parse(stored[0].args_json).recipientOwner).toBe(A);
    expect(JSON.parse(stored[1].args_json).recipientOwner).toBeUndefined();
    const wallets = (block: number) =>
      (h.db.prepare('SELECT wallet FROM activity_participants WHERE block_number = ? ORDER BY wallet').all(block) as { wallet: string }[]).map(
        (r) => r.wallet,
      );
    expect(wallets(101)).toContain(A);
    expect(wallets(102)).not.toContain(A);
    // The batch's own (owner, vault) pair is recorded for later batches.
    expect(h.db.prepare('SELECT owner FROM vault_owners WHERE vault = ?').get(VB)).toEqual({ owner: B });
  });
});
