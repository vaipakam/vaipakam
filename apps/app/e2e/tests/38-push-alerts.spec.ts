/** #2251 — the Alerts card offers Push only when the agent says it can send.
 *
 *  The agent Worker does not run in the fork tier, so — as in the
 *  support-ticket spec — the card is driven against a spec-local stub that
 *  speaks the Worker's exact HTTP shape: `GET /push/status` and
 *  `PUT /thresholds` (with the `push` outcome the agent now returns). The
 *  Worker side is pinned by apps/agent's vitest suite
 *  (test/pushStatus.test.ts) and the shared rail by packages/push.
 *
 *  Asserted contract:
 *  1. AVAILABLE: the opt-in is offered, the subscribe link opens the channel
 *     the AGENT names (not a build-time address), the card says the check
 *     covers payment reminders only (the answer's scope is the agent's rail),
 *     and enabling sends the opt-in and reads "Push delivery is on".
 *  2. UNAVAILABLE: no opt-in and no link; the card says Push can't be sent
 *     from this deployment.
 *  3. REFUSED AT SAVE: the status said available, the agent refused the
 *     opt-in when it was saved (a 409 that stores nothing) — the app sends
 *     the save again without the opt-in, Push stays off, the card says why,
 *     and it re-reads the status.
 *  4. UNKNOWN: the status could not be read — stated, and nothing offered.
 *
 *  #2723 — the paid-Push billing consent, against the REAL Diamond on anvil
 *  (the fee and the consent are read from and written to the chain; only the
 *  service's billing answer, `billedChainIds`, comes from the stub):
 *  5. NOT BILLED: the fee is stated from the chain, the card says nothing
 *     charges it on this network, and agreeing to pay is not offered.
 *  6. BILLED HERE: agreeing signs the consent at the current fee — read back
 *     from the chain — and the card says it covers the fee.
 *  7. WITHDRAW: once billing is no longer stated (unknown answer), the stored
 *     consent is still withdrawable, and withdrawing zeroes it on chain.
 */
import http from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import type { Page } from '@playwright/test';
import { test, expect, connectWallet } from '../lib/wallet-fixture';
import { ANVIL_URL } from '../lib/anvil';
import { CHAIN_ID, DIAMOND, DIAMOND_ABI_VIEM, pub } from '../lib/chain';
import { accountFor } from '../lib/wallets';

const APP_PORT = 4177;
const APP_BASE = `http://127.0.0.1:${APP_PORT}`;
const AGENT_PORT = 8791;
const STUB_PORT = Number(process.env.APP_E2E_STUB_PORT ?? 8788);
/** A channel no build-time setting carries, so the link can only come from
 *  the agent's answer. */
const AGENT_CHANNEL = '0x6F5847A0CA1F2cB1bbEf944124cE5995988a1D6b';

let appServer: ChildProcess | undefined;
let agentStub: http.Server | undefined;
/** What `GET /push/status` answers. */
let statusMode: 'available' | 'unavailable' | 'error' = 'available';
/** What `PUT /thresholds` does with a NEW Push opt-in: store it, or refuse
 *  the whole save with the agent's 409. */
let putPush: 'stored' | 'refuse' = 'stored';
/** What `GET /push/status` says about billing (#2723): the chains it bills
 *  paid Push on. The e2e chain is listed only in `here`. */
let billedMode: 'nowhere' | 'here' = 'nowhere';
const puts: Record<string, unknown>[] = [];

