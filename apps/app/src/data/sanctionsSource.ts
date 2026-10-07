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
  parseAbi,
  zeroAddress,
  type Abi,
  type PublicClient,
} from 'viem';
import { DIAMOND_ABI_VIEM, TestnetSanctionsOverlayABI } from '@vaipakam/contracts/abis';

const OVERLAY_ABI = TestnetSanctionsOverlayABI as unknown as Abi;

/** The surface of Chainalysis's oracle this module reads: its owner, to
 *  establish that a contract IS Chainalysis's, and its screening answer. */
const PROVIDER_ABI = parseAbi([
  'function owner() view returns (address)',
  'function isSanctioned(address) view returns (bool)',
]);

/**
 * The owner every Chainalysis sanctions oracle reports, on every chain it is
 * deployed to. It is the identity check `ConfigureSanctionsOracle.s.sol`
 * applies before pointing a Diamond at Chainalysis (`CHAINALYSIS_OWNER`
 * there; `sanctionsSource.test.ts` fails if the two diverge), and this module
 * applies the same check before NAMING Chainalysis: the Diamond accepts any
 * address as its oracle, so a contract's merely lacking the test list's
 * functions proves nothing about whose list it is.
 */
export const CHAINALYSIS_ORACLE_OWNER = '0xDF900dC8991474ab9d69F2c3b9C900c055fb36CD' as const;

/**
 * - `provider`: the sanctions-data provider (Chainalysis) flags it — either
 *   the oracle is the provider's own and flags it, or it is a test list
 *   whose upstream is the provider's own and reads it as flagging the
 *   wallet, and the test list has not flagged it itself.
 * - `testList`: only this test network's test list flags it; the provider
 *   was read and reports the wallet clean.
 * - `testListNoProvider`: the test list flags it on a network where the
 *   provider publishes no oracle, so there was no provider list to read.
 * - `both`: the test list and the provider both flag it.
 * - `testListProviderUnread`: the test list flags it; whether the provider
 *   also does could not be established — its read failed, or the test
 *   list's upstream could not be confirmed as the provider's own.
 * - `unknown`: which list flagged it could not be determined — a read
 *   failed, the oracle could not be confirmed as the provider's own, or at
 *   the block read no list flags it (the flag changed after the banner's
 *   own check).
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

/** One consistent snapshot of the configured oracle, all read at ONE block,
 *  for {@link classifySanctionsSource}. */
export type OracleReads =
  | {
      /** The oracle is not a test list (it has no `upstream()`). */
      kind: 'direct';
      /** It reports Chainalysis's owner — it is Chainalysis's own. */
      isProvider: boolean;
      /** Its screening answer for the wallet; null when unread. */
      flagged: boolean | null;
    }
  | {
      kind: 'overlay';
      /** `upstream()` — the oracle the test list extends, or the zero
       *  address when the network has none. */
      upstream: `0x${string}`;
      /** That upstream reports Chainalysis's owner. */
      upstreamIsProvider: boolean;
      /** The test list's own flag on the wallet. */
      byOverlay: boolean;
      /** The upstream's answer, as the overlay read it; null when there is
       *  no upstream or that read failed. */
      byUpstream: boolean | null;
    };

/** Pure decision over one snapshot, so every branch is testable without a
 *  chain. The one rule: a list is named only when the snapshot shows it
 *  flagging the wallet, and Chainalysis is named only for a contract shown
 *  to be Chainalysis's. */
export function classifySanctionsSource(reads: OracleReads): SanctionsSource {
  if (reads.kind === 'direct') {
    return reads.isProvider && reads.flagged === true ? 'provider' : 'unknown';
  }
  if (reads.upstream === zeroAddress) return reads.byOverlay ? 'testListNoProvider' : 'unknown';
  // An upstream not shown to be Chainalysis's says nothing about Chainalysis.
  const byProvider = reads.upstreamIsProvider ? reads.byUpstream : null;
  if (byProvider === null) return reads.byOverlay ? 'testListProviderUnread' : 'unknown';
  if (reads.byOverlay) return byProvider ? 'both' : 'testList';
  return byProvider ? 'provider' : 'unknown';
}

/** Whether `oracle` reports Chainalysis's owner at `blockNumber`. A failed
 *  read is "not shown", never "yes". */
async function isChainalysisOracle(
  publicClient: PublicClient,
  oracle: `0x${string}`,
  blockNumber: bigint,
): Promise<boolean> {
  try {
    const owner = (await publicClient.readContract({
      address: oracle,
      abi: PROVIDER_ABI,
      functionName: 'owner',
      blockNumber,
    })) as `0x${string}`;
    return owner.toLowerCase() === CHAINALYSIS_ORACLE_OWNER.toLowerCase();
  } catch {
    return false;
  }
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
  // cannot make a test list look like a direct oracle.
  let upstream: `0x${string}`;
  try {
    upstream = (await publicClient.readContract({
      address: oracle,
      abi: OVERLAY_ABI,
      functionName: 'upstream',
      blockNumber,
    })) as `0x${string}`;
  } catch (err) {
    if (!isNoSuchFunction(err)) return 'unknown';
    // Not a test list. Name Chainalysis only if the oracle is Chainalysis's
    // own AND flags the wallet at this block.
    const isProvider = await isChainalysisOracle(publicClient, oracle, blockNumber);
    if (!isProvider) return classifySanctionsSource({ kind: 'direct', isProvider, flagged: null });
    let flagged: boolean | null;
    try {
      flagged = (await publicClient.readContract({
        address: oracle,
        abi: PROVIDER_ABI,
        functionName: 'isSanctioned',
        args: [wallet],
        blockNumber,
      })) as boolean;
    } catch {
      flagged = null;
    }
    return classifySanctionsSource({ kind: 'direct', isProvider, flagged });
  }

  const upstreamIsProvider =
    upstream !== zeroAddress && (await isChainalysisOracle(publicClient, upstream, blockNumber));

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
      return classifySanctionsSource({ kind: 'overlay', upstream, upstreamIsProvider, byOverlay, byUpstream });
    } catch {
      // The upstream could not be read (its outage reverts the whole call);
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
  return classifySanctionsSource({ kind: 'overlay', upstream, upstreamIsProvider, byOverlay, byUpstream: null });
}
