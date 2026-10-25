/**
 * What the VPFI lane can carry right now, and waiting until it carries an
 * amount.
 *
 * Each VPFI pool rate-limits the lane per direction: an OUTBOUND bucket on the
 * sending chain's pool, checked when the message is sent, and an INBOUND
 * bucket on the receiving chain's, checked when it lands. A bucket that the
 * rate governor sets on a lane added with no limit starts EMPTY, not full
 * (CCIP's `RateLimiter._setTokenBucketConfig` keeps the smaller of the new
 * capacity and the tokens already in the bucket, which is none), and refills
 * at its rate from then on. A live lane is the same right after it is wired.
 *
 * A scenario node's clock follows wall time, so how full a bucket is when a
 * scenario first crosses depends on how long the build and the run took
 * (#2853's run reached the mirror's inbound bucket 17 s after it was set,
 * with 98.6 of 100 VPFI in it). So every crossing a scenario makes first asks
 * {@link waitForLane}, which reads both buckets and moves the mesh's shared
 * clock forward just far enough, and states it when it does.
 */
import type { Abi, Address } from 'viem';
import type { MeshChain, MeshScenario } from '@vaipakam/anvil-harness/meshScenario';

/** `TokenPool`'s bucket views (`RateLimiter.TokenBucket`). */
const BUCKET = {
  type: 'tuple',
  components: [
    { name: 'tokens', type: 'uint128' },
    { name: 'lastUpdated', type: 'uint32' },
    { name: 'isEnabled', type: 'bool' },
    { name: 'capacity', type: 'uint128' },
    { name: 'rate', type: 'uint128' },
  ],
} as const;
const POOL_ABI = [
  { type: 'function', name: 'getCurrentOutboundRateLimiterState', stateMutability: 'view', inputs: [{ name: 'remoteChainSelector', type: 'uint64' }], outputs: [BUCKET] },
  { type: 'function', name: 'getCurrentInboundRateLimiterState', stateMutability: 'view', inputs: [{ name: 'remoteChainSelector', type: 'uint64' }], outputs: [BUCKET] },
] as const satisfies Abi;

interface Bucket {
  tokens: bigint;
  isEnabled: boolean;
  capacity: bigint;
  rate: bigint;
}

/** One chain's VPFI pool (lock/release on Base, burn/mint on the mirror). */
function pool(sc: MeshChain): Address {
  return sc.fixture.artifact.vpfiTokenPool as Address;
}

/** Seconds until `bucket` holds `amount`; throws if it never can. */
function secondsUntil(bucket: Bucket, amount: bigint, what: string): number {
  if (!bucket.isEnabled || bucket.tokens >= amount) return 0;
  if (bucket.capacity < amount) throw new Error(`${what} holds at most ${bucket.capacity} wei, so it can never carry ${amount}`);
  if (bucket.rate === 0n) throw new Error(`${what} holds ${bucket.tokens} wei and never refills, so it cannot carry ${amount}`);
  const short = amount - bucket.tokens;
  return Number((short + bucket.rate - 1n) / bucket.rate);
}

/**
 * Wait until a crossing of `amount` VPFI from `from` to `to` fits both of its
 * buckets: move the mesh's shared clock forward by the longer of the two
 * refills, if either is short. Returns the seconds waited (0 when both
 * already hold enough).
 */
export async function waitForLane(m: MeshScenario, from: MeshChain, to: MeshChain, amount: bigint): Promise<number> {
  // Each pool keys a direction by the OTHER chain's selector.
  const outbound = (await from.pub.readContract({
    address: pool(from),
    abi: POOL_ABI,
    functionName: 'getCurrentOutboundRateLimiterState',
    args: [BigInt(from.fixture.lane.remoteChainSelector)],
  })) as Bucket;
  const inbound = (await to.pub.readContract({
    address: pool(to),
    abi: POOL_ABI,
    functionName: 'getCurrentInboundRateLimiterState',
    args: [BigInt(to.fixture.lane.remoteChainSelector)],
  })) as Bucket;
  const wait = Math.max(
    secondsUntil(outbound, amount, `${from.fixture.chainId}'s outbound bucket`),
    secondsUntil(inbound, amount, `${to.fixture.chainId}'s inbound bucket`),
  );
  if (wait > 0) {
    console.log(`[protocol-e2e] the VPFI lane ${from.fixture.chainId}→${to.fixture.chainId} is still refilling; waiting ${wait}s of chain time to carry ${amount} wei`);
    await m.warp(wait);
  }
  return wait;
}
