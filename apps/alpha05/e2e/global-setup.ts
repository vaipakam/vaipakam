/**
 * E2E bootstrap, in order:
 *   1. spawn a BARE Anvil (no fork; nothing here reads a live chain)
 *   2. deploy the repository's current contracts onto it and present it as
 *      Base Sepolia (`@vaipakam/anvil-harness`), writing the e2e bundle
 *   3. spawn the stand-in Worker (the indexer's health route hydrated from
 *      the chain, and the RPC proxy's route forwarding to Anvil)
 *   4. generate + fund the ephemeral role wallets
 * PIDs land in e2e/.state/pids.json for global-teardown.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundleWith, deployFromSource } from '@vaipakam/anvil-harness/fixture';
import { assertNothingListening, spawnAnvil } from '@vaipakam/anvil-harness/process';
import { ANVIL_URL } from './lib/anvil';
import { E2E_BUNDLE, E2E_BUNDLE_RUN_ID, STATE_DIR, e2eRunId } from './lib/artifacts';
import { STUB_ORIGIN, STUB_PORT } from './lib/stub';
import { createAndFundWallets } from './lib/wallets';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PIDS_FILE = path.join(STATE_DIR, 'pids.json');

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

export default async function globalSetup(): Promise<void> {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const pids: number[] = [];
  // The PID file first, before anything that can throw: teardown kills every
  // PID it finds and the OS reuses numbers, so a stale list is a hazard.
  fs.writeFileSync(PIDS_FILE, JSON.stringify(pids));
  fs.rmSync(E2E_BUNDLE_RUN_ID, { force: true });
  fs.rmSync(E2E_BUNDLE, { force: true });

  await assertNothingListening(`${STUB_ORIGIN}/`, 'stand-in Worker');
  // Anvil's own id: the fixture deploys as 31337 and switches the chain to
  // 84532 afterwards. The genesis number sits above the block viem's Base
  // Sepolia chain object records Multicall3 at, so batched reads work.
  const anvil = await spawnAnvil({ url: ANVIL_URL, chainId: 31337, genesisNumber: 2_000_000, gasLimit: 60_000_000 });
  if (anvil.child.pid) pids.push(anvil.child.pid);
  fs.writeFileSync(PIDS_FILE, JSON.stringify(pids));
  // A history below the head, so every client's fee query has blocks to read.
  await anvil.control.rpc('anvil_mine', ['0x400']);
  console.log('[e2e] anvil ready (bare chain)');

  const { diamond, admin, artifact } = await deployFromSource(ANVIL_URL);
  fs.writeFileSync(E2E_BUNDLE, JSON.stringify(bundleWith(artifact), null, 2));
  // The stamp goes LAST: readers wait for it, so it must not appear before
  // the bundle it vouches for is complete.
  fs.writeFileSync(E2E_BUNDLE_RUN_ID, e2eRunId());
  console.log(`[e2e] fixture deployed from source — Diamond ${diamond}, admin ${admin}; chain now presents 84532`);

  const stub = spawn(process.execPath, [path.join(HERE, 'lib', 'indexer-stub.mjs')], {
    stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...process.env, ALPHA05_E2E_ANVIL_URL: ANVIL_URL, ALPHA05_E2E_STUB_PORT: String(STUB_PORT) },
    cwd: path.join(HERE, '..'),
  });
  if (stub.pid) pids.push(stub.pid);
  // If the stand-in dies mid-run every later spec fails on a refused
  // connection, far from the cause; say so in the log the moment it happens.
  stub.on('exit', (code, signal) => {
    if (code !== 0 && signal !== 'SIGTERM') console.error(`[e2e] stand-in Worker EXITED mid-run (code ${code}, signal ${signal}); later specs will see refused connections`);
  });
  fs.writeFileSync(PIDS_FILE, JSON.stringify(pids));
  await waitForHttp(`${STUB_ORIGIN}/health/ingest`);
  if (stub.exitCode !== null) throw new Error(`stand-in Worker exited early (code ${stub.exitCode})`);
  console.log('[e2e] stand-in Worker ready');

  await createAndFundWallets();
  console.log('[e2e] role wallets funded');
}
