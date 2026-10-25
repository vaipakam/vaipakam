/**
 * One two-chain scenario: the canonical chain and the mirror, each on a fresh
 * node from a {@link MeshFixtureStore}'s dumped state, the relay that carries
 * the lane between them, and ONE clock for both.
 *
 * On a live mesh both chains run on the same wall clock. Two anvil nodes each
 * keep their own, so {@link MeshScenario.warp} moves BOTH heads to the same
 * target timestamp (and pins the suite's process clock to it, when the suite
 * passed one — see {@link ClockPin}).
 *
 * Nothing here composes a cross-chain message: the relay ({@link CcipRelay})
 * can only deliver what a source chain's on-ramp emitted, and the scenario
 * decides only WHEN it lands.
 */
import type { Hex } from 'viem';
import { CcipRelay } from './ccipLane';
import { BASE_ID, MIRROR_ID, type MeshChainFixture, type MeshFixture, type MeshFixtureStore } from './mesh';
import { ScenarioChain, type ClockPin } from './scenarioChain';

export type MeshChain = ScenarioChain<MeshChainFixture>;

export interface MeshScenario {
  fixture: MeshFixture;
  base: MeshChain;
  mirror: MeshChain;
  relay: CcipRelay;
  /** Move both chains' clocks forward by `seconds` to one shared timestamp,
   *  mine on both, and pin the suite's clock to it. Returns that timestamp. */
  warp(seconds: number): Promise<number>;
  /** Pin the suite's clock to the later of the two heads; returns it. */
  syncClock(): Promise<number>;
  stop(): Promise<void>;
}

export interface OpenMeshScenarioOptions {
  /** The suite's process clock, if its code under test reads one. */
  clock?: ClockPin;
  /** Blocks to mine on each node before anything runs. A node started from a
   *  dump serves state from the load point on, so a suite whose reader looks
   *  a fixed depth behind the head starts that far clear of it. */
  warmupBlocks?: number;
  /** A prefix for the chains' display names. */
  name?: string;
}

/** Start a two-chain scenario (see the header). */
export async function openMeshScenario(store: MeshFixtureStore, opts: OpenMeshScenarioOptions = {}): Promise<MeshScenario> {
  const fixture = store.load();
  const baseNode = await store.startNode(BASE_ID);
  const mirrorNode = await store.startNode(MIRROR_ID);
  const prefix = opts.name ?? 'e2e-mesh';
  const base = new ScenarioChain<MeshChainFixture>(baseNode, fixture.base, BASE_ID, { name: `${prefix}-${BASE_ID}`, clock: opts.clock });
  const mirror = new ScenarioChain<MeshChainFixture>(mirrorNode, fixture.mirror, MIRROR_ID, { name: `${prefix}-${MIRROR_ID}`, clock: opts.clock });
  const relay = new CcipRelay(
    [
      { url: base.url, chainId: BASE_ID, lane: fixture.base.lane },
      { url: mirror.url, chainId: MIRROR_ID, lane: fixture.mirror.lane },
    ],
    fixture.relayerKey as Hex,
  );
  if (opts.warmupBlocks) {
    await base.mineBlocks(opts.warmupBlocks);
    await mirror.mineBlocks(opts.warmupBlocks);
  }

  const syncClock = async (): Promise<number> => {
    const ts = Math.max(await base.now(), await mirror.now());
    opts.clock?.pin(ts);
    return ts;
  };
  const warp = async (seconds: number): Promise<number> => {
    const target = Math.max(await base.now(), await mirror.now()) + Math.max(1, Math.floor(seconds));
    await base.mineAt(target);
    await mirror.mineAt(target);
    return target;
  };
  // One shared head before anything runs.
  await warp(1);
  return {
    fixture,
    base,
    mirror,
    relay,
    warp,
    syncClock,
    async stop() {
      opts.clock?.release();
      await Promise.all([base.node.stop(), mirror.node.stop()]);
    },
  };
}