test.beforeAll(async () => {
  agentStub = http.createServer((req, res) => {
    const origin = req.headers.origin ?? '*';
    const cors = {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      res.end();
      return;
    }
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { ...cors, 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.url === '/push/status' && req.method === 'GET') {
      if (statusMode === 'error') return json(500, { error: 'boom' });
      const billedChainIds = billedMode === 'here' ? [CHAIN_ID] : [];
      return json(
        200,
        statusMode === 'available'
          ? { available: true, channel: AGENT_CHANNEL, scope: 'agent', billedChainIds }
          : { available: false, reason: 'signer-unset', scope: 'agent', billedChainIds },
      );
    }
    if (req.url === '/thresholds' && req.method === 'PUT') {
      let body = '';
      req.on('data', (c: Buffer) => {
        body += c.toString();
      });
      req.on('end', () => {
        const parsed = JSON.parse(body) as Record<string, unknown>;
        puts.push(parsed);
        const requested = typeof parsed.push_channel === 'string';
        if (requested && putPush === 'refuse') {
          json(409, { error: 'push-unavailable', push: 'unavailable' });
          return;
        }
        json(200, { ok: true, push: requested ? 'stored' : 'not-requested' });
      });
      return;
    }
    res.writeHead(404, cors);
    res.end();
  });
  await new Promise<void>((resolve) =>
    agentStub!.listen(AGENT_PORT, '127.0.0.1', resolve),
  );

  const stale = await fetch(APP_BASE).then(
    () => true,
    () => false,
  );
  if (stale) {
    throw new Error(
      `something is already listening on ${APP_BASE} — kill it before running the push-alerts spec`,
    );
  }
  appServer = spawn(
    'node',
    [
      'node_modules/vite/bin/vite.js',
      '--host',
      '127.0.0.1',
      '--port',
      String(APP_PORT),
      '--strictPort',
    ],
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
    if (appServer.exitCode !== null) {
      throw new Error(
        `push-alerts vite exited with ${appServer.exitCode} — port ${APP_PORT} already in use?`,
      );
    }
    try {
      const res = await fetch(APP_BASE);
      if (res.status < 500) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error('push-alerts vite not ready');
    await new Promise((r) => setTimeout(r, 500));
  }
});

test.afterAll(async () => {
  appServer?.kill('SIGTERM');
  await new Promise<void>((resolve) => {
    if (!agentStub) return resolve();
    agentStub.close(() => resolve());
  });
});

async function openAlerts(page: Page): Promise<void> {
  await page.goto(`${APP_BASE}/settings`, { waitUntil: 'domcontentloaded' });
  await connectWallet(page);
  await expect(page.getByText('Prefer app push instead?')).toBeVisible({
    timeout: 30_000,
  });
}

test('an available rail is offered, and its link opens the channel the agent names', async ({
  launchWallet,
}) => {
  statusMode = 'available';
  putPush = 'stored';
  const { page } = await launchWallet('borrower');
  await openAlerts(page);

  const link = page.getByRole('link', { name: /open the push channel/i });
  // The answer covers the agent's rail only, and the card says so.
  await expect(page.getByText(/this check covers payment reminders/i)).toBeVisible({
    timeout: 15_000,
  });
  await expect(link).toHaveAttribute(
    'href',
    `https://app.push.org/channels/${AGENT_CHANNEL}`,
  );
  const before = puts.length;
  await page.getByRole('button', { name: /enable push delivery/i }).click();
  await expect(page.getByText('Push delivery is on for this wallet.')).toBeVisible({
    timeout: 15_000,
  });
  expect(puts.slice(before).some((p) => p.push_channel === 'subscribed')).toBe(true);
});

test('an unavailable rail is stated, with nothing offered', async ({ launchWallet }) => {
  statusMode = 'unavailable';
  const { page } = await launchWallet('lender');
  await openAlerts(page);
  await expect(
    page.getByText(/push can.t be switched on right now/i),
  ).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('button', { name: /enable push delivery/i })).toHaveCount(0);
  await expect(page.getByRole('link', { name: /open the push channel/i })).toHaveCount(0);
});

test('an opt-in the agent refuses at save stays off, and the card says why', async ({
  launchWallet,
}) => {
  // The status said available; by the time the opt-in was saved the rail
  // could not send. The agent stored the rest of the save and said so.
  statusMode = 'available';
  putPush = 'refuse';
  const { page } = await launchWallet('lender');
  await openAlerts(page);
  const enable = page.getByRole('button', { name: /enable push delivery/i });
  await expect(enable).toBeVisible({ timeout: 15_000 });
  statusMode = 'unavailable';
  const before = puts.length;
  await enable.click();
  await expect(page.getByText(/push wasn.t switched on/i)).toBeVisible({
    timeout: 15_000,
  });
  // The refused save was sent again WITHOUT the opt-in, so the rest landed.
  const sent = puts.slice(before);
  expect(sent[0]?.push_channel).toBe('subscribed');
  expect(sent.some((p) => p.push_channel === undefined)).toBe(true);
  await expect(page.getByText('Push delivery is on for this wallet.')).toHaveCount(0);
  // The card re-read the status and now states the outage.
  await expect(
    page.getByText(/push can.t be switched on right now/i),
  ).toBeVisible({ timeout: 15_000 });
});

