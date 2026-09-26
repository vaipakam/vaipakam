/**
 * E2E bootstrap (#2334), in order:
 *   1. spawn a BARE `anvil` — no fork; nothing here reads a live chain
 *   2. deploy the repository's current contracts onto it and present it as
 *      Base Sepolia (`lib/fixture.ts`), writing the e2e deployments bundle
 *   3. spawn the indexer stub (chain-hydrated, zero-lag)
 *   4. generate + fund the four ephemeral role wallets
 *   5. seed their WETH + tLIQ balances
 * PIDs land in e2e/.state/pids.json for global-teardown.
 *
 * Until #2334 step 1 forked live Base Sepolia, so a run tested whatever
 * the testnet held at that block. The retry machinery that fork needed
 * (#1973 genesis failures, #1979 an unservable fork base) is gone with it:
 * both were failures of an upstream RPC this chain no longer has.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ANVIL_URL, anvilRpc, childHasExited, waitForAnvil } from './lib/anvil';
import { E2E_BUNDLE, E2E_BUNDLE_RUN_ID } from './lib/artifacts';
import { deployFixture } from './lib/fixture';
import { createAndFundWallets } from './lib/wallets';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const STATE_DIR = path.join(HERE, '.state');
const PIDS_FILE = path.join(STATE_DIR, 'pids.json');
const STUB_PORT = Number(process.env.APP_E2E_STUB_PORT ?? 8788);

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
      `${what} port already has a listener at ${url} — kill the stale process; the e2e tier needs a fresh disposable instance`,
    );
  }
}

export default async function globalSetup(): Promise<void> {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const pids: number[] = [];
  // Truncate the PID file FIRST, before anything that can throw. A stale
  // list from an earlier run is not merely useless — teardown kills every
  // PID it finds, and the OS reuses those numbers, so an unrelated
  // process can be killed. The stale-listener guards below exit before
  // the first real write, so clearing here is what makes them safe
  // rather than each one remembering to.
  fs.writeFileSync(PIDS_FILE, JSON.stringify(pids));
  // Likewise the bundle. Readers already refuse one stamped with another
  // run's id; removing it as well keeps a failed setup from leaving a
  // plausible-looking file behind.
  fs.rmSync(E2E_BUNDLE_RUN_ID, { force: true });
  fs.rmSync(E2E_BUNDLE, { force: true });

  await assertNothingListening(ANVIL_URL, 'anvil');
  await assertNothingListening(`http://127.0.0.1:${STUB_PORT}/`, 'indexer stub');
  // Spawn on the SAME endpoint every helper (and the browser via
  // playwright.config's VITE_BASE_SEPOLIA_RPC_URL) resolves from
  // APP_E2E_ANVIL_URL — a fixed port here would split the suite
  // across two RPCs the moment someone overrides the URL.
  const anvilEndpoint = new URL(ANVIL_URL);
  const anvil = spawn(
    'anvil',
    [
      // Anvil's own id: the fixture deploys as 31337 and switches the
      // chain to 84532 afterwards — see lib/fixture.ts for why.
      '--chain-id', '31337',
      // Start high. viem's Base Sepolia chain object records Multicall3 as
      // created at block 1,059,647 and refuses every multicall read below
      // it, so on a chain starting at 0 each batched read the app makes
      // fails, token decimals never load, and typed amounts parse as 0.
      // Mining up to it is far too slow; setting the genesis number is not.
      '--number', '2000000',
      '--host', anvilEndpoint.hostname,
      '--port', anvilEndpoint.port || '8545',
      '--silent',
      // Generous gas + instant mining keep UI waits short.
      '--gas-limit', '60000000',
    ],
    { stdio: ['ignore', 'inherit', 'inherit'], detached: false },
  );
  if (anvil.pid) pids.push(anvil.pid);
  // Record the PID IMMEDIATELY: if the readiness wait throws while the
  // child is alive, teardown must still find something to kill —
  // otherwise the orphan squats the port and every following run dies on
  // the stale-listener guard.
  fs.writeFileSync(PIDS_FILE, JSON.stringify(pids));
  const anvilDied = new Promise<number>((resolve) =>
    anvil.on('exit', (code) => resolve(code ?? -1)),
  );
  const outcome = await Promise.race([
    waitForAnvil(31337, 60_000).then(() => 'ready' as const),
    anvilDied,
  ]);
  if (outcome !== 'ready') {
    // Dead: drop its PID before throwing, since the OS may reassign it.
    if (childHasExited(anvil) && anvil.pid) {
      pids.splice(pids.indexOf(anvil.pid), 1);
      fs.writeFileSync(PIDS_FILE, JSON.stringify(pids));
    }
    throw new Error(`anvil exited before it was ready (code ${outcome})`);
  }
  // Give the chain a history below its head. Starting at a set genesis
  // number leaves NO blocks beneath it, and anvil ≥1.8 answers an
  // `eth_feeHistory` window reaching below genesis with an error rather
  // than clamping it — which is how forge's EIP-1559 fee estimate failed
  // the fixture deploy on CI's Foundry while 1.5.1 passed locally (#2351).
  // 1,024 is the largest window `eth_feeHistory` serves on standard nodes
  // (geth caps blockCount there), so every client's fee query now has
  // blocks to read, whatever window it picks.
  await anvilRpc('anvil_mine', ['0x400']);
  console.log('[e2e] anvil ready (bare chain)');

  const fixture = await deployFixture();
  console.log(
    `[e2e] fixture deployed from source — Diamond ${fixture.diamond}, admin ${fixture.admin}; chain now presents 84532`,
  );

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
  // Imported only now: `seed` reaches `chain.ts`, which reads the bundle
  // at module load, and the bundle did not exist until the fixture ran.
  const { seedRoleAssets } = await import('./lib/seed');
  await seedRoleAssets();
  console.log('[e2e] role wallets funded + seeded');
}
