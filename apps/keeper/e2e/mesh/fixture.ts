/**
 * The keeper's TWO-chain scenarios' fixture (#2516): the shared two-chain
 * build (`@vaipakam/anvil-harness/mesh`, whose header lists every step) under
 * the keeper suite's own state directory, artifact root and ports, so it
 * never reads another suite's build.
 *
 * The one thing the keeper asks of the mesh seed is its own remitter: Base
 * authorizes the keeper's EOA (an Anvil well-known development key) to call
 * `remitRewardBudget`, as an operator authorizes the keeper on a live Base.
 *
 * Each node's artifact lives under the gitignored
 * `contracts/deployments/.forge-test/e2e-keeper-mesh/<slug>/`. The bundle
 * published under `.state/mesh/` carries both chains.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { privateKeyToAccount } from 'viem/accounts';
import { ANVIL_DEV_KEYS } from '@vaipakam/anvil-harness/devKeys';
import { MeshFixtureStore } from '@vaipakam/anvil-harness/mesh';

export { BASE_ID, LANE_NATIVE_FEE, MESH_REWARD_POOL_FUND, MIRROR_ID, type MeshChainFixture, type MeshFixture } from '@vaipakam/anvil-harness/mesh';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const MESH_STATE_DIR = path.resolve(HERE, '..', '.state', 'mesh');

/** The keeper suite's two-chain fixture. */
export const meshStore = new MeshFixtureStore({
  stateDir: MESH_STATE_DIR,
  artifactRoot: 'deployments/.forge-test/e2e-keeper-mesh',
  // The two build nodes listen here; scenario nodes take the ports above.
  port: Number(process.env.KEEPER_E2E_MESH_ANVIL_PORT ?? 8745),
  label: 'keeper-e2e mesh',
});

export const MESH_BUNDLE_PATH = meshStore.bundlePath;

/** Build both chains and publish `.state/mesh/` — the mesh config's global setup. */
export function prepareMeshFixture(): Promise<void> {
  return meshStore.prepare({ rewardRemitter: privateKeyToAccount(ANVIL_DEV_KEYS.keeper).address });
}
