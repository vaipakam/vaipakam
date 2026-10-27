/**
 * The independent token-security screen (GoPlus), on Anvil.
 *
 * GoPlus does not index test networks, so on the standard fork-tier server
 * the screen reports 'unsupported' and every screened surface stays silent
 * (the posture a testnet must keep). A spec that exercises the REAL screen
 * spawns its own dev server with the test-only widening knob
 * `VITE_GOPLUS_EXTRA_CHAINS=84532` and route-mocks the GoPlus origin per
 * page. Shared by the browsing badges (spec 13) and the accept-time screen
 * (spec 46), so both drive the same server and the same mock shapes.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import type { Page } from '@playwright/test';
import { ANVIL_URL } from './anvil';

const STUB_PORT = Number(process.env.APP_E2E_STUB_PORT ?? 8788);

export interface GoPlusServer {
  /** The server's origin, e.g. `http://127.0.0.1:4175`. */
  base: string;
  stop: () => void;
}

/** Start a dev server on `port` with the GoPlus screen widened to the fork
 *  chain, and wait until it answers. Refuses a port something already
 *  listens on: a stale server from an earlier run would serve without the
 *  knob and every screened assertion would pass or fail for the wrong
 *  reason. */
export async function startGoPlusServer(port: number): Promise<GoPlusServer> {
  const base = `http://127.0.0.1:${port}`;
  const stale = await fetch(base).then(
    () => true,
    () => false,
  );
  if (stale) {
    throw new Error(
      `something is already listening on ${base}: kill it before running a GoPlus-screened spec`,
    );
  }
  const server: ChildProcess = spawn(
    'node',
    [
      'node_modules/vite/bin/vite.js',
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--strictPort',
    ],
    {
      env: {
        ...process.env,
        APP_E2E: '1',
        VITE_DEFAULT_CHAIN_ID: '84532',
        VITE_BASE_SEPOLIA_RPC_URL: ANVIL_URL,
        VITE_INDEXER_ORIGIN: `http://127.0.0.1:${STUB_PORT}`,
        VITE_GOPLUS_EXTRA_CHAINS: '84532',
      },
      stdio: 'ignore',
    },
  );
  const deadline = Date.now() + 120_000;
  for (;;) {
    if (server.exitCode !== null) {
      throw new Error(
        `GoPlus vite exited with ${server.exitCode}: port ${port} already in use?`,
      );
    }
    try {
      const res = await fetch(base);
      if (res.status < 500) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`GoPlus vite on ${base} not ready`);
    await new Promise((r) => setTimeout(r, 500));
  }
  return { base, stop: () => server.kill('SIGTERM') };
}

/** A fully-evaluated GoPlus row (every check '0'/known) with overrides.
 *  Unknown or missing fields would add "could not be evaluated" findings
 *  the assertions do not want. */
export function goPlusRow(overrides: Record<string, unknown> = {}) {
  return {
    is_open_source: '1',
    is_honeypot: '0',
    cannot_sell_all: '0',
    cannot_buy: '0',
    buy_tax: '0',
    sell_tax: '0',
    transfer_tax: '0',
    is_mintable: '0',
    owner_change_balance: '0',
    is_blacklisted: '0',
    transfer_pausable: '0',
    is_whitelisted: '0',
    is_anti_whale: '0',
    anti_whale_modifiable: '0',
    trading_cooldown: '0',
    hidden_owner: '0',
    can_take_back_ownership: '0',
    is_proxy: '0',
    selfdestruct: '0',
    slippage_modifiable: '0',
    personal_slippage_modifiable: '0',
    external_call: '0',
    fake_token: null,
    ...overrides,
  };
}

/** What the mocked GoPlus origin answers: a row for every requested
 *  address, or an HTTP failure. */
export type GoPlusAnswer =
  | { row: Record<string, unknown> }
  | { status: number };

/** Answer every GoPlus request (single or comma-batched) on `page`. The
 *  answer is read per request, so a spec can change what the screen says
 *  mid-flow by changing what `answer()` returns. With `gate`, every answer
 *  is held until it settles (a screen still in flight, #2535). */
export async function mockGoPlus(
  page: Page,
  answer: () => GoPlusAnswer,
  gate?: Promise<void>,
): Promise<void> {
  await page.route('https://api.gopluslabs.io/**', async (route) => {
    if (gate) await gate;
    const a = answer();
    if ('status' in a) {
      await route.fulfill({ status: a.status, body: 'mocked failure' });
      return;
    }
    const url = new URL(route.request().url());
    const addrs = (url.searchParams.get('contract_addresses') ?? '')
      .split(',')
      .filter(Boolean);
    const result = Object.fromEntries(addrs.map((x) => [x.toLowerCase(), a.row]));
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ code: 1, message: 'ok', result }),
    });
  });
}
