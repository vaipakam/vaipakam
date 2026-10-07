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
 * The flag itself is always the Diamond's own answer, read at the same block
 * as its explanation; this module explains a flag, it never decides one.
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
 * One line in an explanation — {@link readSanctionsSnapshot} returns one or
 * more of these, because a wallet can be flagged for two reasons at once and
 * each reason names its own list.
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
 * - `alsoBannedSource`: follows the wallet's own line — its declared sender
 *   is flagged as well, so clearing the wallet alone would not lift the flag.
 * - `bannedSourceWalletUnread`: the declared sender is flagged, which flags
 *   the wallet by itself; whether the wallet is also listed could not be read.
 * - `senderTestList` / `senderBoth` / `senderTestListUpstreamUnread` /
 *   `senderOtherList`: follow one of the three sender lines above — which
 *   list flags the declared sender, and so whom to contact about it, with
 *   the same meanings as the wallet's lines.
 * - `bannedSourceUnread`: follows the wallet's own line — the wallet
 *   declared a sender, and whether that sender is flagged could not be read.
 * - `senderLookupUnread`: follows the wallet's own line — whether the wallet
 *   declared a sender at all could not be read.
 * - `unknown`: why the wallet is flagged could not be determined — a read
 *   failed, the block was replaced while it was read, or no list the oracle
 *   exposes accounts for the Diamond's flag.
 */
export type SanctionsSource =
  | 'testList'
  | 'both'
  | 'testListUpstreamUnread'
  | 'otherList'
  | 'bannedSource'
  | 'alsoBannedSource'
  | 'bannedSourceWalletUnread'
  | 'senderTestList'
  | 'senderBoth'
  | 'senderTestListUpstreamUnread'
  | 'senderOtherList'
  | 'bannedSourceUnread'
  | 'senderLookupUnread'
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

/** What a snapshot says about one screened address — the wallet, or the
 *  sender it declared during token recovery: which list flags it, or that
 *  nothing does (`notFlagged`), or that it cannot be told (`unread`). */
export type SubjectReading =
  | 'testList'
  | 'both'
  | 'testListUpstreamUnread'
  | 'otherList'
  | 'notFlagged'
  | 'unread';

type Listing = Exclude<SubjectReading, 'notFlagged' | 'unread'>;

/** What is known of the sender the wallet declared during token recovery
 *  (`vaultBannedSource`): none declared; the lookup itself failed, so not
 *  even whether one exists is known; or one is declared, classified through
 *  the same path as the wallet. */
export type SenderReading =
  | { kind: 'none' }
  | { kind: 'lookupFailed' }
  | { kind: 'declared'; reading: SubjectReading };

function isListing(r: SubjectReading): r is Listing {
  return r !== 'notFlagged' && r !== 'unread';
}

/** The line naming the list that flags the declared sender, and so whom to
 *  contact about it — the sender's counterpart of the wallet's own line. */
const SENDER_LINE: Record<Listing, SanctionsSource> = {
  testList: 'senderTestList',
  both: 'senderBoth',
  testListUpstreamUnread: 'senderTestListUpstreamUnread',
  otherList: 'senderOtherList',
};

/** Pure combination of the two subjects the Diamond screens for a wallet —
 *  the wallet itself and its declared recovery sender — into the reasons the
 *  banner states, in order. Each subject is judged on its own reading, so
 *  what is established about one is never lost to a failed read of the
 *  other, and nothing is said about a subject that was not established:
 *  a failed lookup is not reported as a declared sender. When nothing is
 *  established about either, the answer is `unknown`. */
export function explain(own: SubjectReading, sender: SenderReading): SanctionsSource[] {
  const lines: SanctionsSource[] = [];
  const walletListed = isListing(own);
  if (walletListed) lines.push(own);
  if (sender.kind === 'lookupFailed') {
    if (walletListed) lines.push('senderLookupUnread');
  } else if (sender.kind === 'declared') {
    const r = sender.reading;
    if (isListing(r)) {
      lines.push(
        walletListed
          ? 'alsoBannedSource'
          : own === 'unread'
            ? 'bannedSourceWalletUnread'
            : 'bannedSource',
        SENDER_LINE[r],
      );
    } else if (r === 'unread' && walletListed) {
      lines.push('bannedSourceUnread');
    }
  }
  return lines.length > 0 ? lines : ['unknown'];
}

/** Pure decision over one snapshot, so every branch is testable without a
 *  chain. Never names a list the snapshot does not show flagging. */
export function classifySubject(reads: OracleReads): SubjectReading {
  if (reads.kind === 'direct') {
    if (reads.flagged === null) return 'unread';
    return reads.flagged ? 'otherList' : 'notFlagged';
  }
  if (reads.upstream === zeroAddress) return reads.byOverlay ? 'testList' : 'notFlagged';
  if (reads.byUpstream === null) return reads.byOverlay ? 'testListUpstreamUnread' : 'unread';
  if (reads.byOverlay) return reads.byUpstream ? 'both' : 'testList';
  return reads.byUpstream ? 'otherList' : 'notFlagged';
}

/** How `oracle` answers for `subject` at `blockNumber`. */
async function readSubject(
  publicClient: PublicClient,
  oracle: `0x${string}`,
  subject: `0x${string}`,
  blockNumber: bigint,
): Promise<SubjectReading> {
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
        args: [subject],
        blockNumber,
      })) as boolean;
    } catch {
      flagged = null;
    }
    return classifySubject({ kind: 'direct', flagged });
  }

  // One call answers both lists, so they cannot disagree about the moment.
  if (upstream !== zeroAddress) {
    try {
      const [byOverlay, byUpstream] = (await publicClient.readContract({
        address: oracle,
        abi: OVERLAY_ABI,
        functionName: 'sanctionSource',
        args: [subject],
        blockNumber,
      })) as readonly [boolean, boolean];
      return classifySubject({ kind: 'overlay', upstream, byOverlay, byUpstream });
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
      args: [subject],
      blockNumber,
    })) as boolean;
    return classifySubject({ kind: 'overlay', upstream, byOverlay, byUpstream: null });
  } catch {
    return 'unread';
  }
}

