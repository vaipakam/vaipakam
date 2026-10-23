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
 *     book's terminal-event set (`offerTerminalTopics()`, imported, so the
 *     two cannot drift). Nothing else in the app asks for that set.
 *   - Chunks are grouped into SCANS: a chunk starting one block after an
 *     open scan's last chunk continues it; any other chunk starts a scan.
 *     Two refetches whose scans interleave are kept apart because each
 *     continuation is matched to exactly one open scan, and a retry (the
 *     same range as a scan's latest chunk) stays with that scan.
 *     Only a full-width chunk can be continued, because the app cuts a
 *     window short only at a scan's end.
 *     TWO LIMITS, stated, both of them about requests the wire cannot tell
 *     apart (#1672 records why): a later scan that starts exactly one block
 *     after an earlier scan's last chunk, when that chunk was itself exactly
 *     full width, is read as its continuation; and two scans issued at once
 *     over the identical range read as one scan and a retry. Each costs one
 *     call in the lenient direction, and only on that exact coincidence.
 *   - The BUDGET counts each scan once, as the steady-state design does
 *     ("one eth_getLogs per tick"), so it audits how often the page scans,
 *     whatever the lag.
 *   - The SCAN SHAPE is then held to the app's own rules: no chunk wider
 *     than `CHUNK_BLOCKS`, no scan longer than `MAX_CATCHUP_BLOCKS` allows.
 *     A page that scanned in oversized windows, or kept scanning past the
 *     skip cap, fails on that rule rather than hiding inside a lag excuse.
 *
 * Pure: `catchUpTally.test.mjs` pins it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toEventSelector } from 'viem';
import { CHUNK_BLOCKS, MAX_CATCHUP_BLOCKS, OFFER_TERMINAL_EVENTS } from '../../src/data/bookCatchUpRules.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIAMOND_ABI = JSON.parse(
  fs.readFileSync(path.resolve(HERE, '../../../../packages/contracts/src/diamondAbi.json'), 'utf8'),
);

/**
 * The scan's topic-0 set, derived the way `bookCatchUp.ts` derives it: from
 * the compiled ABI, by EVENT (an error can share a name), over the shared
 * name list. `catchUpTally.test.mjs` checks it equals the app's own set.
 */
export function terminalTopics() {
  return OFFER_TERMINAL_EVENTS.map((name) => {
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
 * @param {Array<{ method?: string, params?: unknown }>} calls every JSON-RPC
 *   call the page made in the window, in the order the requests started.
 */
export function tallyCalls(calls) {
  const counts = {};
  const scans = [];
  /** next expected `from` → open scans waiting on it */
  const open = new Map();
  let chunks = 0;
  let retries = 0;
  const oversized = [];
  for (const call of calls) {
    if (!call?.method) continue;
    counts[call.method] = (counts[call.method] ?? 0) + 1;
    const r = catchUpRange(call);
    if (!r) continue;
    chunks += 1;
    if (r.to - r.from + 1n > CHUNK_BLOCKS) oversized.push(`${r.from}–${r.to}`);
    // A RETRY repeats the range of a scan's latest chunk exactly (the
    // transport retries a failed request with the same body). It belongs to
    // that scan and does not advance it.
    const retried = scans.find((s) => s.lastFrom === r.from && s.to === r.to);
    if (retried) {
      retries += 1;
      continue;
    }
    const key = String(r.from);
    const waiting = open.get(key);
    let scan;
    if (waiting && waiting.length > 0) {
      scan = waiting.shift();
      if (waiting.length === 0) open.delete(key);
    } else {
      scan = { from: r.from, to: r.to, lastFrom: r.from, chunks: 0 };
      scans.push(scan);
    }
    scan.chunks += 1;
    scan.lastFrom = r.from;
    scan.to = r.to;
    // Only a FULL-WIDTH chunk can be followed by another of the same scan:
    // the app's loop cuts a window short only at the scan's end
    // (`chunkedGetLogs`). So a short chunk closes its scan, and a later scan
    // that happens to start one block after it is counted as its own.
    if (r.to - r.from + 1n === CHUNK_BLOCKS) {
      const next = String(r.to + 1n);
      if (!open.has(next)) open.set(next, []);
      open.get(next).push(scan);
    }
  }
  const total = Object.values(counts).reduce((a, n) => a + n, 0);
  return {
    counts,
    total,
    /** The budgeted figure: every call, with each catch-up scan counted once. */
    budgeted: total - chunks + scans.length,
    catchUp: {
      chunks,
      retries,
      scans: scans.map((s) => ({ from: s.from, to: s.to, chunks: s.chunks })),
      oversized,
      overlong: scans.filter((s) => s.chunks > MAX_CHUNKS_PER_SCAN).map((s) => `${s.from}–${s.to} (${s.chunks} chunks)`),
    },
  };
}

export { CHUNK_BLOCKS };
