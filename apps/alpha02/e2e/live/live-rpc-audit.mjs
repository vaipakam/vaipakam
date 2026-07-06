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
import { launch, SITE } from './driver.mjs';

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
page.on('request', (req) => {
  if (!recording) return;
  const body = req.postData();
  if (!body) return;
  try {
    const parsed = JSON.parse(body);
    for (const call of Array.isArray(parsed) ? parsed : [parsed]) {
      if (call?.method) counts[call.method] = (counts[call.method] ?? 0) + 1;
    }
  } catch {
    /* not JSON-RPC */
  }
});

await page.goto(SITE + '/offers', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(8_000); // initial hydration outside the window
recording = true;
console.log('recording 60s of steady-state traffic…');
await page.waitForTimeout(60_000);
recording = false;

const total = Object.values(counts).reduce((a, n) => a + n, 0);
console.log('tally:', JSON.stringify(counts));
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