/** The sender `wallet` declared during token recovery, and how `oracle`
 *  answers for it at `blockNumber`. A failed LOOKUP is kept apart from a
 *  failed screening read: only the latter establishes that a sender exists. */
async function readSender(
  publicClient: PublicClient,
  diamond: `0x${string}`,
  oracle: `0x${string}`,
  wallet: `0x${string}`,
  blockNumber: bigint,
): Promise<SenderReading> {
  let source: `0x${string}`;
  try {
    source = (await publicClient.readContract({
      address: diamond,
      abi: DIAMOND_ABI_VIEM,
      functionName: 'vaultBannedSource',
      args: [wallet],
      blockNumber,
    })) as `0x${string}`;
  } catch {
    return { kind: 'lookupFailed' };
  }
  if (source === zeroAddress) return { kind: 'none' };
  return {
    kind: 'declared',
    reading: await readSubject(publicClient, oracle, source, blockNumber),
  };
}

/** One answer to "is this wallet flagged, and why", read at one block.
 *  `reasons` is empty when the wallet is not flagged. */
export interface SanctionsSnapshot {
  flagged: boolean;
  reasons: SanctionsSource[];
}

/** How many times {@link readSanctionsSnapshot} re-reads when the block it
 *  pinned was replaced while it read, before giving up on the explanation. */
const SNAPSHOT_ATTEMPTS = 3;

/** How long one attempt may spend explaining a flag it has already read. The
 *  flag restricts the wallet whether or not its reason is known, so a slow or
 *  hung explanation must never hold the flag back: past this budget the
 *  attempt reports the flag with an `unknown` reason, and the next refresh
 *  tries again. */
export const EXPLANATION_BUDGET_MS = 8_000;

/** `work`, or `fallback` if it has not settled within `ms`. */
async function within<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Reads whether the Diamond flags `wallet` and, when it does, why — both at
 *  ONE block, in one call, so the flag and its explanation cannot disagree.
 *  The flag is the Diamond's own `isSanctionedAddress`; the explanation never
 *  decides it.
 *
 *  THROWS when the block or the flag cannot be read, so a caller keeps the
 *  answer it already had rather than reading an outage as a delisting. Never
 *  throws over the explanation: a failed read there yields `unknown`, or a
 *  reason saying what could not be read.
 *
 *  The explanation is bounded by {@link EXPLANATION_BUDGET_MS}: a flag already
 *  read is never held back by a slow explanation of it.
 *
 *  A wallet that is not flagged costs one read, which cannot straddle two
 *  states. A flagged one takes several, and a block NUMBER does not name one
 *  block across a reorganisation (`eth_call` through viem takes a number, not
 *  a hash), so the hash at that height is taken before the reads and checked
 *  again after them: if it changed, the reads are discarded and repeated, and
 *  after {@link SNAPSHOT_ATTEMPTS} such tries the flag is kept and the
 *  explanation is `unknown`. This detects a replacement that lands during the
 *  reads; it cannot detect one replaced and then restored in between, which no
 *  read by height can.
 *
 *  The Diamond flags a wallet when the oracle flags the wallet itself OR the
 *  sender it declared during token recovery (`vaultBannedSource`), so both
 *  subjects are read every time, through the same classification, and a
 *  failed read of one never discards what was established about the other. */
export async function readSanctionsSnapshot(
  publicClient: PublicClient,
  diamond: `0x${string}`,
  wallet: `0x${string}`,
): Promise<SanctionsSnapshot> {
  for (let attempt = 0; attempt < SNAPSHOT_ATTEMPTS; attempt++) {
    const pinned = await publicClient.getBlock({ blockTag: 'latest' });
    const flagged = (await publicClient.readContract({
      address: diamond,
      abi: DIAMOND_ABI_VIEM,
      functionName: 'isSanctionedAddress',
      args: [wallet],
      blockNumber: pinned.number,
    })) as boolean;
    if (!flagged) return { flagged: false, reasons: [] };

    const reasons = await within(
      explainAtBlock(publicClient, diamond, wallet, pinned.number),
      EXPLANATION_BUDGET_MS,
      ['unknown'] as SanctionsSource[],
    );
    if (reasons.length === 1 && reasons[0] === 'unknown') return { flagged: true, reasons };

    let after: `0x${string}`;
    try {
      after = (await publicClient.getBlock({ blockNumber: pinned.number })).hash;
    } catch {
      return { flagged: true, reasons: ['unknown'] };
    }
    if (after === pinned.hash) return { flagged: true, reasons };
  }
  return { flagged: true, reasons: ['unknown'] };
}

/** Why the Diamond flags `wallet` at `blockNumber` — called only once it has
 *  reported the wallet flagged at that same block. */
async function explainAtBlock(
  publicClient: PublicClient,
  diamond: `0x${string}`,
  wallet: `0x${string}`,
  blockNumber: bigint,
): Promise<SanctionsSource[]> {
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

  const own = await readSubject(publicClient, oracle, wallet, blockNumber);
  const sender = await readSender(publicClient, diamond, oracle, wallet, blockNumber);
  return explain(own, sender);
}
