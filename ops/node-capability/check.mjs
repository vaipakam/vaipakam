#!/usr/bin/env node
// Node capability check (#3913).
//
// Asks the node each network's services use what it can answer, and writes
// one result per network. The failed transaction record reads the result to
// choose between a trace filter and a block scan; the transaction explainer
// reads how far back a trace or a replay can reach
// (docs/DesignsAndPlans/TroubleshootingPictureDesign.md, section 4.3).
//
// Read-only. It sends no transaction and holds no key. The node endpoints are
// operator secrets: each comes from the environment variable the keeper reads
// (RPC_BASE_SEPOLIA and so on), and no endpoint, host or key is ever printed
// or written; a node's error text is cut down and scrubbed before it is kept.
//
// Usage (from a checkout, with the machine's env file):
//   node --env-file=/etc/vaipakam/keeper.env ops/node-capability/check.mjs \
//     [--only base-sepolia,arb-sepolia] [--out <dir>]
// Without --out the results go to stdout as one JSON array. With --out each
// network is written to <dir>/<slug>.json, the form committed under
// ops/node-capability/results/.
//
// Optional per network: NODE_PLAN_<SAME SUFFIX> (for example
// NODE_PLAN_BASE_SEPOLIA) states the node plan's limits in numbers, such as
// "25 requests per second; 300M units per month". It is copied into the
// result as stated. Write numbers only: never the provider's name.
//
// Dependency-free on purpose (Node 20+ fetch), so it runs on the always-on
// machine from a plain checkout with nothing installed or built.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCHEMA = 1;

/**
 * The networks a service may serve: the keeper's list (apps/keeper/src/env.ts)
 * with the deployment folder each one's record lives in. A network whose
 * variable is unset is reported as "no node configured", never skipped.
 * `env` is the services' variable; `alt` is the same node under the deploy
 * .env's name (contracts/.env), so the check can run where either file is.
 * The result names the variable it read, never its value.
 */
export const NETWORKS = [
  { slug: 'base-sepolia', chainId: 84532, env: 'RPC_BASE_SEPOLIA', alt: 'BASE_SEPOLIA_RPC_URL', testnet: true },
  { slug: 'arb-sepolia', chainId: 421614, env: 'RPC_ARB_SEPOLIA', alt: 'ARB_SEPOLIA_RPC_URL', testnet: true },
  { slug: 'bnb-testnet', chainId: 97, env: 'RPC_BNB_TESTNET', alt: 'BNB_TESTNET_RPC_URL', testnet: true },
  { slug: 'sepolia', chainId: 11155111, env: 'RPC_SEPOLIA', alt: 'SEPOLIA_RPC_URL', testnet: true },
  { slug: 'op-sepolia', chainId: 11155420, env: 'RPC_OP_SEPOLIA', alt: 'OP_SEPOLIA_RPC_URL', testnet: true },
  { slug: 'base', chainId: 8453, env: 'RPC_BASE', alt: 'BASE_RPC_URL', testnet: false },
  { slug: 'ethereum', chainId: 1, env: 'RPC_ETH', alt: 'ETHEREUM_RPC_URL', testnet: false },
  { slug: 'arbitrum', chainId: 42161, env: 'RPC_ARB', alt: 'ARBITRUM_RPC_URL', testnet: false },
  { slug: 'optimism', chainId: 10, env: 'RPC_OP', alt: 'OPTIMISM_RPC_URL', testnet: false },
  { slug: 'bnb', chainId: 56, env: 'RPC_BNB', alt: 'BNB_RPC_URL', testnet: false },
  { slug: 'polygon-zkevm', chainId: 1101, env: 'RPC_ZKEVM', testnet: false },
];

/**
 * How far back each reach probe looks. The first is 64 blocks, inside the
 * recent window every node keeps; the rest are days.
 */
