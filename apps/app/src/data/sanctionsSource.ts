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
 * - `provider`: the sanctions-data provider (Chainalysis) flags it — either
 *   the oracle is the provider's own, or it is a test list that reads the
 *   provider as flagging the wallet and has not flagged it itself.
 * - `testList`: only this test network's test list flags it; the provider
 *   was read and reports the wallet clean.
 * - `testListNoProvider`: the test list flags it on a network where the
 *   provider publishes no oracle, so there was no provider list to read.
 * - `both`: the test list and the provider both flag it.
 * - `testListProviderUnread`: the test list flags it; whether the provider
 *   also does could not be read.
 * - `unknown`: which list flagged it could not be determined — a read
 *   failed, or at the block read neither list flags it (the flag changed
 *   after the banner's own check).
 */
export type SanctionsSource =
  | 'provider'
  | 'testList'
  | 'testListNoProvider'
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

/** What the overlay's own reads said, all at ONE block, for
 *  {@link classifySanctionsSource}. */
export interface OverlayReads {
  /** `upstream()` — the provider's oracle the test list extends, or the
   *  zero address when the network has none. */
  upstream: `0x${string}`;
  /** The test list's own flag on the wallet. */
  byOverlay: boolean;
  /** The provider's answer, as the overlay read it; null when there is no
   *  provider or that read failed. */
  byUpstream: boolean | null;
}

/** Pure decision over one consistent snapshot, so every branch is testable
 *  without a chain. Never names a list it did not read as flagging. */
export function classifySanctionsSource(reads: OverlayReads | 'notOverlay'): SanctionsSource {
  if (reads === 'notOverlay') return 'provider';
  if (reads.upstream === zeroAddress) return reads.byOverlay ? 'testListNoProvider' : 'unknown';
  if (reads.byUpstream === null) return reads.byOverlay ? 'testListProviderUnread' : 'unknown';
  if (reads.byOverlay) return reads.byUpstream ? 'both' : 'testList';
  return reads.byUpstream ? 'provider' : 'unknown';
}

/** Reads the configured oracle and attributes `wallet`'s flag. Never throws:
 *  a read that cannot be completed yields `unknown`.
 *
 *  Every read is pinned to one block, so the answer describes a single
 *  on-chain state: an owner flag or a provider delisting landing between two
 *  reads cannot be stitched into an attribution no block ever had. */
export async function readSanctionsSource(
  publicClient: PublicClient,
  diamond: `0x${string}`,
  wallet: `0x${string}`,
): Promise<SanctionsSource> {
  let blockNumber: bigint;
  try {
    blockNumber = await publicClient.getBlockNumber();
  } catch {
    return 'unknown';
  }

  let oracle: `0x${string}`;
  try {
    oracle = (await publicClient.readContract({
      address: diamond,
      abi: DIAMOND_ABI_VIEM,
      functionName: 'getSanctionsOracle',
      blockNumber,
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
      blockNumber,
    })) as `0x${string}`;
  } catch (err) {
    return isNoSuchFunction(err) ? classifySanctionsSource('notOverlay') : 'unknown';
  }

  // One call answers both lists, so they cannot disagree about the moment.
  if (upstream !== zeroAddress) {
    try {
      const [byOverlay, byUpstream] = (await publicClient.readContract({
        address: oracle,
        abi: OVERLAY_ABI,
        functionName: 'sanctionSource',
        args: [wallet],
        blockNumber,
      })) as readonly [boolean, boolean];
      return classifySanctionsSource({ upstream, byOverlay, byUpstream });
    } catch {
      // The provider could not be read (its outage reverts the whole call);
      // the test list's own flag still can be.
    }
  }

  let byOverlay: boolean;
  try {
    byOverlay = (await publicClient.readContract({
      address: oracle,
      abi: OVERLAY_ABI,
      functionName: 'flaggedByOverlay',
      args: [wallet],
      blockNumber,
    })) as boolean;
  } catch {
    return 'unknown';
  }
  return classifySanctionsSource({ upstream, byOverlay, byUpstream: null });
}
