/** RPC diet — the app must not continuously poll the chain RPC.
 *
 *  The production measurement that motivated this (see the PR): with
 *  no WebSocket RPC configured, LiveChainSync's HTTP fallback burned
 *  an eth_blockNumber every ~1.2s and its per-block invalidations
 *  dragged the book's nominal 30s cycle down to ~5s — ~3,700 RPC
 *  calls/hour per open tab, wallet or not.
 *
 *  This harness (like today's production deploys) configures no WS
 *  URL, so the block watcher must not mount at all: a visitor parked
 *  on the Offer Book issues NO steady-stream block polling — the only
 *  chain traffic is the 30s interval cycle (one head read + one
 *  catch-up log scan per tick). The thresholds below distinguish "a
 *  straggling interval tick landed inside the window" (fine, ≤2) from
 *  "a block watcher is polling" (~12+ in the window) without being
 *  timing-flaky.
 */
import { test, expect } from '../lib/wallet-fixture';

test('parked book visitor does not stream RPC polls', async ({
  launchWallet,
}) => {
  const { page } = await launchWallet('lender');

  const counts: Record<string, number> = {};
  let recording = false;
  // viem's implicit default RPC for chain 1 (ENS reads) — the app must
  // NEVER reach it: the ENS transport is explicitly configured
  // (VITE_ETHEREUM_RPC_URL plumbing), and the shared default endpoint
  // 429s under a list page's first-paint lookup burst.
  let merkleHits = 0;
  page.on('request', (req) => {
    // Hostname compare, not substring (CodeQL js/incomplete-url-
    // substring-sanitization): the guard must not be satisfiable by
    // e.g. a path or query merely containing the string.
    try {
      if (new URL(req.url()).hostname === 'eth.merkle.io') merkleHits++;
    } catch {
      /* non-URL request target */
    }
    if (!recording) return;
    const body = req.postData();
    if (!body) return;
    try {
      const parsed = JSON.parse(body) as unknown;
      for (const call of Array.isArray(parsed) ? parsed : [parsed]) {
        const method = (call as { method?: string })?.method;
        if (method) counts[method] = (counts[method] ?? 0) + 1;
      }
    } catch {
      /* not JSON-RPC */
    }
  });

  await page.goto('/offers', { waitUntil: 'domcontentloaded' });
  // The book must actually render — a diet that blanks the page would
  // pass the counters for the wrong reason. Level-pinned: the loading
  // state's <h3>"Loading the offer book…"</h3> also matches a bare
  // /offer book/i name filter (strict-mode violation on first run).
  await expect(
    page.getByRole('heading', { level: 1, name: 'Offer Book' }),
  ).toBeVisible();
  // Let initial hydration (offers pages + first catch-up) finish
  // before the measurement window opens.
  await page.waitForTimeout(5_000);
  recording = true;
  await page.waitForTimeout(15_000);
  recording = false;

  // No WS ⇒ no block watcher. A watcher polling at even viem's
  // nominal 4s would log ≥3 in 15s; the old defect logged ~12.
  expect(counts['eth_blockNumber'] ?? 0).toBeLessThanOrEqual(2);
  // At most one interval tick can land in the window; each tick runs
  // one chunked log scan.
  expect(counts['eth_getLogs'] ?? 0).toBeLessThanOrEqual(2);
  // Whole-run assertion (not just the recording window): zero calls to
  // viem's implicit chain-1 default. A hit means the ENS transport
  // regressed to `http(undefined)`.
  expect(merkleHits).toBe(0);
});
