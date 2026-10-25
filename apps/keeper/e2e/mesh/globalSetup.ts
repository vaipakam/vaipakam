/**
 * Vitest global setup for the keeper's two-chain Anvil scenarios: build both
 * chains and the lane between them once per run (`fixture.ts`). Set
 * `KEEPER_E2E_REUSE_FIXTURE=1` to keep a `.state/mesh/` an earlier run built
 * — an inner-loop convenience only; CI always builds afresh.
 *
 * `fixture.json` is the fixture's completion marker: the build writes it last,
 * after its nodes have exited and every state dump exists, so reuse never
 * starts from a half-built fixture.
 */
import { meshStore, prepareMeshFixture } from './fixture';

export default async function setup(): Promise<void> {
  if (process.env.KEEPER_E2E_REUSE_FIXTURE === '1' && meshStore.isBuilt()) {
    console.log('[keeper-e2e mesh] reusing the fixture under .state/mesh/ (KEEPER_E2E_REUSE_FIXTURE=1)');
    return;
  }
  await prepareMeshFixture();
}