test('a status that cannot be read is stated as unknown, with nothing offered', async ({
  launchWallet,
}) => {
  statusMode = 'error';
  const { page } = await launchWallet('borrower');
  await openAlerts(page);
  await expect(
    page.getByText(/couldn.t check whether push alerts can be sent/i),
  ).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('button', { name: /enable push delivery/i })).toHaveCount(0);
});

/** The wallet's stored paid-Push consent and the configured fee, from the
 *  chain itself. */
async function chainConsent(address: `0x${string}`) {
  const [fee] = (await pub.readContract({
    address: DIAMOND,
    abi: DIAMOND_ABI_VIEM,
    functionName: 'getNotificationFeeConfig',
  })) as readonly [bigint, bigint];
  const [cap, covers] = (await pub.readContract({
    address: DIAMOND,
    abi: DIAMOND_ABI_VIEM,
    functionName: 'getNotificationFeeConsent',
    args: [address],
  })) as readonly [bigint, boolean];
  return { fee, cap, covers };
}

test('paid Push: the fee is stated from the chain, and nothing is offered where Push is not billed', async ({
  launchWallet,
}) => {
  statusMode = 'available';
  billedMode = 'nowhere';
  const { page } = await launchWallet('newBorrower');
  await openAlerts(page);
  const card = page.getByTestId('paid-push');
  const { fee, cap } = await chainConsent(accountFor('newBorrower').address);
  expect(cap).toBe(0n);
  const feeText = (Number(fee) / 1e18).toString();
  await expect(card.getByText(new RegExp(`cost ${feeText} VPFI per loan side`))).toBeVisible({
    timeout: 30_000,
  });
  await expect(card.getByTestId('paid-push-billing')).toHaveText(/aren.t billed on/i);
  await expect(card.getByTestId('paid-push-consent')).toHaveText(/haven.t agreed to pay/i);
  await expect(card.getByRole('button', { name: /agree to pay/i })).toHaveCount(0);
  await expect(card.getByRole('button', { name: /withdraw my agreement/i })).toHaveCount(0);
});

test('paid Push: agreeing where it is billed records the current fee on chain, and withdrawing always works', async ({
  launchWallet,
}) => {
  statusMode = 'available';
  billedMode = 'here';
  const wallet = accountFor('newBorrower').address;
  const { page } = await launchWallet('newBorrower');
  await openAlerts(page);
  const card = page.getByTestId('paid-push');
  const { fee } = await chainConsent(wallet);
  // Billing is stated outright, not left to the agree button's presence.
  await expect(card.getByTestId('paid-push-billing')).toHaveText(/alert service charges this fee/i);

  await card.getByRole('button', { name: /agree to pay up to/i }).click();
  await expect(card.getByText(/saved: you.ve agreed to pay/i)).toBeVisible({ timeout: 30_000 });
  await expect(card.getByTestId('paid-push-consent')).toHaveText(/that covers the current fee/i);
  const agreed = await chainConsent(wallet);
  expect(agreed.cap).toBe(fee);
  expect(agreed.covers).toBe(true);
  // Already covered: nothing more to agree to, and the withdrawal is offered.
  await expect(card.getByRole('button', { name: /agree to pay/i })).toHaveCount(0);

  // The service no longer answers about billing: agreeing is not offered,
  // and the stored consent is still withdrawable.
  statusMode = 'error';
  await openAlerts(page);
  await expect(card.getByTestId('paid-push-billing')).toHaveText(/couldn.t check whether paid push/i, {
    timeout: 30_000,
  });
  await card.getByRole('button', { name: /withdraw my agreement/i }).click();
  await expect(card.getByText(/withdrawn: paid push fees can.t be charged/i)).toBeVisible({
    timeout: 30_000,
  });
  expect((await chainConsent(wallet)).cap).toBe(0n);
  await expect(card.getByTestId('paid-push-consent')).toHaveText(/haven.t agreed to pay/i);
});
