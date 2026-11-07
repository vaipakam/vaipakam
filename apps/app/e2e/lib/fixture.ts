/**
 * The e2e chain, built from source (#2334).
 *
 * The suite used to fork live Base Sepolia, which meant it tested the
 * bytecode and state the TESTNET held at the block the job started — not the
 * contracts in the change under review, and not a fixed state. Now each run
 * deploys the repository's current contracts onto a bare anvil, so a run's
 * inputs are the commit and nothing else.
 *
 * The build itself — compile, etch the canonical contracts, run
 * `contracts/script/e2e/DeployE2EFixture.s.sol`, switch the chain id to Base
 * Sepolia's — is `deployFromSource` in `@vaipakam/anvil-harness`, shared with
 * the keeper's Anvil scenarios; read its header for each step and why the id
 * switch comes last. What is THIS suite's is the publication, step 5:
 *
 *   5. write `.state/admin-key.json` (the run's ephemeral admin key, for the
 *      one spec that broadcasts a forge script as the admin) and
 *      `.state/deployments.json`: the committed bundle with its 84532
 *      entry replaced by this deployment, then stamp it with this run's id.
 *      The app (through a vite hook, APP_E2E only), the harness and the
 *      indexer stub all read it, and the first two accept it only under
 *      this run's id.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeFunctionData, parseAbi } from 'viem';
import { bundleWith, deployFromSource } from '@vaipakam/anvil-harness/fixture';
import { ANVIL_URL } from './anvil';
import { E2E_ADMIN_KEY, E2E_BUNDLE, E2E_BUNDLE_RUN_ID, e2eRunId } from './artifacts';

export { E2E_CHAIN_ID } from '@vaipakam/anvil-harness/fixture';

export interface FixtureResult {
  diamond: `0x${string}`;
  admin: `0x${string}`;
}

export async function deployFixture(): Promise<FixtureResult> {
  const { diamond, admin, adminKey, artifact } = await deployFromSource(ANVIL_URL);
  await lowerOfferFloor(diamond);
  fs.mkdirSync(path.dirname(E2E_BUNDLE), { recursive: true });
  // The admin's ephemeral key, for the spec that broadcasts a forge script
  // as the admin (see `E2E_ADMIN_KEY`). Written before the stamp below, so a
  // completed setup always has it.
  fs.writeFileSync(E2E_ADMIN_KEY, JSON.stringify({ runId: e2eRunId(), adminKey }), { mode: 0o600 });
  fs.writeFileSync(E2E_BUNDLE, JSON.stringify(bundleWith(artifact), null, 2));
  // The stamp goes LAST: a reader waits for it, so it must not appear
  // before the bundle it vouches for is complete.
  fs.writeFileSync(E2E_BUNDLE_RUN_ID, e2eRunId());
  return { diamond, admin };
}

/**
 * #3242 — lowers the offer-book value floor to one raw unit (a wei of
 * numeraire), the same fixture convention the Solidity suites use
 * (`contracts/test/helpers/TestOfferFloor.sol`). The production floor is $10,
 * and the specs post offers of a few dollars of WETH to test the ladder, the
 * book and the fills, not the floor; the floor's own rule is tested in
 * `OfferBookBoundsTest` and the app's handling of it in
 * `src/lib/offerSchemaFloor.test.ts`. The setter refuses a floor under one
 * unit, so the field is written directly, at the slot the storage-layout
 * record states for it, and read back through the protocol's own getter so a
 * wrong slot fails the setup instead of silently leaving the floor in place.
 */
async function lowerOfferFloor(diamond: `0x${string}`): Promise<void> {
  const golden = JSON.parse(
    fs.readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../contracts/storage-layout/layout.golden.json'),
      'utf8',
    ),
  ) as { layout: string[] };
  const line = golden.layout.find((l) => l.startsWith('L|vaipakam|') && l.endsWith('|minOfferValueNumeraire'));
  if (!line) throw new Error('[e2e] minOfferValueNumeraire is not in the storage-layout record');
  const fieldSlot = BigInt(line.split('|')[2]);
  const slot = VAIPAKAM_STORAGE_BASE + fieldSlot;
  await rpc('anvil_setStorageAt', [diamond, toHex32(slot), toHex32(1n)]);
  const data = encodeFunctionData({ abi: FLOOR_ABI, functionName: 'getMinOfferValueNumeraire' });
  const ret = (await rpc('eth_call', [{ to: diamond, data }, 'latest'])) as `0x${string}`;
  if (BigInt(ret) !== 1n) {
    throw new Error(`[e2e] offer floor not lowered (reads ${BigInt(ret)}): the storage-layout slot is stale`);
  }
}

// The global setup runs under plain Node ESM, which cannot import the ABI
// bundle's JSON without import attributes, so the one getter is declared here.
const FLOOR_ABI = parseAbi(['function getMinOfferValueNumeraire() view returns (uint256)']);

/** `LibVaipakam.VANGKI_STORAGE_POSITION`, the namespaced storage base. */
const VAIPAKAM_STORAGE_BASE = 0x76f6f3ffb4e1cbadb2d289330bfeb7bd9d50e6e2407a61733161f6e3e1d10e00n;

const toHex32 = (v: bigint): `0x${string}` => `0x${v.toString(16).padStart(64, '0')}`;

async function rpc(method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(ANVIL_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (body.error) throw new Error(`[e2e] ${method}: ${body.error.message}`);
  return body.result;
}
