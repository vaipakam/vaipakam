/**
 * The failed transaction pass against a model chain and the indexer's REAL
 * route (#3919): every body the pass writes goes through
 * apps/indexer/src/failedTx.ts and its migration, so a drift between the two
 * sides fails here.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { encodeErrorResult, encodeFunctionData, getContractAddress, keccak256, parseAbi, toHex } from 'viem';
import { getDeployment } from '@vaipakam/contracts/deployments';
import { DIAMOND_ABI_VIEM } from '@vaipakam/contracts';
import { codeNamesFromDeployment } from '@vaipakam/lib/txExplainer';
import { createSqliteD1 } from '../../indexer/test/helpers/sqliteD1';
import { handleFailedTxState, handleFailedTxWrite, type D1Write } from '../../indexer/src/failedTx';
import { planFor, watchedAddresses, type CapabilityResult } from '../src/chains';
import { boundErrorValues, boundExplanation, CUT_MARK, fitRecord, MAX_EXPLANATION_BYTES } from '../src/record';
import { MAX_ERROR_VALUES_BYTES, jsonBytes } from '@vaipakam/lib/failedTxBounds';
import { ALERT_MESSAGE_CHARS, alertBatches, defaultSettings, runChain, type RunContext } from '../src/pass';
import { RpcFailure, hex, type Rpc } from '../src/rpc';
import { ExplorerFailure, type Explorer } from '../src/explorer';
import { IndexerFailure, type IndexerClient } from '../src/indexer';

const DDL = ['0123_failed_transactions.sql', '0124_failed_tx_pass_state.sql'].map((f) =>
  readFileSync(new URL(`../../indexer/migrations/${f}`, import.meta.url), 'utf8'),
);
const TOKEN = 'pass-token-test';
const BASE = Date.UTC(2026, 10, 20) / 1000; // a UTC midnight

// ─── The indexer, through its real handlers ──────────────────────────────

function realIndexer(): IndexerClient & { rows: (sql: string) => Array<Record<string, unknown>> } {
  const h = createSqliteD1(DDL);
  const auth = { authorization: `Bearer ${TOKEN}` };
  const readBody = async (req: Request) => ({ ok: true as const, text: await req.text() });
  return {
    async state(chainId, diamond, span) {
      const q = new URLSearchParams({ chainId: String(chainId), diamond });
      if (span) {
        q.set('from', String(span.from));
        q.set('to', String(span.to));
      }
      const res = await handleFailedTxState(new Request(`https://x/internal/failed-tx/state?${q}`, { headers: auth }), h.d1 as never, TOKEN);
      if (res.status !== 200) throw new IndexerFailure(res.status, `state ${res.status}: ${await res.text()}`);
      return res.json() as never;
    },
    async write(body) {
      const res = await handleFailedTxWrite(
        new Request('https://x/internal/failed-tx', { method: 'POST', headers: auth, body: JSON.stringify(body) }),
        h.d1 as D1Write,
        TOKEN,
        readBody,
        () => Math.floor(Date.now() / 1000),
      );
      if (res.status !== 200) throw new IndexerFailure(res.status, `write ${res.status}: ${await res.text()}`);
    },
    rows: (sql) => h.db.prepare(sql).all() as Array<Record<string, unknown>>,
  };
}

// ─── A model chain ───────────────────────────────────────────────────────

interface ModelTx {
  hash: string;
  block: number;
  to: string;
  input: string;
  status: 0 | 1;
  revert?: string;
  trace?: 'ok' | 'refused' | 'gone' | 'wait';
  call?: 'revert' | 'ok' | 'gone';
  /** A contract creation whose constructor called `to` (the watched contract the trace filter matches). */
  creation?: boolean;
}

