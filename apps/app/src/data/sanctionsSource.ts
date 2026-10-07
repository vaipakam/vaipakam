/**
 * #2439 — why a wallet is flagged, so the banner can name the right recourse.
 *
 * The Diamond screens against whatever oracle it is configured with. On a
 * test network that is a `TestnetSanctionsOverlay`: the network admin's test
 * list, optionally layered over another sanctions list. A wallet can also be
 * flagged without being listed at all, when the sender it declared during
 * token recovery is listed. Each case has a different recourse, and sending a
 * user to the wrong party is the false statement this module exists to
 * prevent.
 *
 * It names no provider. Chainalysis's on-chain oracle, which this module once
 * named, was retired by Chainalysis on 2026-03-18 (#2443), and the Diamond
 * accepts any address as its oracle, so a list's provider cannot be inferred
 * from the oracle alone.
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
const ORACLE_ABI = parseAbi(['function isSanctioned(address) view returns (bool)']);

/**
 * One reason in an explanation — {@link readSanctionsSource} returns one or
 * two of these, because a wallet can be flagged for two reasons at once.
 *
 * - `testList`: this test network's own test list flags the wallet, and no
 *   other list it extends does (or it extends none).
 * - `both`: the test list flags it, and so does the list it extends.
 * - `testListUpstreamUnread`: the test list flags it; whether the list it
 *   extends also does could not be read.
 * - `otherList`: the sanctions list the deployment screens against flags it
 *   — the configured oracle itself when it is not a test list, or the list a
 *   test list extends — and the test list does not.
 * - `bannedSource`: no list flags the wallet itself; the sender it declared
 *   during token recovery is flagged.
 * - `alsoBannedSource`: follows a reason above — the wallet's declared sender
 *   is flagged as well, so clearing the wallet alone would not lift the flag.
 * - `bannedSourceUnread`: follows a reason above — the wallet declared a
 *   sender, and whether that sender is flagged too could not be read.
 * - `unknown`: why the wallet is flagged could not be determined — a read
 *   failed, or at the block read nothing flags it any more (the flag changed
 *   after the banner's own check).
 */
export type SanctionsSource =
  | 'testList'
  | 'both'
  | 'testListUpstreamUnread'
  | 'otherList'
  | 'bannedSource'
  | 'alsoBannedSource'
  | 'bannedSourceUnread'
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

/** One consistent snapshot of how the configured oracle answers for the
 *  wallet itself, all read at ONE block, for {@link classifyWallet}. */
export type OracleReads =
  | {
      /** The oracle is not a test list (it has no `upstream()`). */
      kind: 'direct';
      /** Its answer for the wallet; null when unread. */
      flagged: boolean | null;
    }
  | {
      kind: 'overlay';
      /** `upstream()` — the list the test list extends, or the zero address
       *  when it extends none. */
      upstream: `0x${string}`;
      /** The test list's own flag on the wallet. */
      byOverlay: boolean;
      /** The upstream's answer, as the overlay read it; null when there is
       *  no upstream or that read failed. */
      byUpstream: boolean | null;
    };

/** What a snapshot says about the wallet ITSELF: an attribution, or that
 *  nothing flags it (`notFlagged`), or that it cannot be told (`unread`). */
export type WalletReading =
  | 'testList'
  | 'both'
  | 'testListUpstreamUnread'
  | 'otherList'
  | 'notFlagged'
  | 'unread';

/** What a snapshot says about the sender the wallet declared during token
 *  recovery: none declared, flagged, not flagged, or unreadable. */
export type SenderReading = 'none' | 'flagged' | 'clear' | 'unread';

/** Pure combination of the two subjects the Diamond screens for a wallet —
 *  the wallet itself and its declared recovery sender — into the reasons the
 *  banner states. Both are always read, so a wallet flagged for both reasons
 *  is told both: naming only one would point it at a recourse that cannot
 *  lift the flag on its own. */
export function explain(own: WalletReading, sender: SenderReading): SanctionsSource[] {
  if (own === 'unread') return ['unknown'];
  if (own === 'notFlagged') return sender === 'flagged' ? ['bannedSource'] : ['unknown'];
  if (sender === 'flagged') return [own, 'alsoBannedSource'];
  if (sender === 'unread') return [own, 'bannedSourceUnread'];
  return [own];
}

