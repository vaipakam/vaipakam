/**
 * Fork-tier bootstrap, in order:
 *   1. spawn `anvil --fork-url <base-sepolia> --chain-id 84532`
 *   2. spawn the indexer stub (fork-hydrated, zero-lag)
 *   3. generate + fund the four ephemeral role wallets
 *   4. seed their WETH + tLIQ balances
 * PIDs land in e2e/.state/pids.json for global-teardown. The fork URL
 * comes from ALPHA02_E2E_FORK_URL (defaults to the public endpoint —
 * fine on CI runners; use a keyed RPC locally if the public one
 * throttles).
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ANVIL_URL, waitForAnvil } from './lib/anvil';
import { createAndFundWallets } from './lib/wallets';
import { seedRoleAssets } from './lib/seed';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const STATE_DIR = path.join(HERE, '.state');
const PIDS_FILE = path.join(STATE_DIR, 'pids.json');
const STUB_PORT = Number(process.env.ALPHA02_E2E_STUB_PORT ?? 8788);

async function waitForHttp(url: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.status < 500) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`service not ready: ${url}`);
}

/** Readiness probes can't tell OUR fresh child from a stale process
 *  already squatting the port (the child dies with EADDRINUSE while
 *  the probe happily answers) — and a stale anvil/stub means the run
 *  silently uses non-disposable state. Fail closed BEFORE spawning:
 *  anything answering on the port is fatal. */
async function assertNothingListening(url: string, what: string): Promise<void> {
  let responded = false;
  try {
    await fetch(url, { signal: AbortSignal.timeout(2_000) });
    responded = true;
  } catch {
    /* connection refused / timeout — port is free, good */
  }
  if (responded) {
    throw new Error(
      `${what} port already has a listener at ${url} — kill the stale process; the fork tier needs a fresh disposable instance`,
    );
  }
}

export default async function globalSetup(): Promise<void> {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const pids: number[] = [];

  const forkUrl =
    process.env.ALPHA02_E2E_FORK_URL ?? 'https://sepolia.base.org';
  await assertNothingListening(ANVIL_URL, 'anvil');
  await assertNothingListening(`http://127.0.0.1:${STUB_PORT}/`, 'indexer stub');
  // Spawn on the SAME endpoint every helper (and the browser via
  // playwright.config's VITE_BASE_SEPOLIA_RPC_URL) resolves from
  // ALPHA02_E2E_ANVIL_URL — a fixed port here would split the suite
  // across two RPCs the moment someone overrides the URL.
  const anvilEndpoint = new URL(ANVIL_URL);
  const anvil = spawn(
    'anvil',
    [
      '--fork-url', forkUrl,
      '--chain-id', '84532',
      '--host', anvilEndpoint.hostname,
      '--port', anvilEndpoint.port || '8545',
      '--silent',
      // Generous gas + instant mining keep UI waits short.
      '--gas-limit', '60000000',
    ],
    { stdio: ['ignore', 'inherit', 'inherit'], detached: false },
  );
  if (anvil.pid) pids.push(anvil.pid);
  // A child death before readiness (bad fork URL, port race) must be
  // fatal — resolves (never rejects) so the loser of the race can't
  // become an unhandled rejection.
  const anvilDied = new Promise<number>((resolve) =>
    anvil.on('exit', (code) => resolve(code ?? -1)),
  );
  const anvilOutcome = await Promise.race([
    waitForAnvil(120_000).then(() => 'ready' as const),
    anvilDied,
  ]);
  if (anvilOutcome !== 'ready') {
    throw new Error(`anvil exited before ready (code ${anvilOutcome})`);
  }
  console.log('[e2e] anvil fork ready (chainId 84532)');

  const stub = spawn(
    process.execPath,
    [path.join(HERE, 'lib', 'indexer-stub.mjs')],
    {
      stdio: ['ignore', 'inherit', 'inherit'],
      env: { ...process.env },
      cwd: path.join(HERE, '..'),
    },
  );
  if (stub.pid) pids.push(stub.pid);
  fs.writeFileSync(PIDS_FILE, JSON.stringify(pids));
  await waitForHttp(`http://127.0.0.1:${STUB_PORT}/offers/stats?chainId=84532`);
  if (stub.exitCode !== null) {
    throw new Error(`indexer stub exited early (code ${stub.exitCode})`);
  }
  console.log('[e2e] indexer stub ready');

  await createAndFundWallets();
  await seedRoleAssets();
  console.log('[e2e] role wallets funded + seeded');
}
