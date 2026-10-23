/**
 * THE RPC AUDIT'S TALLY, WITH THE OFFER BOOK'S CATCH-UP SCAN COUNTED BY
 * SCAN, NOT BY CHUNK (#2097).
 *
 * `live-rpc-audit.mjs` holds the Offer Book to a steady-state RPC budget.
 * One part of the book's traffic is not steady-state by design: the
 * catch-up scan (`src/data/bookCatchUp.ts`) reads the chain tail the
 * indexer has not ingested, in serialized windows of `CHUNK_BLOCKS`, and
 * skips the scan entirely past `MAX_CATCHUP_BLOCKS`. So the number of
 * `eth_getLogs` one scan issues grows with the indexer's lag. With the
 * cursor ~4,952 blocks behind, a correctly behaving page issued 10 of them
 * in the window and the audit failed it; with the cursor current, the same
 * page issued 3 and passed (#2097, 2026-09-10 control run).
 *
 * Reading the indexer's lag and excusing the budget when it is high would
 * judge the page against a number read at another moment, and would stop
 * auditing the scan exactly when it is busiest. This counts the page's own
 * requests instead:
 *
 *   - A CATCH-UP CHUNK is an `eth_getLogs` whose topic-0 set is exactly the
 *     book's terminal-event set, derived from the same rules file the app
 *     reads (`src/data/bookCatchUpRules.json`), so the two cannot drift.
 *     Nothing else in the app asks for that set.
 *   - Chunks are grouped into RUNS: a chunk starting one block after an
 *     open run's last chunk continues it; any other chunk starts a run.
 *     Two refetches whose scans interleave are kept apart because each
 *     continuation is matched to exactly one open run. Only a full-width
 *     chunk can be continued, because the app cuts a window short only at
 *     a scan's end.
 *   - Each call's OUTCOME comes from the wire (`createCallLedger`, fed by
 *     the shared HTTP + WebSocket observer `attachLedger`), judged by the
 *     repo's one JSON-RPC response classifier: `ok` when the page received
 *     an answer it can use, `client-fault` when a reachable provider
 *     refused the page's request as malformed, `failed` otherwise (#2710 r4,
 *     #1633). Only `ok` counts as a success here.
 *   - RETRIES ARE NOT INFERRED. A retry of a failed request is on the wire
 *     an identical request, and an identical range is also what a fresh
 *     refetch sends when the head has not moved, so no rule over ranges can
 *     tell them apart (three review rounds of #2710 found three edges of the
 *     attempt). Every attempt is counted. What IS certain is a bound: each
 *     retry the transport sends follows a failed attempt of its own, so the
 *     calls the page itself chose to make number at least the total minus
 *     the failed attempts. The audit FAILS a budget only when even that
 *     lower bound is over it; over the budget but within it once failed
 *     attempts are discounted is UNRESOLVED (#2710 r6).
 *   - Only a window that SUCCEEDED can be continued: the app stops a scan
 *     at a window that fails (`chunkedGetLogs` returns), so a later request
 *     starting one block after a failed window is a new scan (#2710 r4).
 *   - ADJACENT SCANS, stated, because block numbers cannot separate them
 *     (#1672 records why): a later scan that starts exactly one block after
 *     an earlier scan's last full-width chunk reads as its continuation.
 *     That happens when the indexer's cursor lands exactly on the earlier
 *     scan's end. So a contiguous RUN of chunks is not always one scan, and
 *     nothing on the wire can say it is.
 *   - The BUDGET counts each run as the FEWEST scans a correct page could
 *     have issued to produce it: one per `MAX_CHUNKS_PER_SCAN` windows,
 *     rounded up. That matches the steady-state design ("one eth_getLogs
 *     per tick") whatever the lag, and a page that ignores the skip cap
 *     still pays for every 20 windows it reads. Two adjacent scans that
 *     merge into a run short enough for one are charged as one: one call
 *     in the lenient direction, and only on that exact coincidence.
 *   - The SCAN SHAPE is held to the app's own rules where the wire can
 *     establish them. No chunk is wider than `CHUNK_BLOCKS` — a chunk is
 *     one request, so this is certain, and a violation is a FAIL. A run
 *     LONGER than one scan may be (`longRuns`) is either a scan past the
 *     skip cap or adjacent scans, and the wire cannot say which, so it is
 *     reported as UNRESOLVED for a human to look at, never as a product
 *     FAIL (#2710 r2; the verdict rule is #2180's).
 *
 * Pure: `catchUpTally.test.mjs` pins it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toEventSelector } from 'viem';
import { classifyRpcResponse, isChainRpcMethod } from './rpc-verdict.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const readJson = (rel) => JSON.parse(fs.readFileSync(path.resolve(HERE, rel), 'utf8'));
const DIAMOND_ABI = readJson('../../../../packages/contracts/src/diamondAbi.json');
// The scan's own rules, read from the data file the app imports, so this
// plain-Node drive loads no TypeScript (any Node the repo supports).
const RULES = readJson('../../src/data/bookCatchUpRules.json');
const CHUNK_BLOCKS = BigInt(RULES.chunkBlocks);
const MAX_CATCHUP_BLOCKS = BigInt(RULES.maxCatchUpBlocks);

/**
 * The scan's topic-0 set, derived the way `bookCatchUp.ts` derives it: from
 * the compiled ABI, by EVENT (an error can share a name), over the shared
 * name list. `catchUpTally.test.mjs` checks it equals the app's own set.
 */