function modelChain(deployBlock: number, head: number) {
  let epoch = 0;
  const replacedFrom = { n: Infinity };
  const txs: ModelTx[] = [];
  const failNext = { method: '' };
  let flapping = false;
  const hashOf = (n: number) => keccak256(toHex(`${n}:${n >= replacedFrom.n ? epoch : 0}`));
  const blockObj = (n: number) => ({ number: hex(n), hash: hashOf(n), timestamp: hex(BASE + (n - deployBlock)) });
  const find = (h: string) => txs.find((t) => t.hash === h);
  let reads = 0;
  const rpc: Rpc = {
    async call<T>(method: string, params: unknown[]): Promise<T> {
      if (failNext.method === method) throw new RpcFailure('transient', null, `${method}: HTTP 503`);
      switch (method) {
        case 'eth_getBlockByNumber': {
          const p = params[0] as string;
          const n = p === 'safe' ? head : Number.parseInt(p, 16);
          if (n > head) return null as T;
          const b = blockObj(n);
          if (flapping && p !== 'safe') b.hash = keccak256(toHex(`flap:${n}:${reads++}`));
          return b as T;
        }
        case 'eth_getTransactionByHash': {
          const t = find(params[0] as string);
          return (t ? { hash: t.hash, from: '0x' + 'a'.repeat(40), to: t.creation ? null : t.to, input: t.input, value: '0x0', gas: '0x30d40', blockNumber: hex(t.block), transactionIndex: '0x0', nonce: '0x5' } : null) as T;
        }
        case 'eth_getTransactionReceipt': {
          const t = find(params[0] as string);
          return (t ? { status: hex(t.status), blockHash: hashOf(t.block), blockNumber: hex(t.block), transactionIndex: '0x0', gasUsed: '0x5208', logs: [] } : null) as T;
        }
        case 'debug_traceTransaction': {
          const t = find(params[0] as string)!;
          if (t.trace === 'wait') throw new RpcFailure('transient', null, 'debug_traceTransaction: HTTP 503');
          if (t.trace === 'refused') throw new RpcFailure('refused', -32601, 'debug_traceTransaction: the method does not exist');
          if (t.trace === 'gone') throw new RpcFailure('refused', -32000, 'debug_traceTransaction: missing trie node abc');
          return { type: 'CALL', from: '0x' + 'a'.repeat(40), to: t.to, input: t.input, output: t.revert ?? '0x', gas: '0x30d40', gasUsed: '0x5208', error: 'execution reverted' } as T;
        }
        case 'eth_call': {
          const t = txs.find((x) => x.input === (params[0] as { data: string }).data)!;
          if (t.call === 'ok') return '0x' as T;
          if (t.call === 'gone') throw new RpcFailure('refused', -32000, 'eth_call: missing trie node abc');
          throw new RpcFailure('refused', 3, 'eth_call: execution reverted', t.revert);
        }
        case 'trace_filter': {
          const f = params[0] as { fromBlock: string; toBlock: string; toAddress: string[] };
          const a = Number.parseInt(f.fromBlock, 16);
          const b = Number.parseInt(f.toBlock, 16);
          return txs
            .filter((t) => t.block >= a && t.block <= b && f.toAddress.includes(t.to.toLowerCase()))
            .map((t) => ({ transactionHash: t.hash, blockNumber: t.block, error: 'Reverted' })) as T;
        }
        case 'eth_getBlockReceipts': {
          const n = Number.parseInt(params[0] as string, 16);
          return txs.filter((t) => t.block === n).map((t) => ({ transactionHash: t.hash, to: t.to, status: hex(t.status) })) as T;
        }
        default:
          throw new RpcFailure('refused', -32601, `${method}: the method does not exist`);
      }
    },
  };
  return {
    rpc,
    txs,
    failNext,
    setHead: (n: number) => {
      head = n;
    },
    replaceFrom: (n: number) => {
      replacedFrom.n = n;
      epoch++;
    },
    flap: (on: boolean) => {
      flapping = on;
    },
    hashOf,
  };
}

function listedExplorer(chain: ReturnType<typeof modelChain>, skip = new Set<string>()): Explorer & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async failedSentTo(address, from, to) {
      calls.push(`${address}:${from}-${to}`);
      return chain.txs
        .filter((t) => t.status === 0 && t.to.toLowerCase() === address && t.block >= from && t.block <= to && !skip.has(t.hash))
        .map((t) => ({ hash: t.hash, blockNumber: t.block }));
    },
  };
}

// ─── Fixtures ────────────────────────────────────────────────────────────

const BASE_SEPOLIA = 84532;
const dep = getDeployment(BASE_SEPOLIA) as unknown as Record<string, unknown> & { diamond: string; deployBlock: number };
const DIAMOND = dep.diamond.toLowerCase();
const DEPLOY = dep.deployBlock;
const cap = (mode: CapabilityResult['failedTransactionMode'], chainId = BASE_SEPOLIA, range: number | null = null): CapabilityResult => ({
  chainId,
  network: 'model',
  blockTimeSeconds: 1,
  failedTransactionMode: mode,
  capabilities: { traceFilter: { answered: range !== null, largestRange: range } },
});
const REVERT = encodeErrorResult({ abi: parseAbi(['error ERC721NonexistentToken(uint256 tokenId)']), errorName: 'ERC721NonexistentToken', args: [999999n] });
const repay = (id: bigint) => encodeFunctionData({ abi: DIAMOND_ABI_VIEM as never, functionName: 'repayLoan', args: [id] } as never);
const txHash = (n: number) => keccak256(toHex(`tx${n}`));

function context(chain: ReturnType<typeof modelChain>, indexer: IndexerClient, mode: CapabilityResult['failedTransactionMode'], now: number, explorer?: Explorer): RunContext {
  const plan = planFor(cap(mode, BASE_SEPOLIA, mode === 'trace-filter' ? 5000 : null), explorer !== undefined);
  return {
    plan,
    rpc: chain.rpc,
    ...(explorer ? { explorer } : {}),
    indexer,
    nameOf: codeNamesFromDeployment(dep as never),
    // One run reaches the head here; the catch-up bound has its own test.
    settings: { ...defaultSettings(plan), maxBlocksPerRun: 10_000_000, maxTraceRequestsPerRun: 1_000 },
    now: () => now,
    random: () => 0,
  };
}

