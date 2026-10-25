/**
 * The keeper's two-chain scenario: the shared mesh opener
 * (`@vaipakam/anvil-harness/meshScenario`) over the keeper suite's own
 * fixture store (`fixture.ts`), with the keeper's process clock.
 *
 * The keeper reads `Date.now()` for every age it judges, and on a live mesh
 * both chains run on the same wall clock, so every shared warp also pins the
 * process's `Date` (only `Date`) to the new head ({@link KEEPER_CLOCK}).
 * Each node starts clear of the indexer's settled depth, as the single-chain
 * scenario does.
 */
import { vi } from 'vitest';
import { openMeshScenario as openSharedMeshScenario, type MeshScenario } from '@vaipakam/anvil-harness/meshScenario';
import { KEEPER_CLOCK, SETTLED_DEPTH } from '../harness/chain';
import { meshStore } from './fixture';

export type { MeshChain, MeshScenario } from '@vaipakam/anvil-harness/meshScenario';

/** Start a two-chain scenario (see the header). */
export async function openMeshScenario(): Promise<MeshScenario> {
  vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
  return openSharedMeshScenario(meshStore, { clock: KEEPER_CLOCK, warmupBlocks: SETTLED_DEPTH + 8, name: 'keeper-e2e' });
}