export function terminalTopics() {
  return RULES.offerTerminalEvents.map((name) => {
    const ev = DIAMOND_ABI.find((i) => i.type === 'event' && i.name === name);
    if (!ev) throw new Error(`event ${name} not found in the Diamond ABI`);
    return toEventSelector(ev);
  });
}

/** The most chunks one scan can need before the app skips the scan. */
export const MAX_CHUNKS_PER_SCAN = Number((MAX_CATCHUP_BLOCKS + CHUNK_BLOCKS - 1n) / CHUNK_BLOCKS);

const TERMINAL = new Set(terminalTopics().map((t) => t.toLowerCase()));

function quantity(v) {
  if (typeof v !== 'string' || !/^0x[0-9a-fA-F]+$/.test(v)) return null;
  return BigInt(v);
}

/** The block range of a catch-up chunk, or null when `call` is not one. */
export function catchUpRange(call) {
  if (call?.method !== 'eth_getLogs' || !Array.isArray(call.params)) return null;
  const filter = call.params[0];
  const topic0 = filter?.topics?.[0];
  if (!Array.isArray(topic0) || topic0.length !== TERMINAL.size) return null;
  const asked = new Set(topic0.map((t) => String(t).toLowerCase()));
  if (asked.size !== TERMINAL.size || ![...asked].every((t) => TERMINAL.has(t))) return null;
  const from = quantity(filter.fromBlock);
  const to = quantity(filter.toBlock);
  // A chunk the drive cannot place is counted as an ordinary call: it stays
  // inside the budget's raw count, which is the conservative direction.
  if (from === null || to === null || to < from) return null;
  return { from, to };
}

/**
 * @param {Array<{ method?: string, params?: unknown, outcome?: 'ok' | 'failed' }>} calls
 *   every JSON-RPC call the page made in the window, in the order the
 *   requests started, each with the outcome the drive observed for it
 *   (`createCallLedger`). Anything but `ok` is a failed attempt.
 */
export function tallyCalls(calls) {
  const counts = {};
  const runs = [];
  /** next expected `from` → open runs waiting on it */
  const open = new Map();
  let chunks = 0;
  /** method → attempts that failed (each may have been retried once). */
  const failedCounts = {};
  const oversized = [];
  const continuable = (run, r) => {
    if (r.to - r.from + 1n !== CHUNK_BLOCKS) return;
    const next = String(r.to + 1n);
    if (!open.has(next)) open.set(next, []);
    open.get(next).push(run);
  };
  for (const call of calls) {
    if (!call?.method) continue;
    counts[call.method] = (counts[call.method] ?? 0) + 1;
    if (call.outcome !== 'ok') failedCounts[call.method] = (failedCounts[call.method] ?? 0) + 1;
    const r = catchUpRange(call);
    if (!r) continue;
    chunks += 1;
    if (r.to - r.from + 1n > CHUNK_BLOCKS) oversized.push(`${r.from}–${r.to}`);
    const failed = call.outcome !== 'ok';
    const key = String(r.from);
    const waiting = open.get(key);
    let run;
    if (waiting && waiting.length > 0) {
      run = waiting.shift();
      if (waiting.length === 0) open.delete(key);
    } else {
      run = { from: r.from, to: r.to, chunks: 0 };
      runs.push(run);
    }
    run.chunks += 1;
    run.to = r.to;
    // Only a FULL-WIDTH window that SUCCEEDED can be followed by another of
    // the same scan: the app's loop cuts a window short only at the scan's
    // end, and stops at a window that fails (`chunkedGetLogs`). So a short or
    // failed window closes its run, and a later scan that happens to start
    // one block after it starts a run of its own.
    if (!failed) continuable(run, r);
  }
  const total = Object.values(counts).reduce((a, n) => a + n, 0);
  // The fewest scans a correct page could have issued to produce each run.
  const charge = (run) => Math.ceil(run.chunks / MAX_CHUNKS_PER_SCAN);
  const scansCharged = runs.reduce((a, run) => a + charge(run), 0);
  const failed = Object.values(failedCounts).reduce((a, n) => a + n, 0);
  const budgetedCalls = total - chunks + scansCharged;
  return {
    counts,
    failedCounts,
    total,
    /** The budgeted figure: every call, with each run of catch-up chunks
     *  charged as the fewest scans that produce it. */
    budgeted: budgetedCalls,
    /** The certain floor under `budgeted`: the transport retries a failed
     *  attempt at most once, so at most `failed` of the budgeted units can
     *  be retries rather than the page's own choice. */
    budgetedFloor: Math.max(0, budgetedCalls - failed),
    catchUp: {
      chunks,
      scansCharged,
      runs: runs.map((run) => ({ from: run.from, to: run.to, chunks: run.chunks, scans: charge(run) })),
      oversized,
      /** Runs longer than one scan may be: a scan past the skip cap, or
       *  adjacent scans the wire cannot separate. Unresolved, not a FAIL. */
      longRuns: runs
        .filter((run) => run.chunks > MAX_CHUNKS_PER_SCAN)
        .map((run) => `${run.from}–${run.to} (${run.chunks} windows)`),
    },
  };
}