const HEAD = DEPLOY + Math.floor(2.5 * 86_400);
/** A first run that looks back far enough for the lists to cover yesterday's audit window. */
const wide = (c: RunContext): RunContext => ({ ...c, settings: { ...c.settings, firstRunLookbackSeconds: 2 * 86_400 } });
const NOW = BASE + (HEAD - DEPLOY) + 60;

// ─── Tests ───────────────────────────────────────────────────────────────

describe('the failed transaction pass', () => {
  it('holds a network whose indexer runs another deployment record, with an alert, and writes nothing', async () => {
    const chain = modelChain(DEPLOY, HEAD);
    chain.txs.push({ hash: txHash(1), block: HEAD - 100, to: DIAMOND, input: repay(7n), status: 0, revert: REVERT, trace: 'ok' });
    const ix = realIndexer();
    const ctx = context(chain, ix, 'explorer-and-audit', NOW, listedExplorer(chain));
    const r = await runChain({ ...ctx, plan: { ...ctx.plan, diamond: '0x' + 'ba'.repeat(20) } });
    expect(r.held).toMatch(/another deployment record/);
    expect(r.findings.map((f) => f.key)).toContain('deployment-mismatch');
    expect(ix.rows('SELECT COUNT(*) AS n FROM failed_tx')).toEqual([{ n: 0 }]);
    expect(ix.rows('SELECT COUNT(*) AS n FROM failed_tx_cursor')).toEqual([{ n: 0 }]);
  });

  it('records a failure the explorer lists, decoded from the node trace, with its loan id and error', async () => {
    const chain = modelChain(DEPLOY, HEAD);
    chain.txs.push({ hash: txHash(1), block: HEAD - 100, to: DIAMOND, input: repay(7n), status: 0, revert: REVERT, trace: 'ok' });
    const ix = realIndexer();
    const r = await runChain(context(chain, ix, 'explorer-and-audit', NOW, listedExplorer(chain)));
    expect(r.held).toBeUndefined();
    expect(r.records).toBe(1);
    const [row] = ix.rows('SELECT * FROM failed_tx');
    expect(row).toMatchObject({
      tx_hash: txHash(1),
      found_by: 'explorer-list',
      mode: 'list-and-audit',
      source: 'trace',
      function_name: 'repayLoan',
      loan_id: '7',
      error_name: 'ERC721NonexistentToken',
      diamond: DIAMOND,
      state_unreachable: 0,
    });
    expect(JSON.parse(String(row!.error_values))).toEqual({ tokenId: '999999' });
    const [cursor] = ix.rows('SELECT mode, block_number, slow_block_number, audit_day FROM failed_tx_cursor');
    expect(cursor).toEqual({ mode: 'list-and-audit', block_number: HEAD, slow_block_number: HEAD, audit_day: '2026-11-21' });
    expect(ix.rows("SELECT from_block, block_hash FROM failed_tx_range WHERE kind = 'checkpoint'")).toEqual([{ from_block: HEAD, block_hash: chain.hashOf(HEAD) }]);
  });

  it('falls back to a replay at the parent block, and to none when the state is gone', async () => {
    const chain = modelChain(DEPLOY, HEAD);
    chain.txs.push({ hash: txHash(2), block: HEAD - 50, to: DIAMOND, input: repay(8n), status: 0, revert: REVERT, trace: 'refused', call: 'revert' });
    chain.txs.push({ hash: txHash(3), block: HEAD - 40, to: DIAMOND, input: repay(9n), status: 0, trace: 'gone', call: 'gone' });
    chain.txs.push({ hash: txHash(4), block: HEAD - 30, to: DIAMOND, input: repay(10n), status: 0, trace: 'refused', call: 'ok' });
    const ix = realIndexer();
    const r = await runChain(context(chain, ix, 'explorer-and-audit', NOW, listedExplorer(chain)));
    const rows = ix.rows('SELECT tx_hash, source, error_name, unavailable, not_reproduced, state_unreachable FROM failed_tx ORDER BY block_number');
    expect(rows.map((x) => [x.source, x.error_name, x.not_reproduced, x.state_unreachable])).toEqual([
      ['replay', 'ERC721NonexistentToken', 0, 0],
      ['none', null, 0, 1],
      ['replay', null, 1, 0],
    ]);
    expect(JSON.parse(String(rows[1]!.unavailable))).toContain('the error and its values');
    expect(r.findings.some((f) => f.level === 'alert' && f.key === `unreachable-${txHash(3)}`)).toBe(true);
  });

  it('holds on a node that does not answer, without moving past the transaction or downgrading it', async () => {
    const chain = modelChain(DEPLOY, HEAD);
    chain.txs.push({ hash: txHash(5), block: HEAD - 20, to: DIAMOND, input: repay(11n), status: 0, trace: 'wait', call: 'gone' });
    const ix = realIndexer();
    const r = await runChain(context(chain, ix, 'explorer-and-audit', NOW, listedExplorer(chain)));
    expect(r.held).toMatch(/did not answer while decoding/);
    expect(ix.rows('SELECT * FROM failed_tx')).toEqual([]);
    expect(ix.rows('SELECT block_number FROM failed_tx_cursor')).toEqual([{ block_number: HEAD - 21 }]);
    // Next run, the node answers: a trace, not a downgrade.
    chain.txs[0]!.trace = 'ok';
    await runChain(context(chain, ix, 'explorer-and-audit', NOW, listedExplorer(chain)));
    expect(ix.rows('SELECT source FROM failed_tx')).toEqual([{ source: 'trace' }]);
  });

  it('marks records in a replaced block range, keeps them, and scans the range again', async () => {
    const chain = modelChain(DEPLOY, HEAD);
    chain.txs.push({ hash: txHash(6), block: HEAD - 10, to: DIAMOND, input: repay(12n), status: 0, revert: REVERT, trace: 'ok' });
    const ix = realIndexer();
    const ctx = () => context(chain, ix, 'explorer-and-audit', NOW, listedExplorer(chain));
    await runChain(ctx());
    // A second checkpoint, then the chain replaces everything above HEAD - 5.
    chain.setHead(HEAD + 100);
    await runChain(ctx());
    chain.replaceFrom(HEAD + 1);
    chain.txs.push({ hash: txHash(7), block: HEAD + 50, to: DIAMOND, input: repay(13n), status: 0, revert: REVERT, trace: 'ok' });
    const r = await runChain(ctx());
    expect(r.findings.some((f) => f.key === 'replaced')).toBe(true);
    const replaced = ix.rows("SELECT from_block, to_block FROM failed_tx_range WHERE kind = 'replaced'");
    expect(replaced).toEqual([{ from_block: HEAD + 1, to_block: HEAD + 100 }]);
    expect(ix.rows("SELECT replaced_at IS NOT NULL AS marked FROM failed_tx_range WHERE kind = 'checkpoint' AND from_block = " + (HEAD + 100))).toEqual([{ marked: 0 }]);
    expect(ix.rows('SELECT tx_hash FROM failed_tx ORDER BY block_number').map((x) => x.tx_hash)).toEqual([txHash(6), txHash(7)]);
  });

  it('rescans a replaced range even when the run that marked it stopped before its cursor write', async () => {
    const chain = modelChain(DEPLOY, HEAD);
    const ix = realIndexer();
    const ctx = () => context(chain, ix, 'explorer-and-audit', NOW, listedExplorer(chain));
    await runChain(ctx());
    chain.setHead(HEAD + 100);
    await runChain(ctx());
    chain.replaceFrom(HEAD + 1);
    chain.txs.push({ hash: txHash(22), block: HEAD + 50, to: DIAMOND, input: repay(22n), status: 0, revert: REVERT, trace: 'ok' });
    // The run marks the replacement, then the node stops answering before the cursor write.
    const stopping = ctx();
    const inner = stopping.indexer;
    stopping.indexer = {
      state: inner.state.bind(inner),
      write: async (body) => {
        if ((body as { kind?: string }).kind === 'cursor') throw new RpcFailure('transient', null, 'stopped');
        return inner.write(body);
      },
    };
    const r1 = await runChain(stopping);
    expect(r1.held).toBeDefined();
    expect(ix.rows('SELECT block_number FROM failed_tx_cursor')).toEqual([{ block_number: HEAD + 100 }]);
    // The next run reads the rewind from what is stored and scans the range again.
    const r2 = await runChain(ctx());
    expect(r2.scanned!.from).toBe(HEAD + 1);
    expect(ix.rows('SELECT tx_hash FROM failed_tx').map((x) => x.tx_hash)).toEqual([txHash(22)]);
  });

  it('holds, storing no checkpoint, when the range it read is replaced during the run', async () => {
    const chain = modelChain(DEPLOY, HEAD);
    const ix = realIndexer();
    await runChain(context(chain, ix, 'explorer-and-audit', NOW, listedExplorer(chain)));
    chain.setHead(HEAD + 100);
    chain.txs.push({ hash: txHash(27), block: HEAD + 60, to: DIAMOND, input: repay(27n), status: 0, revert: REVERT, trace: 'ok' });
    const inner = listedExplorer(chain);
    let switched = false;
    const switching: Explorer = {
      async failedSentTo(address, from, to) {
        const out = await inner.failedSentTo(address, from, to);
        if (!switched) {
          switched = true;
          chain.replaceFrom(HEAD + 50);
        }
        return out;
      },
    };
    const r = await runChain(context(chain, ix, 'explorer-and-audit', NOW, switching));
    expect(r.held).toMatch(/changed while the run read/);
    expect(ix.rows('SELECT block_number FROM failed_tx_cursor')).toEqual([{ block_number: HEAD }]);
    expect(ix.rows("SELECT from_block FROM failed_tx_range WHERE kind = 'checkpoint'")).toEqual([{ from_block: HEAD }]);
    // Its records travel with the checkpoint, so none from the old branch is live.
    expect(ix.rows('SELECT COUNT(*) AS n FROM failed_tx')).toEqual([{ n: 0 }]);
  });

  it('runs as sends-and-audit, and says so, when the explorer will not serve the list', async () => {
    const chain = modelChain(DEPLOY, HEAD);
    const ix = realIndexer();
    const refusing: Explorer = {
      async failedSentTo() {
        throw new ExplorerFailure('unreadable', 'explorer: Free API access is not supported for this chain');
      },
    };
    const r = await runChain(context(chain, ix, 'explorer-and-audit', NOW, refusing));
    expect(r.mode).toBe('sends-and-audit');
    expect(r.findings.some((f) => f.level === 'alert' && f.key === 'explorer-unreadable')).toBe(true);
    expect(ix.rows('SELECT mode, watched_share_bps, slow_block_number FROM failed_tx_cursor')).toEqual([{ mode: 'sends-and-audit', watched_share_bps: 208, slow_block_number: null }]);
    expect(ix.rows("SELECT COUNT(*) AS n FROM failed_tx_range WHERE kind = 'gap'")).toEqual([{ n: 0 }]);
  });

  it('alerts when its state cannot be read', async () => {
    const chain = modelChain(DEPLOY, HEAD);
    const ix = realIndexer();
    const ctx = context(chain, ix, 'explorer-and-audit', NOW, listedExplorer(chain));
    ctx.indexer = { ...ix, state: async () => { throw new IndexerFailure(401, 'state 401'); } };
    const r = await runChain(ctx);
    expect(r.held).toMatch(/could not be read/);
    expect(r.findings.some((f) => f.level === 'alert' && f.key === 'state-unreadable')).toBe(true);
  });

  it('holds when two reads of the checkpoint block disagree', async () => {
    const chain = modelChain(DEPLOY, HEAD);
    const ix = realIndexer();
    await runChain(context(chain, ix, 'explorer-and-audit', NOW, listedExplorer(chain)));
    chain.flap(true);
    const r = await runChain(context(chain, ix, 'explorer-and-audit', NOW, listedExplorer(chain)));
    expect(r.held).toMatch(/disagreed/);
    expect(ix.rows("SELECT * FROM failed_tx_range WHERE kind = 'replaced'")).toEqual([]);
  });

  it('in trace-filter mode, records failed transactions and skips ones that succeeded despite an inner failure', async () => {
    const chain = modelChain(DEPLOY, HEAD);
    chain.txs.push({ hash: txHash(8), block: HEAD - 7, to: DIAMOND, input: repay(14n), status: 0, revert: REVERT, trace: 'ok' });
    chain.txs.push({ hash: txHash(9), block: HEAD - 6, to: DIAMOND, input: repay(15n), status: 1, trace: 'ok' });
    const ix = realIndexer();
    const r = await runChain(context(chain, ix, 'trace-filter', NOW));
    expect(r.records).toBe(1);
    expect(ix.rows('SELECT tx_hash, found_by, mode FROM failed_tx')).toEqual([{ tx_hash: txHash(8), found_by: 'trace-filter', mode: 'trace-filter' }]);
    expect(ix.rows('SELECT audit_day, slow_block_number FROM failed_tx_cursor')).toEqual([{ audit_day: null, slow_block_number: null }]);
  });

  it('records a contract creation found through its constructor, naming the address it would have deployed', async () => {
    const chain = modelChain(DEPLOY, HEAD);
    chain.txs.push({ hash: txHash(28), block: HEAD - 20, to: DIAMOND, input: '0x6080604052', status: 0, revert: REVERT, trace: 'ok', creation: true });
    const ix = realIndexer();
    const r = await runChain(context(chain, ix, 'trace-filter', NOW));
    expect(r.held).toBeUndefined();
    const expected = getContractAddress({ from: `0x${'a'.repeat(40)}`, nonce: 5n }).toLowerCase();
    const rows = ix.rows('SELECT contract, function_selector, unavailable FROM failed_tx');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.contract).toBe(expected);
    expect(rows[0]!.function_selector).toBeNull();
    expect(String(rows[0]!.unavailable)).toContain('a contract creation');
  });

  it('audits a slice of yesterday, records what the list missed and reports it', async () => {
    const chain = modelChain(DEPLOY, HEAD);
    const windowStart = DEPLOY + 86_400; // random() = 0: the window starts at yesterday's midnight
    chain.txs.push({ hash: txHash(10), block: windowStart + 3, to: DIAMOND, input: repay(16n), status: 0, revert: REVERT, trace: 'ok' });
    const ix = realIndexer();
    const r = await runChain(wide(context(chain, ix, 'explorer-and-audit', NOW, listedExplorer(chain, new Set([txHash(10)])))));
    expect(r.audited).toEqual({ from: windowStart, to: windowStart + defaultSettings(planFor(cap('explorer-and-audit'), true)).auditBlocksPerRun - 1, found: 1, missed: 1 });
    expect(ix.rows('SELECT tx_hash, found_by FROM failed_tx')).toEqual([{ tx_hash: txHash(10), found_by: 'audit' }]);
    expect(r.findings.some((f) => f.level === 'alert' && f.key === `audit-missed-${txHash(10)}`)).toBe(true);
    // The next run continues the window where this one stopped.
    const r2 = await runChain(context(chain, ix, 'explorer-and-audit', NOW, listedExplorer(chain)));
    expect(r2.audited!.from).toBe(r.audited!.to + 1);
  });

  it('counts as covered a failure the same run’s list found in the audit window, before it is stored', async () => {
    const chain = modelChain(DEPLOY, HEAD);
    const windowStart = DEPLOY + 86_400;
    chain.txs.push({ hash: txHash(27), block: windowStart + 3, to: DIAMOND, input: repay(27n), status: 0, revert: REVERT, trace: 'ok' });
    const ix = realIndexer();
    const r = await runChain(wide(context(chain, ix, 'explorer-and-audit', NOW, listedExplorer(chain))));
    expect(r.audited).toMatchObject({ from: windowStart, found: 1, missed: 0 });
    expect(r.findings.some((f) => f.key.startsWith('audit-missed-'))).toBe(false);
    expect(ix.rows('SELECT tx_hash, found_by FROM failed_tx')).toEqual([{ tx_hash: txHash(27), found_by: 'explorer-list' }]);
  });

  it('does not count as misses the finds in a window the list was never asked about', async () => {
    const chain = modelChain(DEPLOY, HEAD);
    const windowStart = DEPLOY + 86_400;
    chain.txs.push({ hash: txHash(26), block: windowStart + 3, to: DIAMOND, input: repay(26n), status: 0, revert: REVERT, trace: 'ok' });
    const ix = realIndexer();
    // A first run looks back one day: the list starts after yesterday's midnight window.
    const r = await runChain(context(chain, ix, 'explorer-and-audit', NOW, listedExplorer(chain)));
    expect(r.audited).toMatchObject({ from: windowStart, found: 1, missed: null });
    expect(r.findings.some((f) => f.key.startsWith('audit-missed-'))).toBe(false);
    expect(ix.rows('SELECT tx_hash, found_by FROM failed_tx')).toEqual([{ tx_hash: txHash(26), found_by: 'audit' }]);
    expect(ix.rows("SELECT found, missed FROM failed_tx_range WHERE kind = 'audit'")).toEqual([{ found: 1, missed: null }]);
  });

  it('keeps an audit miss a miss when the slice is read again after an interrupted run', async () => {
    const chain = modelChain(DEPLOY, HEAD);
    const windowStart = DEPLOY + 86_400;
    chain.txs.push({ hash: txHash(24), block: windowStart + 3, to: DIAMOND, input: repay(24n), status: 0, revert: REVERT, trace: 'ok' });
    const ix = realIndexer();
    const ctx = wide(context(chain, ix, 'explorer-and-audit', NOW, listedExplorer(chain, new Set([txHash(24)]))));
    const inner = ctx.indexer;
    ctx.indexer = {
      state: inner.state.bind(inner),
      write: async (body) => {
        if ((body as { kind?: string }).kind === 'cursor') throw new RpcFailure('transient', null, 'stopped');
        return inner.write(body);
      },
    };
    const r1 = await runChain(ctx);
    expect(r1.held).toBeDefined();
    expect(ix.rows('SELECT found_by FROM failed_tx')).toEqual([{ found_by: 'audit' }]);
    const r2 = await runChain(wide(context(chain, ix, 'explorer-and-audit', NOW, listedExplorer(chain, new Set([txHash(24)])))));
    expect(r2.audited).toMatchObject({ from: windowStart, found: 1, missed: 1 });
    expect(ix.rows("SELECT found, missed FROM failed_tx_range WHERE kind = 'audit'")).toEqual([{ found: 1, missed: 1 }]);
  });

  it('stops the audit slice at a block the node gives no receipts for, and reads it again next run', async () => {
    const chain = modelChain(DEPLOY, HEAD);
    const windowStart = DEPLOY + 86_400;
    const ix = realIndexer();
    const ctx = context(chain, ix, 'explorer-and-audit', NOW, listedExplorer(chain));
    const rpc = chain.rpc;
    ctx.rpc = { call: (m, p) => (m === 'eth_getBlockReceipts' && Number.parseInt(p[0] as string, 16) === windowStart + 2 ? Promise.resolve(null as never) : rpc.call(m, p)) };
    const r = await runChain(ctx);
    expect(r.audited).toMatchObject({ from: windowStart, to: windowStart + 1 });
    const r2 = await runChain(context(chain, ix, 'explorer-and-audit', NOW, listedExplorer(chain)));
    expect(r2.audited!.from).toBe(windowStart + 2);
  });

  it('finishes an unfinished audit window before choosing the next day’s', async () => {
    const chain = modelChain(DEPLOY, HEAD);
    const ix = realIndexer();
    const r1 = await runChain(context(chain, ix, 'explorer-and-audit', NOW));
    const day1 = ix.rows('SELECT audit_day FROM failed_tx_cursor')[0]!.audit_day;
    const r2 = await runChain(context(chain, ix, 'explorer-and-audit', NOW + 86_400));
    expect(r2.audited!.from).toBe(r1.audited!.to + 1);
    expect(ix.rows('SELECT audit_day FROM failed_tx_cursor')[0]!.audit_day).toBe(day1);
  });

  it('states the days that got no audit window when a finished window is followed by a gap', async () => {
    const chain = modelChain(DEPLOY, HEAD);
    const ix = realIndexer();
    const whole = (c: RunContext): RunContext => ({ ...c, settings: { ...c.settings, auditBlocksPerRun: 1_000_000 } });
    await runChain(whole(context(chain, ix, 'explorer-and-audit', NOW)));
    const r = await runChain(whole(context(chain, ix, 'explorer-and-audit', NOW + 2 * 86_400)));
    const skipped = r.findings.find((f) => f.key.startsWith('audit-skipped-'));
    expect(skipped?.level).toBe('alert');
    expect(skipped?.text).toContain('were not watched');
  });

  it('with no explorer key, runs sends-and-audit and states the watched share', async () => {
    const chain = modelChain(DEPLOY, HEAD);
    const ix = realIndexer();
    await runChain(context(chain, ix, 'explorer-and-audit', NOW));
    expect(ix.rows('SELECT mode, watched_share_bps FROM failed_tx_cursor')).toEqual([{ mode: 'sends-and-audit', watched_share_bps: 208 }]);
  });
});

