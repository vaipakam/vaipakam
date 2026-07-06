/** #1040 phase 1 — support-ticket capture from the Support drawer.
 *
 *  The agent Worker doesn't run in the fork tier (same reason the
 *  alerts card is live-only), but the WIDGET's whole contract is
 *  testable against a spec-local stub speaking the Worker's exact
 *  HTTP shape (CORS preflight + POST /support/ticket → {ticketId} /
 *  429 / 503). The Worker handler itself is pinned separately by
 *  apps/agent's vitest suite (test/supportTicket.test.ts).
 *
 *  A second dev server carries VITE_AGENT_ORIGIN (build-env var —
 *  the standard fork-tier server deliberately leaves it unset), and
 *  the control case asserts the unset build shows the honest
 *  not-configured state with the mailto path.
 *
 *  Asserted contract:
 *  1. Send with attach-consent ticked → POST body carries the
 *     redacted diagnostics block (never the full wallet address),
 *     the page, and the chain id; the ticket number renders with the
 *     prefilled mailto carrying it.
 *  2. Send WITHOUT the consent tick → diagnostics is null in the
 *     POST body — attaching is opt-in, never silent.
 *  3. Inbox down (503) → plain-words failure + mailto fallback; no
 *     ticket number claimed.
 *  4. Control on the standard server → not-configured copy + mailto,
 *     no send form.
 */
import http from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import type { Page } from '@playwright/test';
import { test, expect } from '../lib/wallet-fixture';
import { ANVIL_URL } from '../lib/anvil';

const APP_PORT = 4176;
const APP_BASE = `http://127.0.0.1:${APP_PORT}`;
const AGENT_PORT = 8790;
const STUB_PORT = Number(process.env.ALPHA02_E2E_STUB_PORT ?? 8788);

interface CapturedTicket {
  message: string;
  email: string | null;
  diagnostics: string | null;
  page: string | null;
  chainId: number | null;
}

let appServer: ChildProcess | undefined;
let agentStub: http.Server | undefined;
const captured: CapturedTicket[] = [];
/** Per-test response mode for the stub. */
let stubMode: 'ok' | 'unavailable' = 'ok';

test.beforeAll(async () => {
  // Spec-local agent stub — the Worker's HTTP shape, nothing more.
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
    if (req.url === '/support/ticket' && req.method === 'POST') {
      let body = '';
      req.on('data', (c: Buffer) => {
        body += c.toString();
      });
      req.on('end', () => {
        if (stubMode === 'unavailable') {
          res.writeHead(503, { ...cors, 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'unavailable' }));
          return;
        }
        captured.push(JSON.parse(body) as CapturedTicket);
        res.writeHead(200, { ...cors, 'content-type': 'application/json' });
        res.end(JSON.stringify({ ticketId: `VPK-TEST${captured.length}` }));
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
      `something is already listening on ${APP_BASE} — kill it before running the support spec`,
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
        ALPHA02_E2E: '1',
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
        `support vite exited with ${appServer.exitCode} — port ${APP_PORT} already in use?`,
      );
    }
    try {
      const res = await fetch(APP_BASE);
      if (res.status < 500) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error('support vite not ready');
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

async function openSupportForm(page: Page, base = APP_BASE): Promise<void> {
  await page.goto(`${base}/help`, { waitUntil: 'domcontentloaded' });
  await page
    .getByRole('button', { name: /support and connection check/i })
    .click();
  await expect(page.getByText('Contact support')).toBeVisible({
    timeout: 15_000,
  });
}

test('a consented send carries redacted diagnostics and returns a ticket number', async ({
  launchWallet,
}) => {
  stubMode = 'ok';
  const { page, account } = await launchWallet('lender');
  await openSupportForm(page);

  await page
    .locator('#support-message')
    .fill('The repay button did nothing after I clicked it.');
  await page.locator('#support-email').fill('tester@example.com');
  await page.getByText(/attach the health details/i).click();
  await page.getByRole('button', { name: /^send to support$/i }).click();

  await expect(page.getByText(/your ticket number is VPK-TEST/i)).toBeVisible({
    timeout: 15_000,
  });
  // The mailto escalation carries the ticket number.
  const mail = page.getByRole('link', { name: /email support@vaipakam\.com/i });
  expect(await mail.getAttribute('href')).toContain('VPK-TEST');

  const sent = captured.at(-1)!;
  expect(sent.message).toContain('repay button');
  expect(sent.email).toBe('tester@example.com');
  expect(sent.page).toContain('/help');
  expect(sent.chainId).toBe(84532);
  // Diagnostics attached — and REDACTED: the block must name the
  // health rows without ever carrying the full wallet address.
  expect(sent.diagnostics).toBeTruthy();
  expect(sent.diagnostics).toContain('Network:');
  expect(sent.diagnostics!.toLowerCase()).not.toContain(
    account.address.toLowerCase(),
  );
});

test('without the consent tick, no diagnostics travel', async ({
  launchWallet,
}) => {
  stubMode = 'ok';
  const { page } = await launchWallet('lender');
  await openSupportForm(page);
  await page.locator('#support-message').fill('Just a question about fees.');
  await page.getByRole('button', { name: /^send to support$/i }).click();
  await expect(page.getByText(/your ticket number is/i)).toBeVisible({
    timeout: 15_000,
  });
  const sent = captured.at(-1)!;
  expect(sent.diagnostics).toBeNull();
  expect(sent.email).toBeNull();
});

test('inbox down → plain-words failure with the mailto fallback, no ticket claimed', async ({
  launchWallet,
}) => {
  stubMode = 'unavailable';
  const { page } = await launchWallet('lender');
  await openSupportForm(page);
  await page.locator('#support-message').fill('This should not get a ticket.');
  await page.getByRole('button', { name: /^send to support$/i }).click();
  await expect(
    page.getByText(/couldn.t take the message right now/i),
  ).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/your ticket number is/i)).toHaveCount(0);
  await expect(
    page.getByRole('link', { name: /email support@vaipakam\.com/i }),
  ).toBeVisible();
});

test('control: the standard build (no agent origin) says so and offers mail only', async ({
  launchWallet,
}) => {
  const { page } = await launchWallet('lender');
  await page.goto('/help', { waitUntil: 'domcontentloaded' });
  await page
    .getByRole('button', { name: /support and connection check/i })
    .click();
  await expect(page.getByText(/support inbox isn.t connected/i)).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.locator('#support-message')).toHaveCount(0);
  await expect(
    page.getByRole('link', { name: /email support@vaipakam\.com/i }),
  ).toBeVisible();
});
