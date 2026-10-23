// RPC diet live audit — parks an ANONYMOUS visitor on the deployed
// Offer Book for 60s and tallies every JSON-RPC request the page
// issues. Read-only; sends nothing. Keyless: no wallet is injected, so
// the page is the disconnected visitor the budget was written for (it
// launched the `lender` role, pre-authorized, until #2097 — a connected
// session the header never described, and a key this read never needed).
//
// Budget (steady state after the diet): up to two 30s interval ticks
// in the window, each costing one eth_blockNumber (catch-up head
// read) + one catch-up SCAN (terminal-event eth_getLogs), plus
// initial-load stragglers. The pre-diet defect measured ~85
// eth_blockNumber + ~19 eth_getLogs in 100s — an order of magnitude
// over budget, so the thresholds cleanly separate regression from
// timing noise.
//
// A scan's eth_getLogs count grows with the indexer's lag by design
// (serialized 1000-block windows over the un-ingested tail), so the
// budget charges each run of windows as the fewest SCANS that produce it
// and holds the windows to the app's own rules separately — see
// `catchUpTally.mjs` (#2097). The figure is the page's own traffic, never
// a lag read at another moment. Calls are observed over HTTP and
// WebSocket alike. A write the read-only session had to abort, or one sent
// on a socket, is a FAIL; a run the wire cannot attribute is UNRESOLVED.
import { READ_METHODS, SITE, blocked, launch, visit } from './driver.mjs';
import { attachLedger } from './pageSanctionsReads.mjs';
import { splitBlocked } from './readOnlyFindings.mjs';
import { CHUNK_BLOCKS, MAX_CHUNKS_PER_SCAN, createCallLedger, tallyCalls } from './catchUpTally.mjs';

const BUDGET_TOTAL = 12; // all JSON-RPC calls in the 60s window
const BUDGET_BLOCKNUMBER = 5;

// A THROWAWAY profile: a persisted wagmi / WalletConnect session in a reused
// profile would reconnect the page and audit a different query set than the
// disconnected visitor the budget describes (#2710 r6).
const { page, done, blockedRequests } = await launch({
  role: 'public',
  keyless: true,
  readOnly: true,
  freshProfile: true,
});
let fails = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) fails++;
};

// Every JSON-RPC call the page sends in the window, over HTTP AND WebSocket,
// in the order the requests started (the tally groups catch-up windows by
// that order), each with the outcome the wire showed for it. One shared
// observer (`attachLedger`) feeds it, so an RPC transport on a socket is
// audited like an HTTP one, and a write sent on a socket — the one door the
// read-only route guard does not cover — is reported (#2710 r4).
//
// Attributed by when the REQUEST started, not when its answer arrived
// (Codex #1621 r9): an 8s warm-up request can land after recording starts,
// and a request made near the end can land after it stops.
let recording = false;
const ledger = createCallLedger(() => recording);
const { wsViolations } = attachLedger(page, ledger, READ_METHODS);
const { calls } = ledger;

await visit(page, '/offers');
await page.waitForTimeout(8_000); // initial hydration outside the window
recording = true;
console.log('recording 60s of steady-state traffic…');
await page.waitForTimeout(60_000);
recording = false;

// Let calls still in flight be answered. Bounded, because a request that
// never answers must not hang the drive — and one still unanswered after the
// grace period delivered nothing to the page: it failed (Codex #1621 r10).
const settleBy = Date.now() + 15_000;
while (calls.some((c) => c.outcome === undefined) && Date.now() < settleBy) {
  await page.waitForTimeout(500);
}
for (const c of calls) c.outcome ??= 'failed';

// Successful JSON-RPC answers the PAGE actually received, from its own
// traffic (Codex #1621 r7). Probing the DRIVER's endpoint instead passed on
// a preview built against a dead custom endpoint: the served SPA picks its
// RPC at build time. This is also the FLOOR both budgets lack — they are
// ceilings, and with the chain unreachable the tally is 0, comfortably
// "within budget".
const rpcOk = calls.filter((c) => c.outcome === 'ok').length;
const tally = tallyCalls(calls);
const { counts, failedCounts, total, budgeted, budgetedFloor, catchUp } = tally;
console.log('tally:', JSON.stringify(counts), `| successful rpc responses: ${rpcOk} | failed attempts: ${JSON.stringify(failedCounts)}`);
console.log(
  `catch-up: ${catchUp.chunks} eth_getLogs, charged as ${catchUp.scansCharged} scan(s)` +
    (catchUp.runs.length
      ? ` — ${catchUp.runs.map((x) => `${x.from}–${x.to}: ${x.chunks} window(s) = ${x.scans} scan(s)`).join(', ')}`
      : ''),
);
// ONE verdict, decided at the end: FAIL > UNRESOLVED > PASS. Nothing exits
// early, so an UNRESOLVED reason can never hide a defect the drive had
// already observed — a write the read-only session aborted fails the run even
// when no RPC succeeded (#2710 r3).
const unresolved = [];