describe('cadence', () => {
  it('reads the direct contracts every run and the rest once an hour of blocks has passed', async () => {
    const chain = modelChain(DEPLOY, HEAD);
    const ix = realIndexer();
    const first = listedExplorer(chain);
    await runChain(context(chain, ix, 'explorer-and-audit', NOW, first));
    const plan = planFor(cap('explorer-and-audit'), true);
    expect(first.calls.length).toBe(plan.watched.length);
    chain.setHead(HEAD + 600);
    const second = listedExplorer(chain);
    await runChain(context(chain, ix, 'explorer-and-audit', NOW + 600, second));
    expect(second.calls.length).toBe(plan.direct.length);
    expect(ix.rows('SELECT block_number, slow_block_number FROM failed_tx_cursor')).toEqual([{ block_number: HEAD + 600, slow_block_number: HEAD }]);
    chain.setHead(HEAD + 3700);
    const third = listedExplorer(chain);
    await runChain(context(chain, ix, 'explorer-and-audit', NOW + 3700, third));
    expect(third.calls.length).toBe(plan.watched.length);
    // Each list is asked again over the overlap behind its position.
    const overlap = Math.ceil(defaultSettings(plan).listOverlapSeconds / plan.blockTimeSeconds);
    expect(third.calls).toContain(`${plan.watched.find((a) => !plan.direct.includes(a))}:${HEAD + 1 - overlap}-${HEAD + 3700}`);
    expect(third.calls).toContain(`${plan.direct[0]}:${HEAD + 601 - overlap}-${HEAD + 3700}`);
  });

  it('collects a failure the explorer lists only after its block was first read, without decoding recorded ones again', async () => {
    const chain = modelChain(DEPLOY, HEAD);
    chain.txs.push({ hash: txHash(20), block: HEAD - 200, to: DIAMOND, input: repay(20n), status: 0, revert: REVERT, trace: 'ok' });
    chain.txs.push({ hash: txHash(21), block: HEAD - 5, to: DIAMOND, input: repay(21n), status: 0, revert: REVERT, trace: 'ok' });
    const ix = realIndexer();
    // The first run's list does not yet carry tx 21.
    await runChain(context(chain, ix, 'explorer-and-audit', NOW, listedExplorer(chain, new Set([txHash(21)]))));
    expect(ix.rows('SELECT tx_hash FROM failed_tx').map((x) => x.tx_hash)).toEqual([txHash(20)]);
    chain.setHead(HEAD + 300);
    const traced: string[] = [];
    const rpc = chain.rpc;
    const ctx = context(chain, ix, 'explorer-and-audit', NOW + 300, listedExplorer(chain));
    ctx.rpc = { call: (m, p) => (m === 'debug_traceTransaction' && traced.push(p[0] as string), rpc.call(m, p)) };
    const r = await runChain(ctx);
    expect(ix.rows('SELECT tx_hash FROM failed_tx ORDER BY block_number').map((x) => x.tx_hash)).toEqual([txHash(20), txHash(21)]);
    expect(traced).toEqual([txHash(21)]);
    expect(r.findings.some((f) => f.key === `listed-late-${txHash(21)}`)).toBe(true);
  });

  it('spreads a catch-up over runs, and says when the cursor is behind', async () => {
    const chain = modelChain(DEPLOY, HEAD);
    const ix = realIndexer();
    const ctx = context(chain, ix, 'explorer-and-audit', NOW, listedExplorer(chain));
    ctx.settings = { ...ctx.settings, maxBlocksPerRun: 1000 };
    const r = await runChain(ctx);
    expect(r.scanned!.to - r.scanned!.from + 1).toBe(1000);
    expect(r.findings.some((f) => f.key === 'behind')).toBe(true);
  });
});

