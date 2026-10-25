/**
 * The protocol suite's two-chain fixture (#848): the shared mesh build
 * (`@vaipakam/anvil-harness/mesh`, whose header lists every step) under this
 * suite's own state directory, artifact root and ports, so it never reads the
 * keeper suite's build or another run's.
 *
 * The one thing the mesh seed asks of a suite is the address Base authorizes
 * to call `remitRewardBudget`. A live Base authorizes its keeper EOA, so this
 * suite names the same well-known development key the harness calls `keeper`
 * — and drives the remittance from it itself: nothing here runs keeper code.
 *
 * Each node's artifact lives under the gitignored
 * `contracts/deployments/.forge-test/e2e-protocol-mesh/<slug>/`.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { privateKeyToAccount } from 'viem/accounts';
import { ANVIL_DEV_KEYS } from '@vaipakam/anvil-harness/devKeys';
import { MeshFixtureStore } from '@vaipakam/anvil-harness/mesh';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** This suite's two-chain fixture. */
export const protocolMesh = new MeshFixtureStore({
  stateDir: path.resolve(HERE, '..', '.state', 'mesh'),
  artifactRoot: 'deployments/.forge-test/e2e-protocol-mesh',
  // The two build nodes listen here; scenario nodes take the ports above.
  port: Number(process.env.PROTOCOL_E2E_MESH_ANVIL_PORT ?? 8845),
  label: 'protocol-e2e mesh',
});

/** Build both chains and publish `.state/mesh/` — the suite's global setup. */
export function prepareProtocolMesh(): Promise<void> {
  return protocolMesh.prepare({ rewardRemitter: privateKeyToAccount(ANVIL_DEV_KEYS.keeper).address });
}
