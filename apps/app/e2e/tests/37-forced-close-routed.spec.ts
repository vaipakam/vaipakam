/** #2463 — the lender close-out of a liquid, past-grace loan, ROUTED.
 *
 *  Spec 30 drives the same kind of loan on the standard server, which has
 *  no agent (`VITE_AGENT_ORIGIN` unset), and pins the honest
 *  no-route-service state: the card says the loan is closable and offers
 *  no button. This spec is the other side: a second dev server carries
 *  `VITE_AGENT_ORIGIN` pointed at a spec-local stub that speaks the agent's
 *  `POST /liquidation-route` shape, and the card is asserted in the two
 *  states that depend on the answer, then actually closes the loan out.
 *
 *  The stub builds a REAL try-list, not a canned one: it reads the loan
 *  from the chain and finds the fixture's registered faucet
 *  `MockSwapAdapter` the way `@vaipakam/lib/swapRoutes` does (by
 *  `adapterName()` in `getSwapAdapters()`). So the transaction the card
 *  sends is the one the agent would build on a test network, and the swap
 *  is executed by the contract against a registered adapter. The builder
 *  and the agent handler are pinned by their own vitest suites
 *  (`packages/lib/src/swapRoutes.test.ts`, `apps/agent/test/
 *  liquidationRoute.test.ts`); what is under test here is the card and the
 *  contract call it makes.
 *
 *  Asserted contract:
 *  1. The agent answers with an EMPTY route → the card says no exchange
 *     can quote the sale and offers no button.
 *  2. The agent answers with a route → the card offers the close-out, says
 *     what happens if every route fails, and declares the route state.
 *  3. Submitting sends `triggerDefault(loanId, route)` and the loan leaves
 *     Active as DEFAULTED — the sale went through. FallbackPending would
 *     mean every route failed, and fails the test by name.
 */
import http from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { test, expect } from '../lib/wallet-fixture';
import { postLenderOffer, acceptAsBorrower, newestOfferIdFor, newestLoanIdFor } from '../lib/flows';
import { ANVIL_URL, increaseTime } from '../lib/anvil';
import { pub, DIAMOND, DIAMOND_ABI_VIEM, MOCKS } from '../lib/chain';

const APP_PORT = 4177;
const APP_BASE = `http://127.0.0.1:${APP_PORT}`;
const AGENT_PORT = 8791;
const STUB_PORT = Number(process.env.APP_E2E_STUB_PORT ?? 8788);
const WARP_STEP_SECONDS = 86_400;
const MAX_WARP_STEPS = 40;
const LOAN_STATUS_DEFAULTED = 2;
const LOAN_STATUS_FALLBACK_PENDING = 4;

