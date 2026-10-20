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
 *   5. write `.state/deployments.json`: the committed bundle with its 84532
 *      entry replaced by this deployment, then stamp it with this run's id.
 *      The app (through a vite hook, APP_E2E only), the harness and the
 *      indexer stub all read it, and the first two accept it only under
 *      this run's id.
 */
import fs from 'node:fs';
import path from 'node:path';
import { bundleWith, deployFromSource } from '@vaipakam/anvil-harness/fixture';
import { ANVIL_URL } from './anvil';
import { E2E_BUNDLE, E2E_BUNDLE_RUN_ID, e2eRunId } from './artifacts';

export { E2E_CHAIN_ID } from '@vaipakam/anvil-harness/fixture';

export interface FixtureResult {
  diamond: `0x${string}`;
  admin: `0x${string}`;
}

export async function deployFixture(): Promise<FixtureResult> {
  const { diamond, admin, artifact } = await deployFromSource(ANVIL_URL);
  fs.mkdirSync(path.dirname(E2E_BUNDLE), { recursive: true });
  fs.writeFileSync(E2E_BUNDLE, JSON.stringify(bundleWith(artifact), null, 2));
  // The stamp goes LAST: a reader waits for it, so it must not appear
  // before the bundle it vouches for is complete.
  fs.writeFileSync(E2E_BUNDLE_RUN_ID, e2eRunId());
  return { diamond, admin };
}