const RECENT_BLOCKS = 64;
const REACH_DAYS = [0.04, 1, 7, 30, 90, 365];
/** Block ranges tried for the trace filter, smallest first. */
const FILTER_RANGES = [10, 100, 1000, 10000];
/** Recent blocks read to size a block scan. */
const SCAN_SAMPLE = 30;
/** The daily sampled audit's window (design section 4.3). */
const AUDIT_WINDOW_SECONDS = 30 * 60;
/** A continuous block scan is kept only under both of these a day. */
const SCAN_LIMIT_REQUESTS = 20_000;
const SCAN_LIMIT_MB = 200;
/** How often the record would poll the explorer, for its daily cost. */
const EXPLORER_POLL_MINUTES = 5;
const TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------- transport

/**
 * Cuts a node's error text down to something safe to commit: no endpoint, no
 * host, no long token-like run (a key echoed back), at most 120 characters.
 */
export function scrub(text, url) {
  let s = String(text ?? '');
  if (url) {
    try {
      const u = new URL(url);
      for (const part of [url, u.host, u.hostname, u.pathname, u.search].filter((p) => p && p.length > 3)) {
        s = s.split(part).join('<node>');
      }
    } catch {
      s = s.split(url).join('<node>');
    }
  }
  s = s.replace(/https?:\/\/\S+/gi, '<url>').replace(/wss?:\/\/\S+/gi, '<url>');
  s = s.replace(/[A-Za-z0-9_-]{24,}/g, (m) => (/^0x[0-9a-fA-F]+$/.test(m) ? m : '<redacted>'));
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > 120 ? `${s.slice(0, 117)}...` : s;
}

class RpcError extends Error {
  constructor(kind, detail) {
    super(detail);
    this.kind = kind; // 'rpc' | 'http' | 'transport' | 'timeout'
  }
}

function makeClient(url) {
  let id = 0;
  let requests = 0;
  const call = async (method, params = []) => {
    requests += 1;
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      const timeout = e?.name === 'TimeoutError' || e?.name === 'AbortError';
      throw new RpcError(timeout ? 'timeout' : 'transport', timeout ? 'no answer in time' : 'request failed');
    }
    const text = await res.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    if (!res.ok) {
      const why = body?.error ? `${body.error.code ?? ''} ${body.error.message ?? ''}` : '';
      throw new RpcError('http', scrub(`HTTP ${res.status} ${why}`, url));
    }
    if (body === null) throw new RpcError('http', 'answer is not JSON');
    if (body.error) throw new RpcError('rpc', scrub(`${body.error.code ?? ''} ${body.error.message ?? ''}`, url));
    return { result: body.result, bytes: text.length };
  };
  return { call, requests: () => requests };
}

/** Runs a probe and returns {answered, error?, value?} without throwing. */
async function attempt(fn) {
  try {
    return { answered: true, value: await fn() };
  } catch (e) {
    if (e instanceof RpcError) return { answered: false, error: e.message };
    throw e;
  }
}

const hex = (n) => `0x${n.toString(16)}`;
const num = (h) => Number.parseInt(h, 16);

// ------------------------------------------------------------------- probes

function readRecord(slug) {
  const p = join(ROOT, 'contracts', 'deployments', slug, 'addresses.json');
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

/** Every contract address in a deployment record (the contracts watched). */
export function watchedAddresses(record) {
  if (!record) return [];
  const out = new Set();
  const walk = (v, key) => {
    if (typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v)) {
      // People and the treasury are not contracts the platform calls into,
      // and an implementation behind a proxy is reached through its proxy.
      if (!['admin', 'treasury', 'keeperAddress'].includes(key) && !/Impl$/.test(key)) out.add(v.toLowerCase());
    } else if (v && typeof v === 'object') {
      // A facet is reached through the Diamond, never called directly.
      if (key === 'facets') return;
      for (const [k, x] of Object.entries(v)) walk(x, k);
    }
  };
  walk(record, '');
  return [...out].sort();
}