/**
 * A ledger of every JSON-RPC call the page sends, in the shape the shared
 * observer `attachLedger` (`pageSanctionsReads.mjs`) feeds over HTTP AND
 * WebSocket, so a deployment whose RPC rides a socket is audited too
 * (#2710 r4). Only chain calls are recorded (`isChainRpcMethod`), and only
 * while `isRecording()` holds; each gets its `outcome` when its answer (or
 * the lack of one) is known.
 *
 * The outcome is the shared classifier's verdict on the pair
 * (`classifyRpcResponse`, `rpc-verdict.mjs`), not a rule of this ledger's
 * own (#1633):
 *   - `ok` — the page received an answer it can use: a result, or a revert
 *     from a call that executes code.
 *   - `client-fault` — a reachable provider parsed the page's request and
 *     refused it as malformed, whatever the HTTP status. A defect in what
 *     the page sent, carried with its `why`.
 *   - `failed` — anything else: no answer, a status the page cannot see
 *     past, a rate limit, a body that is not JSON-RPC.
 */
export function createCallLedger(isRecording = () => true) {
  const calls = [];
  // The budget is about CHAIN RPC, so the ledger records the Ethereum
  // JSON-RPC namespaces and nothing else. Another JSON-RPC protocol on the
  // same observer — WalletConnect's `irn_*` relay is the one this app
  // carries — is not chain traffic and is not counted (#2710 r5). Write
  // detection does not depend on this: `attachLedger` judges every socket
  // frame against the read list itself.
  const asList = (v) => (Array.isArray(v) ? v : [v]);
  return {
    calls,
    onRequest(bodyText) {
      if (!isRecording()) return null;
      let sent;
      try {
        sent = asList(JSON.parse(bodyText ?? 'null'));
      } catch {
        return null;
      }
      const pending = new Map();
      for (const c of sent) {
        if (!c || !isChainRpcMethod(c.method)) continue;
        const call = { method: c.method, params: c.params, outcome: undefined };
        calls.push(call);
        if (!pending.has(c.id)) pending.set(c.id, []);
        pending.get(c.id).push(call);
      }
      return pending.size > 0 ? pending : null;
    },
    /** `bodyText` null = no usable response: every pending call failed. */
    onResponse(pending, bodyText, { status = null, requestBody } = {}) {
      // A socket answer carries no HTTP status; it was delivered.
      const verdicts =
        bodyText == null ? [] : classifyRpcResponse(status ?? 200, bodyText, requestBody);
      // Ids compared by VALUE: an envelope fault can carry an object or
      // boolean id the page sent, and two parses of an object never match
      // by identity (#1633 r3).
      const sameId = (a, b) => JSON.stringify(a) === JSON.stringify(b);
      for (const [id, list] of pending) {
        // A call sent without an id (a malformed envelope can lack one) is
        // matched by that absence.
        const v = verdicts.find((o) => sameId(o.id, id));
        const outcome = v?.verdict === 'ok' || v?.verdict === 'client-fault' ? v.verdict : 'failed';
        for (const call of list) {
          call.outcome = outcome;
          if (outcome === 'client-fault') call.why = v.why;
        }
      }
    },
  };
}

export { CHUNK_BLOCKS };
