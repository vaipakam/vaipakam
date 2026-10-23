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
// budget counts each SCAN once and holds the scan's shape to the app's
// own rules separately — see `catchUpTally.mjs` (#2097). The figure is
// the page's own traffic, never a lag read at another moment.
import { blocked, launch, visit } from './driver.mjs';
import { CHUNK_BLOCKS, MAX_CHUNKS_PER_SCAN, tallyCalls } from './catchUpTally.mjs';

const BUDGET_TOTAL = 12; // all JSON-RPC calls in the 60s window
const BUDGET_BLOCKNUMBER = 5;

const { page, done } = await launch({ role: 'public', keyless: true, readOnly: true });
let fails = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) fails++;
};

// Every JSON-RPC call recorded in the window, in the order the requests
// started — the tally groups catch-up chunks by that order.
const calls = [];
let recording = false;
// Successful JSON-RPC responses the PAGE actually received, counted from
// its own traffic (Codex #1621 r7).
//
// My first attempt at this probed `clientsFor(84532)` — the DRIVER's
// endpoint. The served SPA picks its RPC at build time
// (VITE_BASE_SEPOLIA_RPC_URL), so a preview built against a dead custom
// endpoint passed that probe on the driver's healthy default while every
// page request was still aborted. The check has to observe the endpoint
// the page uses, and the only reliable way to know which that is, is to
// watch what the page does.
//
// This is also the FLOOR both budgets lack. They are ceilings: with the
// chain unreachable the tally is 0, comfortably "within budget", and the
// error shell clears the weak body-length check — exit 0, batch prints
// PASS, nothing audited.
let rpcOk = 0;
// Attributed by when the REQUEST started, not when its response arrived
// (Codex #1621 r9), matching how the budgets above count. Keyed on the
// request object because the two clocks genuinely disagree: an 8s
// warm-up request can land after `recording` flips on — satisfying the
// floor while every request made INSIDE the window failed — and a
// request made near the end can land after it flips off, producing a
// false BLOCKED. Same request-owns-its-outcome discipline live-ux-sweep
// uses for its per-route network attribution.
const recordedRequests = new WeakSet();
// Recorded requests still awaiting a `response` event. A request started
// near the end of the window may not have emitted one when the window
// closes, so snapshotting `bodyReads` right then omits it — and if that
// late response is the window's only success, the floor reads zero and
// the audit falsely BLOCKS (Codex #1621 r10).
const awaitingResponse = new Set();
const bodyReads = [];
// The calls each recorded request carried, so its observed OUTCOME can be
// written onto them. The tally discounts a repeated catch-up window as a
// retry only when the earlier attempt was observed to fail (#2710 r1), so
// the outcome comes from the wire, never from a range coincidence.
const callsOf = new WeakMap();
const markAll = (req, outcome) => {
  for (const c of callsOf.get(req) ?? []) c.outcome = outcome;
};
page.on('response', (res) => {
  const req = res.request();
  if (!recordedRequests.has(req)) return;
  awaitingResponse.delete(req);
  if (res.status() !== 200) {
    markAll(req, 'failed');
    return;
  }
  // Playwright fires `response` on HEADERS and does not await handlers,
  // so the body read is still in flight; collect the promises and settle
  // them before the floor is judged, or a slow body reads as "no
  // successful RPC".
  bodyReads.push(
    res
      .text()
      .then((text) => {
        const parsed = JSON.parse(text);
        const sent = callsOf.get(req) ?? [];
        for (const r of Array.isArray(parsed) ? parsed : [parsed]) {
          // A JSON-RPC envelope carrying a result, not an error object.
          const ok = Boolean(r && r.jsonrpc && r.error === undefined && r.result !== undefined);
          if (ok) rpcOk++;
          // The call this envelope answers: by id, or the only one sent.
          const call = sent.length === 1 ? sent[0] : sent.find((c) => c.id !== undefined && c.id === r?.id);
          if (call && r?.jsonrpc) call.outcome = ok ? 'ok' : 'failed';
        }
      })
      .catch(() => {
        /* not a JSON-RPC response body, or the body never arrived */
      }),
  );
});
// A failed request never emits `response`, so it would otherwise sit in
// `awaitingResponse` for the whole grace period. Registered up front with
// the other handlers — registering it after the wait loop, as I first
// wrote it, meant it could not drain anything during that loop.
page.on('requestfailed', (req) => {
  awaitingResponse.delete(req);
  markAll(req, 'failed');
});
page.on('request', (req) => {
  if (!recording) return;
  const body = req.postData();
  if (!body) return;
  recordedRequests.add(req);
  awaitingResponse.add(req);
  try {
    const parsed = JSON.parse(body);
    const sent = [];
    for (const call of Array.isArray(parsed) ? parsed : [parsed]) {
      if (!call?.method) continue;
      const recorded = { method: call.method, params: call.params, id: call.id };
      calls.push(recorded);
      sent.push(recorded);
    }
    callsOf.set(req, sent);
  } catch {
    /* not JSON-RPC */
  }
});