const MOCK_ADAPTER_ABI = [
  { type: 'function', name: 'adapterName', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
] as const;

let appServer: ChildProcess | undefined;
let agentStub: http.Server | undefined;
/** Per-step answer mode for the stub. */
let routeMode: 'route' | 'empty' = 'empty';
const routeRequests: { chainId: number; loanId: string }[] = [];

/** The try-list the agent's builder produces on a test network: the
 *  registered faucet mock, found by name, with no adapter data. */
async function buildRoute(loanId: string) {
  const loan = (await pub.readContract({
    address: DIAMOND,
    abi: DIAMOND_ABI_VIEM,
    functionName: 'getLoanDetails',
    args: [BigInt(loanId)],
  })) as { collateralAsset: string; principalAsset: string; collateralAmount: bigint };
  const adapters = (await pub.readContract({
    address: DIAMOND,
    abi: DIAMOND_ABI_VIEM,
    functionName: 'getSwapAdapters',
  })) as readonly `0x${string}`[];
  const calls: { adapterIdx: string; data: string }[] = [];
  for (let i = 0; i < adapters.length; i++) {
    const name = await pub
      .readContract({ address: adapters[i], abi: MOCK_ADAPTER_ABI, functionName: 'adapterName' })
      .catch(() => null);
    if (name === 'vaipakam-testnet-mock') calls.push({ adapterIdx: String(i), data: '0x' });
  }
  return {
    sellToken: loan.collateralAsset,
    buyToken: loan.principalAsset,
    sellAmount: loan.collateralAmount.toString(),
    calls,
  };
}

test.beforeAll(async () => {
  agentStub = http.createServer((req, res) => {
    const cors = {
      'Access-Control-Allow-Origin': req.headers.origin ?? '*',
      'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      res.end();
      return;
    }
    if (req.url === '/liquidation-route' && req.method === 'POST') {
      let body = '';
      req.on('data', (c: Buffer) => {
        body += c.toString();
      });
      req.on('end', () => {
        void (async () => {
          const { chainId, loanId } = JSON.parse(body) as { chainId: number; loanId: string };
          routeRequests.push({ chainId, loanId });
          const built = await buildRoute(loanId);
          const calls = routeMode === 'route' ? built.calls : [];
          res.writeHead(200, { ...cors, 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              chainId,
              loanId,
              ...built,
              calls,
              ranked: calls.map(() => ({ kind: 'testnetMock', expectedOutput: '0' })),
              failed: [],
            }),
          );
        })().catch(() => {
          res.writeHead(502, cors);
          res.end();
        });
      });
      return;
    }
    res.writeHead(404, cors);
    res.end();
  });
  await new Promise<void>((resolve) => agentStub!.listen(AGENT_PORT, '127.0.0.1', resolve));

  const stale = await fetch(APP_BASE).then(
    () => true,
    () => false,
  );
  if (stale) throw new Error(`something is already listening on ${APP_BASE}`);
  appServer = spawn(
    'node',
    ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(APP_PORT), '--strictPort'],
    {
      env: {
        ...process.env,
        APP_E2E: '1',
        VITE_DEFAULT_CHAIN_ID: '84532',
        VITE_BASE_SEPOLIA_RPC_URL: ANVIL_URL,
        VITE_INDEXER_ORIGIN: `http://127.0.0.1:${STUB_PORT}`,
        VITE_AGENT_ORIGIN: `http://127.0.0.1:${AGENT_PORT}`,
      },
      stdio: 'ignore',
    },
  );
  const deadline = Date.now() + 120_000;
  for (;;) {
    if (appServer.exitCode !== null) throw new Error(`routed vite exited with ${appServer.exitCode}`);
    try {
      if ((await fetch(APP_BASE)).status < 500) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error('routed vite not ready');
    await new Promise((r) => setTimeout(r, 500));
  }
});

test.afterAll(async () => {
  appServer?.kill('SIGTERM');
  await new Promise<void>((resolve) => (agentStub ? agentStub.close(() => resolve()) : resolve()));
});

