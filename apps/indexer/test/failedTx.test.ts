/**
 * The failed transaction record's one write route and its health read
 * (#3918). Acceptance test 5 of the troubleshooting design: the route accepts
 * a well-formed record, a cursor with its checkpoints and a replaced-range
 * statement under the pass's token, refuses every other write, and a
 * replaced-range statement deletes nothing.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { getDeployment } from '@vaipakam/contracts/deployments';
import { createSqliteD1 } from './helpers/sqliteD1';
import {
  MAX_EXPLANATION_BYTES,
  handleFailedTxHealth,
  handleFailedTxWrite,
  parseFailedTxWrite,
  writerAuthorized,
  type D1Write,
} from '../src/failedTx';

const DDL = [readFileSync(new URL('../migrations/0123_failed_transactions.sql', import.meta.url), 'utf8')];
const CHAIN = 84532;
const TOKEN = 'pass-token-0123456789';
const NOW = 1_800_000_000;

const h64 = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const addr = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;

function record(over: Record<string, unknown> = {}) {
  return {
    txHash: h64(1),
    blockHash: h64(100),
    blockNumber: 1000,
    blockTime: NOW - 60,
    txIndex: 3,
    sender: addr(0xabc),
    contract: addr(0xd1a),
    functionSelector: '0x8cb53733',
    functionName: 'repayLoan',
    loanId: '7',
    errorSelector: '0x12345678',
    errorName: 'SequencerDown',
    errorValues: {},
    foundBy: 'explorer-list',
    mode: 'list-and-audit',
    source: 'replay',
    explanation: { stop: { error: { name: 'SequencerDown' } } },
    unavailable: ['the call path', 'the events before the failure'],
    gasUsed: '45000',
    gasLimit: '100000',
    ...over,
  };
}

const readBody = async (req: Request, max: number) => {
  const text = await req.text();
  return text.length > max ? ({ ok: false, status: 413, error: 'too large' } as const) : ({ ok: true, text } as const);
};

function setup() {
  const h = createSqliteD1(DDL);
  const post = (body: unknown, token: string | null = TOKEN) =>
    handleFailedTxWrite(
      new Request('https://x/internal/failed-tx', {
        method: 'POST',
        headers: token ? { authorization: `Bearer ${token}` } : {},
        body: JSON.stringify(body),
      }),
      h.d1 as D1Write,
      TOKEN,
      readBody,
      () => NOW,
    );
  const rows = (sql: string) => h.db.prepare(sql).all() as Array<Record<string, unknown>>;
  return { ...h, post, rows };
}

describe('POST /internal/failed-tx', () => {
  it('refuses without the token, with a wrong one, and when no token is set', async () => {
    const s = setup();
    expect((await s.post({ kind: 'records', chainId: CHAIN, records: [record()] }, null)).status).toBe(401);
    expect((await s.post({ kind: 'records', chainId: CHAIN, records: [record()] }, 'wrong')).status).toBe(401);
    expect(await writerAuthorized(`Bearer ${TOKEN}`, undefined)).toBe(false);
    expect(await writerAuthorized(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(s.rows('SELECT * FROM failed_tx')).toEqual([]);
  });

  it('stores a well-formed record, stamping the Diamond from the deployment record', async () => {
    const s = setup();
    const res = await s.post({ kind: 'records', chainId: CHAIN, records: [record()] });
    expect(res.status).toBe(200);
    const [row] = s.rows('SELECT * FROM failed_tx');
    expect(row).toMatchObject({
      chain_id: CHAIN,
      tx_hash: h64(1),
      diamond: getDeployment(CHAIN)!.diamond.toLowerCase(),
      found_by: 'explorer-list',
      source: 'replay',
      loan_id: '7',
      error_name: 'SequencerDown',
      replaced_at: null,
      recorded_at: NOW,
    });
    expect(JSON.parse(row!.unavailable as string)).toEqual(['the call path', 'the events before the failure']);
  });

  it('a better source replaces a worse one, never the reverse', async () => {
    const s = setup();
    await s.post({ kind: 'records', chainId: CHAIN, records: [record()] });
    await s.post({ kind: 'records', chainId: CHAIN, records: [record({ source: 'rebuilt', unavailable: null, explanation: { full: true } })] });
    expect(s.rows('SELECT source, explanation FROM failed_tx')).toEqual([{ source: 'rebuilt', explanation: '{"full":true}' }]);
    await s.post({ kind: 'records', chainId: CHAIN, records: [record({ source: 'none', explanation: null, stateUnreachable: true })] });
    expect(s.rows('SELECT source FROM failed_tx')).toEqual([{ source: 'rebuilt' }]);
  });

  it('refuses every other shape', async () => {
    const s = setup();
    const bad: unknown[] = [
      { kind: 'delete', chainId: CHAIN },
      { kind: 'records', chainId: 999_999, records: [record()] },
      { kind: 'records', chainId: CHAIN, records: [] },
      { kind: 'records', chainId: CHAIN, records: [record({ txHash: '0x12' })] },
      { kind: 'records', chainId: CHAIN, records: [record({ diamond: addr(1) })] },
      { kind: 'records', chainId: CHAIN, records: [record({ source: 'none' })] },
      { kind: 'records', chainId: CHAIN, records: [record({ source: 'trace', explanation: null })] },
      { kind: 'records', chainId: CHAIN, records: [record({ stateUnreachable: true })] },
      { kind: 'records', chainId: CHAIN, records: [record({ explanation: { big: 'x'.repeat(MAX_EXPLANATION_BYTES) } })] },
      { kind: 'records', chainId: CHAIN, records: [record({ functionName: 'drop table' })] },
      { kind: 'records', chainId: CHAIN, records: [record()], extra: 1 },
      { kind: 'cursor', chainId: CHAIN, cursor: { mode: 'sends-and-audit', blockNumber: 1, blockTime: 1 } },
      { kind: 'cursor', chainId: CHAIN, cursor: { mode: 'trace-filter', blockNumber: 1, blockTime: 1, watchedShareBps: 5000 } },
      { kind: 'cursor', chainId: CHAIN, cursor: { mode: 'trace-filter', blockNumber: 1, blockTime: 1, audits: [{ fromBlock: 1, toBlock: 2, found: 1, missed: 2 }] } },
      { kind: 'replaced', chainId: CHAIN, fromBlock: 10, toBlock: 5 },
      { kind: 'sql', chainId: CHAIN, sql: 'DELETE FROM loans' },
    ];
    for (const body of bad) {
      const res = await s.post(body);
      expect(res.status, JSON.stringify(body).slice(0, 120)).toBe(400);
    }
    expect(s.rows('SELECT * FROM failed_tx')).toEqual([]);
    expect(s.rows('SELECT * FROM failed_tx_range')).toEqual([]);
  });

  it('accepts a cursor with its checkpoints, gaps and audit windows', async () => {
    const s = setup();
    const res = await s.post({
      kind: 'cursor',
      chainId: CHAIN,
      cursor: {
        mode: 'list-and-audit',
        blockNumber: 2000,
        blockTime: NOW - 30,
        checkpoints: [{ blockNumber: 1500, blockHash: h64(15) }, { blockNumber: 2000, blockHash: h64(20) }],
        gaps: [{ fromBlock: 1600, toBlock: 1650, reason: 'the node refused the range' }],
        audits: [{ fromBlock: 1700, toBlock: 1800, found: 4, missed: 1 }],
      },
    });
    expect(res.status).toBe(200);
    expect(s.rows('SELECT chain_id, mode, block_number FROM failed_tx_cursor')).toEqual([{ chain_id: CHAIN, mode: 'list-and-audit', block_number: 2000 }]);
    expect(s.rows("SELECT kind, from_block FROM failed_tx_range ORDER BY kind, from_block")).toEqual([
      { kind: 'audit', from_block: 1700 },
      { kind: 'checkpoint', from_block: 1500 },
      { kind: 'checkpoint', from_block: 2000 },
      { kind: 'gap', from_block: 1600 },
    ]);
  });

  it('a replaced-range statement marks records and checkpoints and deletes nothing', async () => {
    const s = setup();
    await s.post({ kind: 'records', chainId: CHAIN, records: [record(), record({ txHash: h64(2), blockNumber: 3000, blockHash: h64(300) })] });
    await s.post({
      kind: 'cursor',
      chainId: CHAIN,
      cursor: { mode: 'list-and-audit', blockNumber: 3000, blockTime: NOW, checkpoints: [{ blockNumber: 900, blockHash: h64(9) }, { blockNumber: 1000, blockHash: h64(100) }] },
    });
    const res = await s.post({ kind: 'replaced', chainId: CHAIN, fromBlock: 950, toBlock: 1100 });
    expect(res.status).toBe(200);
    expect(s.rows('SELECT tx_hash, replaced_at FROM failed_tx ORDER BY block_number')).toEqual([
      { tx_hash: h64(1), replaced_at: NOW },
      { tx_hash: h64(2), replaced_at: null },
    ]);
    expect(s.rows("SELECT from_block, replaced_at FROM failed_tx_range WHERE kind = 'checkpoint' ORDER BY from_block")).toEqual([
      { from_block: 900, replaced_at: null },
      { from_block: 1000, replaced_at: NOW },
    ]);
    expect(s.rows("SELECT marked FROM failed_tx_range WHERE kind = 'replaced'")).toEqual([{ marked: 1 }]);
    // A later record never clears the mark.
    await s.post({ kind: 'records', chainId: CHAIN, records: [record({ source: 'trace', unavailable: null })] });
    expect(s.rows(`SELECT replaced_at FROM failed_tx WHERE tx_hash = '${h64(1)}'`)).toEqual([{ replaced_at: NOW }]);
  });
});

describe('GET /health/failed-tx', () => {
  it('states the mode, cursor age, newest live checkpoint, last replacement, gaps and miss rate', async () => {
    const s = setup();
    await s.post({ kind: 'records', chainId: CHAIN, records: [record()] });
    await s.post({
      kind: 'cursor',
      chainId: CHAIN,
      cursor: {
        mode: 'sends-and-audit',
        blockNumber: 2000,
        blockTime: NOW - 90,
        watchedShareBps: 2500,
        checkpoints: [{ blockNumber: 1900, blockHash: h64(19) }, { blockNumber: 2000, blockHash: h64(20) }],
        gaps: [{ fromBlock: 10, toBlock: 20, reason: 'node unreachable' }],
        audits: [
          { fromBlock: 100, toBlock: 200, found: 3, missed: 1 },
          { fromBlock: 300, toBlock: 400, found: 1, missed: 0 },
        ],
      },
    });
    await s.post({ kind: 'replaced', chainId: CHAIN, fromBlock: 2000, toBlock: 2000 });
    const res = await handleFailedTxHealth(s.d1 as D1Write, () => NOW);
    const body = (await res.json()) as { chains: Array<Record<string, unknown>> };
    expect(body.chains).toEqual([
      {
        chainId: CHAIN,
        mode: 'sends-and-audit',
        cursor: { blockNumber: 2000, blockTime: NOW - 90, ageSeconds: 90, updatedAt: NOW },
        watchedShareBps: 2500,
        newestCheckpoint: { blockNumber: 1900, blockHash: h64(19) },
        lastReplacement: { fromBlock: 2000, toBlock: 2000, foundAt: NOW, marked: 0 },
        gaps: { count: 1, latest: { fromBlock: 10, toBlock: 20, reason: 'node unreachable' } },
        audit: { windows: 2, found: 4, missed: 1, missRateBps: 2500 },
        recordsLast24h: 1,
      },
    ]);
  });

  it('answers 503 before the migration', async () => {
    const h = createSqliteD1([]);
    expect((await handleFailedTxHealth(h.d1 as D1Write, () => NOW)).status).toBe(503);
  });
});

describe('parseFailedTxWrite', () => {
  it('lowercases hashes and addresses', () => {
    const p = parseFailedTxWrite({ kind: 'records', chainId: CHAIN, records: [record({ sender: addr(0xabc).toUpperCase().replace('0X', '0x') })] });
    expect(p.ok && p.value.kind === 'records' && p.value.records[0]!.sender).toBe(addr(0xabc));
  });
});
