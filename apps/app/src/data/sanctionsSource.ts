/**
 * #2439 — which list flagged a wallet.
 *
 * On a mainnet the Diamond screens against Chainalysis's oracle directly. On
 * a test network it screens against a `TestnetSanctionsOverlay`: Chainalysis's
 * list for that chain plus addresses the network's admin flagged for testing.
 * The banner tells a flagged user whom to contact, so it must know which list
 * made the flag — sending someone to Chainalysis about a flag Chainalysis never
 * made is the false statement this module exists to prevent.
 *
 * Read ONLY once the Diamond has already reported the wallet flagged; it
 * explains a flag, it never decides one.
 */
import {
  BaseError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  zeroAddress,
  type Abi,
  type PublicClient,
} from 'viem';
import { DIAMOND_ABI_VIEM, TestnetSanctionsOverlayABI } from '@vaipakam/contracts/abis';

const OVERLAY_ABI = TestnetSanctionsOverlayABI as unknown as Abi;

/**
 * - `provider`: the sanctions-data provider (Chainalysis) flags it, and no
 *   test list is involved — either the oracle is the provider's own, or it is
 *   a test list that has not flagged this wallet.
 * - `testList`: only this test network's test list flags it.
 * - `both`: the test list and the provider both flag it.
 * - `testListProviderUnread`: the test list flags it; whether the provider
 *   also does could not be read.
 * - `unknown`: which list flagged it could not be determined.
 */
export type SanctionsSource =
  | 'provider'
  | 'testList'
  | 'both'
  | 'testListProviderUnread'
  | 'unknown';

/** True iff `err` is the CONTRACT's answer that it has no such function — a
 *  revert, or empty return data — as opposed to the read failing to reach it.
 *  Only the former proves the oracle is not a test list. */
export function isNoSuchFunction(err: unknown): boolean {
  if (!(err instanceof BaseError)) return false;
  return (
    err.walk(
      (e) =>
        e instanceof ContractFunctionRevertedError ||
        e instanceof ContractFunctionZeroDataError,
    ) !== null
  );
}

/** What the overlay's own reads said, for {@link classifySanctionsSource}. */
export interface OverlayReads {
  /** `upstream()` — the provider's oracle the test list extends, or the
   *  zero address when the network has none. */
  upstream: `0x${string}`;
  /** `flaggedByOverlay(wallet)`. */
  byOverlay: boolean;
  /** `sanctionSource(wallet).byUpstream`, or null when that read failed. */
  byUpstream: boolean | null;
}

/** Pure decision over the reads, so every branch is testable without a chain. */
export function classifySanctionsSource(reads: OverlayReads | 'notOverlay'): SanctionsSource {
  if (reads === 'notOverlay') return 'provider';
  if (!reads.byOverlay) return 'provider';
  if (reads.upstream === zeroAddress) return 'testList';
  if (reads.byUpstream === null) return 'testListProviderUnread';
  return reads.byUpstream ? 'both' : 'testList';
}

/** Reads the configured oracle and attributes `wallet`'s flag. Never throws:
 *  a read that cannot be completed yields `unknown`. */
export async function readSanctionsSource(
  publicClient: PublicClient,
  diamond: `0x${string}`,
  wallet: `0x${string}`,
): Promise<SanctionsSource> {
  let oracle: `0x${string}`;
  try {
    oracle = (await publicClient.readContract({
      address: diamond,
      abi: DIAMOND_ABI_VIEM,
      functionName: 'getSanctionsOracle',
    })) as `0x${string}`;
  } catch {
    return 'unknown';
  }
  if (oracle === zeroAddress) return 'unknown';

  // `upstream()` never touches the upstream oracle, so an upstream outage
  // cannot make a test list look like the provider's own oracle.
  let upstream: `0x${string}`;
  try {
    upstream = (await publicClient.readContract({
      address: oracle,
      abi: OVERLAY_ABI,
      functionName: 'upstream',
    })) as `0x${string}`;
  } catch (err) {
    return isNoSuchFunction(err) ? classifySanctionsSource('notOverlay') : 'unknown';
  }

  let byOverlay: boolean;
  try {
    byOverlay = (await publicClient.readContract({
      address: oracle,
      abi: OVERLAY_ABI,
      functionName: 'flaggedByOverlay',
      args: [wallet],
    })) as boolean;
  } catch {
    return 'unknown';
  }

  let byUpstream: boolean | null = null;
  if (byOverlay && upstream !== zeroAddress) {
    try {
      const [, up] = (await publicClient.readContract({
        address: oracle,
        abi: OVERLAY_ABI,
        functionName: 'sanctionSource',
        args: [wallet],
      })) as readonly [boolean, boolean];
      byUpstream = up;
    } catch {
      byUpstream = null;
    }
  }
  return classifySanctionsSource({ upstream, byOverlay, byUpstream });
}