test('a routed close-out of a liquid, past-grace loan', async ({ launchWallet }) => {
  const lender = await launchWallet('lender');
  await postLenderOffer(lender.page);
  const offerId = await newestOfferIdFor(lender.account.address);
  await lender.ctx.close();

  const borrower = await launchWallet('borrower');
  await acceptAsBorrower(borrower.page, offerId);
  const loanId = await newestLoanIdFor(borrower.account.address, 'borrower');
  await borrower.ctx.close();

  // Preconditions, from the chain (same reasoning as spec 30): liquid
  // collateral, so the swap branch demands a try-list; and a fixture
  // that registers the faucet mock, so a route exists to send.
  const liquidity = await pub.readContract({
    address: DIAMOND,
    abi: DIAMOND_ABI_VIEM,
    functionName: 'checkLiquidity',
    args: [MOCKS!.liquidToken as `0x${string}`],
  });
  expect(Number(liquidity)).toBe(0);
  expect((await buildRoute(String(loanId))).calls.length).toBeGreaterThan(0);

  // Past maturity and grace — stepped, asking the chain after each step.
  const loan = (await pub.readContract({
    address: DIAMOND,
    abi: DIAMOND_ABI_VIEM,
    functionName: 'getLoanDetails',
    args: [loanId],
  })) as { startTime: bigint; durationDays: bigint };
  const now = (await pub.getBlock()).timestamp;
  await increaseTime(Number(loan.startTime + loan.durationDays * 86_400n - now) + 60);
  const defaultable = () =>
    pub.readContract({
      address: DIAMOND,
      abi: DIAMOND_ABI_VIEM,
      functionName: 'isLoanDefaultable',
      args: [loanId],
    }) as Promise<boolean>;
  let ok = await defaultable();
  for (let i = 0; i < MAX_WARP_STEPS && !ok; i++) {
    await increaseTime(WARP_STEP_SECONDS);
    ok = await defaultable();
  }
  expect(ok).toBe(true);
  const [matchCandidate] = (await pub.readContract({
    address: DIAMOND,
    abi: DIAMOND_ABI_VIEM,
    functionName: 'hasInternalMatchCandidate',
    args: [loanId],
  })) as readonly [boolean, bigint];
  expect(matchCandidate).toBe(false);

  // ---- 1. The agent answers with no route ----
  routeMode = 'empty';
  const noRoute = await launchWallet('lender', { advanced: true });
  await noRoute.page.goto(`${APP_BASE}/positions/${loanId}`, { waitUntil: 'domcontentloaded' });
  const card1 = noRoute.page.getByTestId('forced-close-card');
  await expect(card1).toHaveAttribute('data-forced-close-state', 'ready-needs-route', { timeout: 60_000 });
  await expect(card1).toHaveAttribute('data-forced-close-route', 'none', { timeout: 60_000 });
  await expect(card1.getByText(/no exchange can quote that sale/i)).toBeVisible();
  await expect(noRoute.page.getByTestId('forced-close-submit')).toHaveCount(0);
  expect(routeRequests.some((r) => r.loanId === String(loanId) && r.chainId === 84532)).toBe(true);
  await noRoute.ctx.close();

  // ---- 2. The agent answers with a route ----
  routeMode = 'route';
  const routed = await launchWallet('lender', { advanced: true });
  await routed.page.goto(`${APP_BASE}/positions/${loanId}`, { waitUntil: 'domcontentloaded' });
  const card2 = routed.page.getByTestId('forced-close-card');
  await expect(card2).toHaveAttribute('data-forced-close-route', 'available', { timeout: 60_000 });
  await expect(card2.getByText(/a route for that sale has been found/i)).toBeVisible();
  await expect(routed.page.getByTestId('forced-close-route-fallback')).toBeVisible();
  const submit = routed.page.getByTestId('forced-close-submit');
  await expect(submit).toBeVisible();

  // ---- 3. Submit: the sale goes through ----
  const sentBefore = routed.flags.sentTransactions;
  await submit.click();
  await routed.page.getByRole('button', { name: /^close out this loan$/i }).last().click();
  await expect
    .poll(
      async () =>
        Number(
          (
            (await pub.readContract({
              address: DIAMOND,
              abi: DIAMOND_ABI_VIEM,
              functionName: 'getLoanDetails',
              args: [loanId],
            })) as { status: number }
          ).status,
        ),
      { timeout: 90_000 },
    )
    .not.toBe(0);
  const status = Number(
    (
      (await pub.readContract({
        address: DIAMOND,
        abi: DIAMOND_ABI_VIEM,
        functionName: 'getLoanDetails',
        args: [loanId],
      })) as { status: number }
    ).status,
  );
  // DEFAULTED = the routed sale executed. FALLBACK_PENDING would mean the
  // contract tried every route and none completed — named, not just "≠ 2".
  expect(status, status === LOAN_STATUS_FALLBACK_PENDING ? 'every route failed: loan fell back' : '').toBe(
    LOAN_STATUS_DEFAULTED,
  );
  expect(routed.flags.sentTransactions).toBe(sentBefore + 1);
  await routed.ctx.close();
});