await visit(page, '/offers');
await page.waitForTimeout(8_000); // initial hydration outside the window
recording = true;
console.log('recording 60s of steady-state traffic…');
await page.waitForTimeout(60_000);
recording = false;

// Let requests still in flight emit their response, THEN settle the body
// reads. Bounded, because a request that never answers must not hang the
// drive — and a request still unanswered after the grace period did not
// contribute a success anyway (Codex #1621 r10).
const settleBy = Date.now() + 15_000;
while (awaitingResponse.size > 0 && Date.now() < settleBy) {
  await page.waitForTimeout(500);
}
await Promise.allSettled(bodyReads);
// A request still unanswered after the grace period delivered nothing: it
// failed, as far as the page was concerned.
for (const req of awaitingResponse) markAll(req, 'failed');

const tally = tallyCalls(calls);
const { counts, total, budgeted, catchUp } = tally;
console.log('tally:', JSON.stringify(counts), `| successful rpc responses: ${rpcOk}`);
console.log(
  `catch-up: ${catchUp.chunks} eth_getLogs in ${catchUp.scans.length} scan(s)` +
    (catchUp.retries ? `, ${catchUp.retries} of them retries` : '') +
    (catchUp.scans.length
      ? ` — ${catchUp.scans.map((x) => `${x.from}–${x.to} in ${x.chunks}`).join(', ')}`
      : ''),
);
// No SUCCESSFUL RPC in the window means there was no RPC behaviour to
// audit — BLOCKED, not a budget PASS (Codex #1621 r7).
if (rpcOk === 0) {
  await blocked(
    'the page received no successful JSON-RPC response in the 60s window, so' +
      ' there was no RPC behaviour to audit. The budgets below are CEILINGS —' +
      ' an unreachable or misconfigured chain endpoint scores zero and would' +
      ' otherwise pass them.',
  );
}
check(
  `JSON-RPC calls within budget, each catch-up scan counted once (${budgeted} <= ${BUDGET_TOTAL}; ${total} raw)`,
  budgeted <= BUDGET_TOTAL,
);
check(
  `eth_blockNumber within budget (${counts['eth_blockNumber'] ?? 0} <= ${BUDGET_BLOCKNUMBER})`,
  (counts['eth_blockNumber'] ?? 0) <= BUDGET_BLOCKNUMBER,
);
// The scan's shape, held to the app's own rules (`bookCatchUp.ts`).
check(
  `every catch-up window is at most ${CHUNK_BLOCKS} blocks`,
  catchUp.oversized.length === 0,
  catchUp.oversized.join(', '),
);
check(
  `no catch-up scan runs past the skip cap (${MAX_CHUNKS_PER_SCAN} windows)`,
  catchUp.overlong.length === 0,
  catchUp.overlong.join(', '),
);
// The diet must not blank the surface it protects.
const body = await page.locator('body').innerText();
check('book still renders', body.length > 300);

console.log(fails === 0 ? 'ALL PASS' : `${fails} FAILURES`);
await done();
process.exit(fails === 0 ? 0 : 1);