/** Pure decision over one snapshot, so every branch is testable without a
 *  chain. Never names a list the snapshot does not show flagging. */
export function classifyWallet(reads: OracleReads): WalletReading {
  if (reads.kind === 'direct') {
    if (reads.flagged === null) return 'unread';
    return reads.flagged ? 'otherList' : 'notFlagged';
  }
  if (reads.upstream === zeroAddress) return reads.byOverlay ? 'testList' : 'notFlagged';
  if (reads.byUpstream === null) return reads.byOverlay ? 'testListUpstreamUnread' : 'unread';
  if (reads.byOverlay) return reads.byUpstream ? 'both' : 'testList';
  return reads.byUpstream ? 'otherList' : 'notFlagged';
}

/** How `oracle` answers for `wallet` at `blockNumber`. */
async function readWallet(
  publicClient: PublicClient,
  oracle: `0x${string}`,
  wallet: `0x${string}`,
  blockNumber: bigint,
): Promise<WalletReading> {
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
    if (!isNoSuchFunction(err)) return 'unread';
    // Not a test list: its own answer at this block is the whole story.
    let flagged: boolean | null;
    try {
      flagged = (await publicClient.readContract({
        address: oracle,
        abi: ORACLE_ABI,
        functionName: 'isSanctioned',
        args: [wallet],
        blockNumber,
      })) as boolean;
    } catch {
      flagged = null;
    }
    return classifyWallet({ kind: 'direct', flagged });
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
      return classifyWallet({ kind: 'overlay', upstream, byOverlay, byUpstream });
    } catch {
      // The upstream could not be read (its outage reverts the whole call);
      // the test list's own flag still can be.
    }
  }

  try {
    const byOverlay = (await publicClient.readContract({
      address: oracle,
      abi: OVERLAY_ABI,
      functionName: 'flaggedByOverlay',
      args: [wallet],
      blockNumber,
    })) as boolean;
    return classifyWallet({ kind: 'overlay', upstream, byOverlay, byUpstream: null });
  } catch {
    return 'unread';
  }
}

/** How the Diamond's declared recovery sender for `wallet` stands with
 *  `oracle` at `blockNumber`. */
async function readSender(
  publicClient: PublicClient,
  diamond: `0x${string}`,
  oracle: `0x${string}`,
  wallet: `0x${string}`,
  blockNumber: bigint,
): Promise<SenderReading> {
  try {
    const source = (await publicClient.readContract({
      address: diamond,
      abi: DIAMOND_ABI_VIEM,
      functionName: 'vaultBannedSource',
      args: [wallet],
      blockNumber,
    })) as `0x${string}`;
    if (source === zeroAddress) return 'none';
    const flagged = (await publicClient.readContract({
      address: oracle,
      abi: ORACLE_ABI,
      functionName: 'isSanctioned',
      args: [source],
      blockNumber,
    })) as boolean;
    return flagged ? 'flagged' : 'clear';
  } catch {
    return 'unread';
  }
}

/** Reads the configured oracle and explains `wallet`'s flag as one or two
 *  reasons (see {@link explain}). Never throws: a read that cannot be
 *  completed yields `unknown`, or a reason saying what could not be read.
 *
 *  Every read is pinned to one block, so the answer describes a single
 *  on-chain state: a flag added or cleared between two reads cannot be
 *  stitched into an explanation no block ever had.
 *
 *  The Diamond flags a wallet when the oracle flags the wallet itself OR the
 *  sender it declared during token recovery (`vaultBannedSource`), so both
 *  subjects are read every time. */
export async function readSanctionsSource(
  publicClient: PublicClient,
  diamond: `0x${string}`,
  wallet: `0x${string}`,
): Promise<SanctionsSource[]> {
  let blockNumber: bigint;
  try {
    blockNumber = await publicClient.getBlockNumber();
  } catch {
    return ['unknown'];
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
    return ['unknown'];
  }
  if (oracle === zeroAddress) return ['unknown'];

  const own = await readWallet(publicClient, oracle, wallet, blockNumber);
  if (own === 'unread') return ['unknown'];
  const sender = await readSender(publicClient, diamond, oracle, wallet, blockNumber);
  return explain(own, sender);
}
