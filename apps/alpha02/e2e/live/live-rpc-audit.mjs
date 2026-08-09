// RPC diet live audit — parks an ANONYMOUS visitor on the deployed
// Offer Book for 60s and tallies every JSON-RPC request the page
// issues. Read-only; sends nothing.
//
// Budget (steady state after the diet): up to two 30s interval ticks
// in the window, each costing one eth_blockNumber (catch-up head
// read) + one eth_getLogs (terminal-event scan), plus initial-load
// stragglers. The pre-diet defect measured ~85 eth_blockNumber +
// ~19 eth_getLogs in 100s — an order of magnitude over budget, so
// the thresholds cleanly separate regression from timing noise.
import { blocked, launch, visit } from './driver.mjs';

const BUDGET_TOTAL = 12; // all JSON-RPC calls in the 60s window
const BUDGET_BLOCKNUMBER = 5;

const { page, done } = await launch({ role: 'lender' });
let fails = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) fails++;
};

const counts = {};
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
const bodyReads = [];
page.on('response', (res) => {
  const req = res.request();
  if (!recordedRequests.has(req) || res.status() !== 200) return;
  // Playwright fires `response` on HEADERS and does not await handlers,
  // so the body read is still in flight; collect the promises and settle
  // them before the floor is judged, or a slow body reads as "no
  // successful RPC".
  bodyReads.push(
    res
      .text()
      .then((text) => {
        const parsed = JSON.parse(text);
        for (const r of Array.isArray(parsed) ? parsed : [parsed]) {
          // A JSON-RPC envelope carrying a result, not an error object.
          if (r && r.jsonrpc && r.error === undefined && r.result !== undefined) rpcOk++;
        }
      })
      .catch(() => {
        /* not a JSON-RPC response body, or the body never arrived */
      }),
  );
});
page.on('request', (req) => {
  if (!recording) return;
  const body = req.postData();
  if (!body) return;
  recordedRequests.add(req);
  try {
    const parsed = JSON.parse(body);
    for (const call of Array.isArray(parsed) ? parsed : [parsed]) {
      if (call?.method) counts[call.method] = (counts[call.method] ?? 0) + 1;
    }
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

// Settle the in-flight body reads before judging the floor.
await Promise.allSettled(bodyReads);

const total = Object.values(counts).reduce((a, n) => a + n, 0);
console.log('tally:', JSON.stringify(counts), `| successful rpc responses: ${rpcOk}`);
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
check(`total JSON-RPC calls within budget (${total} <= ${BUDGET_TOTAL})`, total <= BUDGET_TOTAL);
check(
  `eth_blockNumber within budget (${counts['eth_blockNumber'] ?? 0} <= ${BUDGET_BLOCKNUMBER})`,
  (counts['eth_blockNumber'] ?? 0) <= BUDGET_BLOCKNUMBER,
);
// The diet must not blank the surface it protects.
const body = await page.locator('body').innerText();
check('book still renders', body.length > 300);

console.log(fails === 0 ? 'ALL PASS' : `${fails} FAILURES`);
await done();
process.exit(fails === 0 ? 0 : 1);
