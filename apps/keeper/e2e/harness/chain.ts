/**
 * The keeper's single-chain scenario: one fresh node from the fixture's
 * dumped state (`fixture.ts`), driven through the shared scenario chain
 * client (`@vaipakam/anvil-harness/scenarioChain`), so every scenario starts
 * from the same canonical reward deployment and no scenario sees another's
 * transactions or time travel.
 *
 * What is the keeper's own here is the CLOCK: the keeper reads `Date.now()`
 * for every age it judges (an observation is due, an entry is due, a deadline
 * has passed), so a scenario that moves chain time must move the keeper's
 * clock with it. {@link KEEPER_CLOCK} fakes the process's `Date` (only
 * `Date`: timers and I/O stay real) and the chain pins it to the head after
 * every warp.
 *
 * Nothing here signs as the keeper: the keeper signs with its own key, from
 * its own code, through the env the scenario builds (`keeperEnv.ts`).
 */
import { vi } from 'vitest';
import type { Abi } from 'viem';
import { ScenarioChain, type ClockPin } from '@vaipakam/anvil-harness/scenarioChain';
import { E2E_CHAIN_ID, loadFixture, startScenarioChain, type KeeperFixture } from './fixture';

/** The keeper's single-chain scenario chain. */
export type KeeperChain = ScenarioChain<KeeperFixture>;

/** The overlay's owner-only flag setter (`TestnetSanctionsOverlay`). */
export const OVERLAY_ABI = [
  { type: 'function', name: 'setFlagged', stateMutability: 'nonpayable', inputs: [{ name: 'who', type: 'address' }, { name: 'flagged', type: 'bool' }], outputs: [] },
] as const satisfies Abi;

/** The indexer's settled-head depth fallback (`SAFE_FALLBACK_BUFFER`). */
export const SETTLED_DEPTH = 32;

/**
 * The keeper's process clock: `Date` (and only `Date`) faked while a
 * scenario's chain runs, pinned to the chain head by every clock move.
 */
export const KEEPER_CLOCK: ClockPin = {
  pin(unixSeconds: number) {
    vi.setSystemTime(unixSeconds * 1000);
  },
  release() {
    vi.useRealTimers();
  },
};

/**
 * Start a scenario: a fresh node from the fixture state, with the process's
 * `Date` faked (and only `Date`) and pinned to the chain head.
 */
export async function openScenario(): Promise<KeeperChain> {
  const fixture = loadFixture();
  const node = await startScenarioChain();
  const sc = new ScenarioChain<KeeperFixture>(node, fixture, E2E_CHAIN_ID, { name: `keeper-e2e-${E2E_CHAIN_ID}`, clock: KEEPER_CLOCK });
  // A node started from a dump serves state from the load point on, so a
  // read pinned below it (the indexer's settled head, 32 blocks back) is out
  // of range. Start every scenario clear of that depth.
  await sc.mineBlocks(SETTLED_DEPTH + 8);
  vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
  await sc.syncClock();
  return sc;
}