/** Finds a block at or after `from` that carries a transaction (hash list). */
async function blockWithTx(rpc, from, head, limit = 25) {
  for (let b = from; b <= Math.min(head, from + limit); b++) {
    const { result } = await rpc.call('eth_getBlockByNumber', [hex(b), false]);
    if (result?.transactions?.length) return { number: b, tx: result.transactions[0] };
  }
  return null;
}

/** A block's timestamp, cached per network. */
async function timestampOf(ctx, block) {
  if (!ctx.times.has(block)) {
    const { result } = await ctx.rpc.call('eth_getBlockByNumber', [hex(block), false]);
    ctx.times.set(block, num(result.timestamp));
  }
  return ctx.times.get(block);
}

/**
 * The block about `days` old, found by its timestamp rather than by an
 * assumed block time (block times change over a network's life). A few
 * secant steps land within a fraction of a day. Null when the network is
 * younger than that.
 */
async function blockAtAge(ctx, days) {
  const want = ctx.headTime - days * 86400;
  let guess = ctx.head - Math.round(days * ctx.blocksPerDay);
  for (let i = 0; i < 8; i++) {
    if (guess < 1) return null;
    const t = await timestampOf(ctx, guess);
    if (Math.abs(t - want) < 3600 || guess === ctx.head) break;
    // Seconds per block between this guess and the head, then step by it.
    const secondsPerBlock = (ctx.headTime - t) / (ctx.head - guess);
    const next = guess - Math.round((t - want) / Math.max(secondsPerBlock, 1e-3));
    if (next === guess) break;
    guess = Math.min(ctx.head - 1, next);
  }
  return guess < 1 ? null : { block: guess };
}

/**
 * Walks the reach offsets oldest-last and reports the furthest one that
 * answered and the first one that did not. A node that answers at 30 days and
 * refuses at 90 reaches "at least 30 days".
 */
async function reach(ctx, probe) {
  const tried = [];
  let furthest = null;
  let firstRefused = null;
  const targets = [null, ...REACH_DAYS];
  for (const d of targets) {
    let found;
    let days;
    try {
      found = d === null ? { block: ctx.head - RECENT_BLOCKS } : await blockAtAge(ctx, d);
      if (!found || found.block < 1) break; // the network is younger than that
      days = +((ctx.headTime - (await timestampOf(ctx, found.block))) / 86400).toFixed(4);
    } catch (e) {
      if (!(e instanceof RpcError)) throw e;
      // The node keeps no block header that old, so nothing there is reachable.
      tried.push({ days: d, answered: false, error: `no block header that old: ${e.message}` });
      if (firstRefused === null) firstRefused = d;
      break;
    }
    const block = found.block;
    const r = await attempt(() => probe(block));
    tried.push({ days, block, answered: r.answered, ...(r.error ? { error: r.error } : {}) });
    if (r.answered) furthest = days;
    else if (firstRefused === null) {
      firstRefused = days;
      break;
    }
  }
  return { reachDays: furthest, refusedAtDays: firstRefused, reachTried: tried };
}

/**
 * Probes the network's explorer API, if one is configured. The explorer is
 * named only by the environment: EXPLORER_API_<suffix> is its API base URL
 * (an account/txlist API of the common shape), EXPLORER_KEY_<suffix> its key
 * if it has one. Neither is written to the result.
 *
 * Measured: whether it answers without a key, whether its rows say which
 * transactions failed, and how far behind the chain head its newest row is
 * (the source's delay). The record replays a failure at its block, so the
 * node's past-state reach must cover that delay.
 */