describe('the plan and the record bounds', () => {
  it('watches the deployment record contracts but not facets, implementations or people', () => {
    const w = watchedAddresses({ diamond: '0x' + '1'.repeat(40), vaultImpl: '0x' + '2'.repeat(40), admin: '0x' + '3'.repeat(40), facets: { a: '0x' + '4'.repeat(40) }, testnetMocks: { usdc: '0x' + '5'.repeat(40) } });
    expect(w).toEqual(['0x' + '1'.repeat(40), '0x' + '5'.repeat(40)]);
  });

  it('refuses a block-scan result rather than running it as something else', () => {
    expect(() => planFor(cap('block-scan'), true)).toThrow(/block-scan/);
    expect(() => planFor(cap('trace-filter'), true)).toThrow(/no usable range/);
  });

  it('bounds the error values to their own field limit, and says when they are not stored', () => {
    const cut = boundErrorValues({ reason: 'r'.repeat(20 * 1024), code: '7' });
    expect(cut.dropped).toBe(false);
    expect((cut.value as Record<string, string>).reason!.endsWith(CUT_MARK)).toBe(true);
    expect(jsonBytes(cut.value)).toBeLessThanOrEqual(MAX_ERROR_VALUES_BYTES);
    const many = boundErrorValues({ list: Array.from({ length: 5000 }, (_, i) => String(i)) });
    expect(many).toMatchObject({ value: null, cut: true, dropped: true });
  });

  it('records a failure whose error values are over their bound, rather than having every write refused', async () => {
    const chain = modelChain(DEPLOY, HEAD);
    const long = encodeErrorResult({ abi: parseAbi(['error Error(string)']), errorName: 'Error', args: ['z'.repeat(20 * 1024)] });
    chain.txs.push({ hash: txHash(23), block: HEAD - 10, to: DIAMOND, input: repay(23n), status: 0, revert: long, trace: 'ok' });
    const ix = realIndexer();
    const r = await runChain(context(chain, ix, 'explorer-and-audit', NOW, listedExplorer(chain)));
    expect(r.records).toBe(1);
    const [row] = ix.rows('SELECT error_values, explanation_cut FROM failed_tx');
    expect(String(row!.error_values)).toContain(CUT_MARK);
    expect(row!.explanation_cut).toBe(1);
  });

  it('fits a replay record whose raw revert data is over the explanation bound', async () => {
    const chain = modelChain(DEPLOY, HEAD);
    const raw = '0xdeadbeef' + 'ab'.repeat(140 * 1024);
    chain.txs.push({ hash: txHash(25), block: HEAD - 10, to: DIAMOND, input: repay(25n), status: 0, revert: raw, trace: 'refused', call: 'revert' });
    const ix = realIndexer();
    const r = await runChain(context(chain, ix, 'explorer-and-audit', NOW, listedExplorer(chain)));
    expect(r.records).toBe(1);
    const [row] = ix.rows('SELECT source, explanation, explanation_cut FROM failed_tx');
    expect(row).toMatchObject({ source: 'replay', explanation_cut: 1 });
    expect(String(row!.explanation)).toContain(CUT_MARK);
  });

  it('states that an explanation is not stored when no cut makes it fit', () => {
    const many = Object.fromEntries(Array.from({ length: 40_000 }, (_, i) => [`k${i}`, i]));
    const out = fitRecord({ explanation: many, errorValues: null, unavailable: null, explanationCut: false } as never);
    expect((out.explanation as { notStored?: string }).notStored).toBeDefined();
    expect(out.unavailable).toContain('the explanation (over the record size bound)');
  });

  it('splits alerts into messages the operator chat takes, every alert in one of them', () => {
    const alerts = Array.from({ length: 30 }, (_, i) => ({ chainId: 1, level: 'alert' as const, key: `k${i}`, text: `${i} `.padEnd(300, 'x') }));
    const batches = alertBatches(alerts);
    expect(batches.length).toBeGreaterThan(1);
    expect(batches.flat().map((a) => a.key)).toEqual(alerts.map((a) => a.key));
    for (const b of batches) expect(['Failed transaction pass', ...b.map((a) => `• ${a.text}`)].join('\n').length).toBeLessThanOrEqual(ALERT_MESSAGE_CHARS);
    const huge = alertBatches([{ chainId: 1, level: 'alert', key: 'h', text: 'h'.repeat(10_000) }]);
    expect(huge[0]![0]!.text.length).toBeLessThan(ALERT_MESSAGE_CHARS);
  });

  it('cuts the longest argument values to fit, with a mark', () => {
    const big = 'x'.repeat(MAX_EXPLANATION_BYTES);
    const out = boundExplanation({ steps: [{ kind: 'call', function: { args: { data: big, small: 'y' } } }], stop: { error: { name: 'E' } } });
    expect(out.cut).toBe(true);
    expect(out.dropped).toBe(false);
    const args = (out.value as { steps: Array<{ function: { args: Record<string, string> } }> }).steps[0]!.function.args;
    expect(args.data!.endsWith(CUT_MARK)).toBe(true);
    expect(args.small).toBe('y');
  });
});
