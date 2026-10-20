/**
 * One two-chain scenario: the canonical chain and the mirror, each on a fresh
 * node from the mesh fixture's dumped state (`fixture.ts`), the relay that
 * carries the lane between them, and ONE clock for both.
 *
 * The keeper reads `Date.now()` for every age it judges, and on a live mesh
 * both chains run on the same wall clock. Two anvil nodes each keep their
 * own, so {@link MeshScenario.warp} moves BOTH heads to the same target
 * timestamp and pins the process's `Date` (only `Date`) to it.
 *
 * Nothing here signs as the keeper, and nothing here composes a cross-chain
 * message: the relay ({@link CcipRelay}) can only deliver what a source
 * chain's on-ramp emitted, and the scenario decides only WHEN it lands.
 */
import { vi } from 'vitest';
import type { Hex } from 'viem';
import { CcipRelay } from '@vaipakam/anvil-harness/ccipLane';
import { SETTLED_DEPTH, ScenarioChain } from '../harness/chain';
import { BASE_ID, loadMeshFixture, MIRROR_ID, startMeshNode, type MeshChainFixture, type MeshFixture } from './fixture';

export type MeshChain = ScenarioChain<MeshChainFixture>;

export interface MeshScenario {
  fixture: MeshFixture;
  base: MeshChain;
  mirror: MeshChain;
  relay: CcipRelay;
  /** Move both chains' clocks forward by `seconds` to one shared timestamp,
   *  mine on both, and pin the keeper's clock to it. Returns that timestamp. */
  warp(seconds: number): Promise<number>;
  /** Pin the keeper's clock to the later of the two heads. */
  syncClock(): Promise<number>;
  stop(): Promise<void>;
}

async function setNextTimestamp(sc: MeshChain, ts: number): Promise<void> {
  await sc.node.control.rpc('evm_setNextBlockTimestamp', [`0x${ts.toString(16)}`]);
  await sc.mineBlocks(1);
}

/** Start a two-chain scenario (see the header). */
export async function openMeshScenario(): Promise<MeshScenario> {
  const fixture = loadMeshFixture();
  const baseNode = await startMeshNode(BASE_ID);
  const mirrorNode = await startMeshNode(MIRROR_ID);
  const base = new ScenarioChain<MeshChainFixture>(baseNode, fixture.base, BASE_ID);
  const mirror = new ScenarioChain<MeshChainFixture>(mirrorNode, fixture.mirror, MIRROR_ID);
  const relay = new CcipRelay(
    [
      { url: base.url, chainId: BASE_ID, lane: fixture.base.lane },
      { url: mirror.url, chainId: MIRROR_ID, lane: fixture.mirror.lane },
    ],
    fixture.relayerKey as Hex,
  );
  // A node started from a dump serves state from the load point on: start
  // both clear of the indexer's settled depth (as `openScenario` does).
  await base.mineBlocks(SETTLED_DEPTH + 8);
  await mirror.mineBlocks(SETTLED_DEPTH + 8);
  vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });

  const syncClock = async (): Promise<number> => {
    const ts = Math.max(await base.now(), await mirror.now());
    vi.setSystemTime(ts * 1000);
    return ts;
  };
  const warp = async (seconds: number): Promise<number> => {
    const target = Math.max(await base.now(), await mirror.now()) + Math.max(1, Math.floor(seconds));
    await setNextTimestamp(base, target);
    await setNextTimestamp(mirror, target);
    vi.setSystemTime(target * 1000);
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
      vi.useRealTimers();
      await Promise.all([base.node.stop(), mirror.node.stop()]);
    },
  };
}