// No SUCCESSFUL RPC in the window means there was no RPC behaviour to
// audit — UNRESOLVED, not a budget PASS (Codex #1621 r7). The budgets are
// CEILINGS: an unreachable or misconfigured chain endpoint scores zero and
// would otherwise pass them, so they are not judged at all.
if (rpcOk === 0) {
  unresolved.push(
    'the page received no successful JSON-RPC response in the 60s window, so' +
      ' there was no RPC behaviour to audit. The budgets are CEILINGS: an' +
      ' unreachable or misconfigured chain endpoint scores zero and would' +
      ' otherwise pass them.',
  );
} else {
  // A budget FAILS only when even its certain floor is over: the page's
  // transport retries a failed attempt at most once, so attempts that failed
  // may account for that many extra calls the page did not choose. Over the
  // budget but within it once those are discounted is UNRESOLVED (#2710 r6).
  const budget = (name, value, floor, limit) => {
    if (value <= limit) return check(`${name} (${value} <= ${limit})`, true);
    if (floor <= limit) {
      console.log(`UNRESOLVED ${name} (${value} > ${limit}, but ${floor} <= ${limit} once failed attempts are discounted)`);
      unresolved.push(
        `${name}: ${value} is over ${limit}, but attempts failed in the window and the transport retries` +
          ` them, so the page's own calls may be as few as ${floor}. Re-run against a healthy endpoint.`,
      );
      return;
    }
    check(`${name} (${floor} > ${limit} even with every failed attempt discounted)`, false);
  };
  budget(
    `JSON-RPC calls within budget, each catch-up run charged as the fewest scans that produce it (${total} raw)`,
    budgeted,
    budgetedFloor,
    BUDGET_TOTAL,
  );
  const blockNumbers = counts['eth_blockNumber'] ?? 0;
  budget(
    'eth_blockNumber within budget',
    blockNumbers,
    Math.max(0, blockNumbers - (failedCounts['eth_blockNumber'] ?? 0)),
    BUDGET_BLOCKNUMBER,
  );
  // The diet must not blank the surface it protects.
  const body = await page.locator('body').innerText();
  check('book still renders', body.length > 300);
}
// The scan's shape, held to the app's own rules (`bookCatchUp.ts`). One
// window is one request, so this is certain whether or not it succeeded.
check(
  `every catch-up window is at most ${CHUNK_BLOCKS} blocks`,
  catchUp.oversized.length === 0,
  catchUp.oversized.join(', '),
);
// A run of catch-up windows longer than one scan may be is either a scan
// past the skip cap or adjacent scans the wire cannot separate
// (`catchUpTally.mjs`), so it is never a product FAIL on its own — but it is
// not a PASS either.
if (catchUp.longRuns.length > 0) {
  unresolved.push(
    `catch-up run(s) longer than one scan may be (${MAX_CHUNKS_PER_SCAN} windows): ` +
      `${catchUp.longRuns.join(', ')}. Either the page scanned past the skip cap, or` +
      ' adjacent scans met exactly where the indexer cursor landed; the wire cannot' +
      ' say which, so look at the page before trusting a PASS.',
  );
}

// A read-only session that had to ABORT a write the page attempted has
// found a defect, whatever else held (#2710 r2). Read after the teardown,
// so an attempt made while the context closes still counts.
await done();
const violations = [...splitBlocked(blockedRequests ?? [], [SITE]).violations, ...wsViolations];
check(
  'the page attempted no write in a read-only session',
  violations.length === 0,
  violations.map((v) => v.reason).join(' | ').slice(0, 300),
);

if (fails > 0) {
  console.log(`${fails} FAILURES${unresolved.length ? ` (also unresolved: ${unresolved.length})` : ''}`);
  process.exit(1);
}
if (unresolved.length > 0) await blocked(unresolved.join('\n  '));
console.log('ALL PASS');
process.exit(0);