async function checkExplorer(net, env, { head, blockTime, rpc, recent, watched }) {
  const suffix = net.env.replace(/^RPC_/, '');
  const apiBase = env[`EXPLORER_API_${suffix}`]?.trim();
  if (!apiBase) return { configured: false };
  // EXPLORER_KEY_FROM names a variable already holding a key (for example
  // the deploy .env's explorer key), so the key is never typed on a command.
  const keyFrom = env.EXPLORER_KEY_FROM?.trim();
  const key = env[`EXPLORER_KEY_${suffix}`]?.trim() || (keyFrom ? env[keyFrom]?.trim() : undefined);
  // A busy address shows the explorer's lag; the Diamond may be quiet.
  let probeAddress = watched[0] ?? null;
  if (recent) {
    const tx = await rpc.call('eth_getTransactionByHash', [recent.tx]);
    if (tx.result?.to) probeAddress = tx.result.to;
  }
  if (!probeAddress) return { configured: true, answered: false, error: 'no address to ask about' };
  const ask = async (withKey) => {
    const u = new URL(apiBase);
    u.searchParams.set('chainid', String(net.chainId));
    u.searchParams.set('module', 'account');
    u.searchParams.set('action', 'txlist');
    u.searchParams.set('address', probeAddress);
    u.searchParams.set('sort', 'desc');
    u.searchParams.set('page', '1');
    u.searchParams.set('offset', '25');
    if (withKey && key) u.searchParams.set('apikey', key);
    let res;
    try {
      res = await fetch(u, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch {
      return { ok: false, error: 'request failed' };
    }
    const text = await res.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    if (!res.ok || !body) return { ok: false, error: scrub(`HTTP ${res.status} ${body?.message ?? ''}`, apiBase) };
    if (!Array.isArray(body.result)) return { ok: false, error: scrub(`${body.message ?? ''} ${typeof body.result === 'string' ? body.result : ''}`, apiBase) };
    return { ok: true, rows: body.result };
  };
  const keyless = await ask(false);
  const keyed = keyless.ok ? keyless : key ? await ask(true) : null;
  const out = {
    configured: true,
    answeredWithoutKey: keyless.ok,
    ...(keyless.ok ? {} : { withoutKeyError: keyless.error }),
    keyConfigured: Boolean(key),
    // 'unknown' when it refused without a key and none was given to try.
    needsKey: keyless.ok ? false : keyed?.ok ? true : 'unknown',
  };
  if (!keyed?.ok) return { ...out, answered: false, ...(keyed ? { error: keyed.error } : {}) };
  const rows = keyed.rows;
  const newest = rows.reduce((m, r) => Math.max(m, Number(r.blockNumber ?? 0)), 0);
  // The head read again now: the one from the start of the run is minutes old.
  const headNow = num((await rpc.call('eth_blockNumber')).result);
  const lagBlocks = newest ? Math.max(0, headNow - newest) : null;
  return {
    ...out,
    answered: true,
    marksFailures: rows.length === 0 ? 'unknown (no rows)' : rows.every((r) => 'isError' in r || 'txreceipt_status' in r),
    delayBlocks: lagBlocks,
    delaySeconds: lagBlocks === null ? null : Math.round(lagBlocks * blockTime),
    requestsPerDay: Math.round((1440 / EXPLORER_POLL_MINUTES) * watched.length),
    pollMinutes: EXPLORER_POLL_MINUTES,
  };
}

const CALL_TRACER = { tracer: 'callTracer', tracerConfig: { onlyTopCall: false } };
// facetAddresses() — any Diamond answers it; any other address returns empty.
const FACET_ADDRESSES = '0x52ef6b2c';

/**
 * Megabytes a block scan of `blocks` blocks reads, at the sample's mean cost
 * per block: the full block plus the receipts of its watched transactions
 * (the receipt-per-transaction strategy the mode is chosen on).
 */
export function scanCost({ fullBytes, receiptBytes, sampleBlocks, blocks }) {
  return ((fullBytes + receiptBytes) / sampleBlocks) * blocks / 1024 / 1024;
}

export async function checkNetwork(net, env = process.env) {
  const variable = env[net.env] ? net.env : net.alt && env[net.alt] ? net.alt : net.env;
  const url = env[variable];
  const base = {
    schema: SCHEMA,
    network: net.slug,
    chainId: net.chainId,
    testnet: net.testnet,
    checkedAt: new Date().toISOString(),
    nodeVariable: variable,
    plan: env[`NODE_PLAN_${net.env.replace(/^RPC_/, '')}`]?.trim() || 'not stated',
  };
  if (!url) return { ...base, status: 'no node configured' };

  const rpc = makeClient(url);
  const record = readRecord(net.slug);
  const watched = watchedAddresses(record);
  const target = record?.diamond?.toLowerCase() ?? null;

  const chain = await attempt(() => rpc.call('eth_chainId'));
  if (!chain.answered) return { ...base, status: 'node did not answer', error: chain.error };
  if (num(chain.value.result) !== net.chainId) {
    return { ...base, status: 'node serves another network', servedChainId: num(chain.value.result) };
  }

  const head = num((await rpc.call('eth_blockNumber')).result);
  const span = Math.min(1000, head - 1);
  const [tip, old] = await Promise.all([
    rpc.call('eth_getBlockByNumber', [hex(head), false]),
    rpc.call('eth_getBlockByNumber', [hex(head - span), false]),
  ]);
  const blockTime = (num(tip.result.timestamp) - num(old.result.timestamp)) / span;
  const blocksPerDay = Math.round(86400 / blockTime);
  const ctx = { rpc, head, headTime: num(tip.result.timestamp), blocksPerDay, times: new Map() };

  // A recent transaction to trace (the newest block with one).
  const recent = await blockWithTx(rpc, Math.max(1, head - 20), head);

  // 1. Trace of one transaction: the debug form and the trace form.
  const traceTx = {};
  for (const [form, method, params] of [
    ['debug', 'debug_traceTransaction', (h) => [h, CALL_TRACER]],
    ['trace', 'trace_transaction', (h) => [h]],
  ]) {
    if (!recent) {
      traceTx[form] = { answered: false, error: 'no recent transaction found to trace' };
      continue;
    }
    const r = await attempt(() => rpc.call(method, params(recent.tx)));
    traceTx[form] = { answered: r.answered, ...(r.error ? { error: r.error } : {}) };
    if (r.answered) {
      traceTx[form] = {
        ...traceTx[form],
        ...(await reach(ctx, async (b) => {
          const found = await blockWithTx(rpc, b, head);
          if (!found) throw new RpcError('rpc', 'no transaction near that block');
          return rpc.call(method, params(found.tx));
        })),
      };
    }
  }

  // 2. Trace of a call that was never sent.
  const callObj = { to: target ?? '0x0000000000000000000000000000000000000000', data: FACET_ADDRESSES };
  const traceCall = {};
  for (const [form, method, params] of [
    ['debug', 'debug_traceCall', (b) => [callObj, hex(b), CALL_TRACER]],
    ['trace', 'trace_call', (b) => [callObj, ['trace'], hex(b)]],
  ]) {
    const r = await attempt(() => rpc.call(method, params(head)));
    traceCall[form] = { answered: r.answered, ...(r.error ? { error: r.error } : {}) };
    if (r.answered) traceCall[form] = { ...traceCall[form], ...(await reach(ctx, (b) => rpc.call(method, params(b)))) };
  }

  // 3. Trace filter over the watched contracts (or, with no record, the
  //    recent transaction's target, which is enough to know it answers).
  let filterTarget = watched;
  if (!filterTarget.length && recent) {
    const tx = await rpc.call('eth_getTransactionByHash', [recent.tx]);
    if (tx.result?.to) filterTarget = [tx.result.to.toLowerCase()];
  }
  const traceFilter = { answered: false, largestRange: null, rangesTried: [] };
  for (const range of FILTER_RANGES) {
    if (head - range < 1) break;
    const r = await attempt(() =>
      rpc.call('trace_filter', [{ fromBlock: hex(head - range), toBlock: hex(head), toAddress: filterTarget }]),
    );
    traceFilter.rangesTried.push({ range, answered: r.answered, ...(r.error ? { error: r.error } : {}) });
    if (!r.answered) break;
    if (!Array.isArray(r.value.result)) {
      traceFilter.rangesTried.at(-1).answered = false;
      traceFilter.rangesTried.at(-1).error = 'answer is not a list of traces';
      break;
    }
    traceFilter.answered = true;
    traceFilter.largestRange = range;
  }
  if (traceFilter.answered) {
    Object.assign(
      traceFilter,
      await reach(ctx, (b) =>
        rpc.call('trace_filter', [{ fromBlock: hex(b), toBlock: hex(b + 10), toAddress: filterTarget }]),
      ),
    );
  }

  // 4. A call at a past block, and how far back it reaches.
  const callAt = { answered: true, ...(await reach(ctx, (b) => rpc.call('eth_call', [callObj, hex(b)]))) };
  callAt.answered = callAt.reachDays !== null;
  // A call against state older than the Diamond still proves the node keeps
  // that state; the Diamond simply returns nothing there.

  // 5. Every receipt of a block in one request.
  const receiptsProbe = await attempt(() => rpc.call('eth_getBlockReceipts', [hex(head - 2)]));
  const blockReceipts = {
    answered: receiptsProbe.answered && Array.isArray(receiptsProbe.value.result),
    ...(receiptsProbe.error ? { error: receiptsProbe.error } : {}),
  };

  // 6. What a block scan costs: one full block read per block, then either
  //    one receipts request per block or one receipt per watched transaction.
  //    The mode is chosen on the receipt-per-transaction strategy, so the
  //    sample also reads each watched transaction's receipt and counts its
  //    bytes: a receipt-heavy contract can cost more than its blocks.
  let fullBytes = 0;
  let receiptBytes = 0;
  let watchedTx = 0;
  let txs = 0;
  const watchedSet = new Set(watched);
  for (let b = head - SCAN_SAMPLE + 1; b <= head; b++) {
    const { result, bytes } = await rpc.call('eth_getBlockByNumber', [hex(b), true]);
    fullBytes += bytes;
    for (const t of result?.transactions ?? []) {
      txs += 1;
      if (t.to && watchedSet.has(t.to.toLowerCase())) {
        watchedTx += 1;
        receiptBytes += (await rpc.call('eth_getTransactionReceipt', [t.hash])).bytes;
      }
    }
  }
  const perBlockWatched = watchedTx / SCAN_SAMPLE;
  const cost = scanCost({ fullBytes, receiptBytes, sampleBlocks: SCAN_SAMPLE, blocks: blocksPerDay });
  const blockScan = {
    blocksPerDay,
    sampleBlocks: SCAN_SAMPLE,
    transactionsPerBlock: +(txs / SCAN_SAMPLE).toFixed(2),
    watchedTransactionsPerBlock: +perBlockWatched.toFixed(3),
    fullBlockKilobytes: +(fullBytes / SCAN_SAMPLE / 1024).toFixed(1),
    receiptKilobytesPerWatchedTransaction: watchedTx ? +(receiptBytes / watchedTx / 1024).toFixed(1) : null,
    requestsPerDay: {
      withBlockReceipts: blockReceipts.answered ? blocksPerDay * 2 : null,
      withReceiptPerTransaction: Math.round(blocksPerDay * (1 + perBlockWatched)),
    },
    megabytesPerDay: Math.round(cost),
  };

  // 7. The explorer's list of transactions sent to a contract, which the
  //    record reads on a network with no trace filter (design section 4.3).
  const explorer = await checkExplorer(net, env, { head, blockTime, rpc, recent, watched });

  // 8. The daily sampled audit: one random 30-minute window, scanned block
  //    by block, to measure what the other sources missed.
  const windowBlocks = Math.ceil(AUDIT_WINDOW_SECONDS / blockTime);
  const audit = {
    windowMinutes: AUDIT_WINDOW_SECONDS / 60,
    windowBlocks,
    requestsPerDay: Math.round(windowBlocks * (1 + perBlockWatched)),
    megabytesPerDay: +scanCost({ fullBytes, receiptBytes, sampleBlocks: SCAN_SAMPLE, blocks: windowBlocks }).toFixed(1),
    // The audit decodes a failure by a replay at its block, so the node must
    // keep state for the age of the oldest block it may sample (a day).
    replayCovered: (callAt.reachDays ?? 0) >= 1,
  };

  const filterUsable = traceFilter.answered && (traceFilter.largestRange ?? 0) >= 100;
  const scanAffordable =
    blockScan.requestsPerDay.withReceiptPerTransaction <= SCAN_LIMIT_REQUESTS && blockScan.megabytesPerDay <= SCAN_LIMIT_MB;
  blockScan.affordable = scanAffordable;
  const result = {
    ...base,
    status: 'checked',
    head,
    blockTimeSeconds: +blockTime.toFixed(3),
    watchedContracts: watched.length,
    capabilities: { traceTransaction: traceTx, traceCall, traceFilter, callAtPastBlock: callAt, blockReceipts },
    blockScan,
    explorer,
    audit,
    // Design section 4.3 (after the measured costs): the trace filter where
    // the node offers it; else a continuous scan only where it is cheap;
    // else the keeper's own sends, the explorer and the daily audit.
    failedTransactionMode: filterUsable ? 'trace-filter' : scanAffordable ? 'block-scan' : 'explorer-and-audit',
    ...(filterUsable
      ? { traceFilterRequestsPerDay: Math.ceil(blocksPerDay / traceFilter.largestRange) }
      : {}),
    explainer: {
      traceSource: traceTx.debug.answered || traceTx.trace.answered ? 'node trace' : 'replay at the block',
      replayReachDays: callAt.reachDays,
    },
    requestsUsed: rpc.requests(),
  };
  if (explorer.answered && explorer.delaySeconds !== null) {
    explorer.replayCoversDelay = (callAt.reachDays ?? 0) * 86400 >= explorer.delaySeconds;
  }
  return result;
}

// ---------------------------------------------------------------------- CLI

async function main(argv) {
  const only = argv.includes('--only') ? argv[argv.indexOf('--only') + 1].split(',') : null;
  const out = argv.includes('--out') ? resolve(argv[argv.indexOf('--out') + 1]) : null;
  const nets = only ? NETWORKS.filter((n) => only.includes(n.slug)) : NETWORKS;
  if (only && nets.length !== only.length) {
    const known = new Set(NETWORKS.map((n) => n.slug));
    console.error(`unknown network: ${only.filter((s) => !known.has(s)).join(', ')}`);
    process.exit(2);
  }
  const results = [];
  for (const net of nets) {
    let r;
    try {
      r = await checkNetwork(net);
    } catch (e) {
      // Never let an unexpected failure print an endpoint.
      r = { schema: SCHEMA, network: net.slug, chainId: net.chainId, status: 'check failed', error: scrub(e?.message, process.env[net.env]) };
    }
    results.push(r);
    const line = r.status === 'checked'
      ? `${net.slug}: ${r.failedTransactionMode}; trace filter ${r.capabilities.traceFilter.answered ? `up to ${r.capabilities.traceFilter.largestRange} blocks` : 'no'}; past calls ${r.capabilities.callAtPastBlock.reachDays ?? 'none'} days`
      : `${net.slug}: ${r.status}`;
    console.error(line);
    if (out) {
      mkdirSync(out, { recursive: true });
      writeFileSync(join(out, `${net.slug}.json`), `${JSON.stringify(r, null, 2)}\n`);
    }
  }
  if (!out) process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(`check failed: ${scrub(e?.message)}`);
    process.exit(1);
  });
}
