/**
 * Minimal ERC-20 surface: metadata, balance, allowance, approve.
 * Reads go through react-query (metadata is immutable → cached
 * forever; balances refetch on demand). Approvals target the Diamond
 * — OfferCreateFacet / RepayFacet pull from the caller via
 * transferFrom, so the Diamond is always the spender.
 */
import { useQuery } from '@tanstack/react-query';
import { erc20Abi } from 'viem';
import type { PublicClient, WalletClient } from 'viem';
import { usePublicClient } from 'wagmi';
import { useActiveChain } from '../chain/useActiveChain';
import { publishReceiptInvalidationGlobal } from '../chain/receiptSync';
import { idleAware } from '../lib/idle';
import { settled } from './ownReceipt';

export interface TokenMeta {
  address: `0x${string}`;
  symbol: string;
  decimals: number;
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export function isAddressLike(v: string): v is `0x${string}` {
  return ADDRESS_RE.test(v);
}

/** symbol + decimals for a token on the current read chain. Returns
 *  no data while loading and `isError` when the address is not an
 *  ERC-20 (used by forms to say so before the user signs anything). */
export function useTokenMeta(tokenAddress: string | undefined) {
  const { readChain } = useActiveChain();
  const publicClient = usePublicClient({ chainId: readChain.chainId });
  const valid = tokenAddress !== undefined && isAddressLike(tokenAddress);

  return useQuery({
    queryKey: ['tokenMeta', readChain.chainId, tokenAddress?.toLowerCase()],
    enabled: valid && Boolean(publicClient),
    staleTime: Infinity,
    retry: 1,
    queryFn: async (): Promise<TokenMeta> => {
      if (!publicClient || !valid) throw new Error('unreachable');
      const address = tokenAddress as `0x${string}`;
      const [symbol, decimals] = await Promise.all([
        publicClient.readContract({ address, abi: erc20Abi, functionName: 'symbol' }),
        publicClient.readContract({ address, abi: erc20Abi, functionName: 'decimals' }),
      ]);
      return { address, symbol, decimals };
    },
  });
}

/** Wallet balance of a token on the wallet's active chain. */
export function useTokenBalance(tokenAddress: string | undefined) {
  const { address, walletChain } = useActiveChain();
  const publicClient = usePublicClient({ chainId: walletChain?.chainId });
  const valid = tokenAddress !== undefined && isAddressLike(tokenAddress);

  return useQuery({
    queryKey: [
      'tokenBalance',
      walletChain?.chainId,
      tokenAddress?.toLowerCase(),
      address?.toLowerCase(),
    ],
    enabled: valid && Boolean(publicClient) && Boolean(address) && Boolean(walletChain),
    refetchInterval: idleAware(30_000),
    queryFn: async (): Promise<bigint> => {
      if (!publicClient || !valid || !address) throw new Error('unreachable');
      return publicClient.readContract({
        address: tokenAddress as `0x${string}`,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [address],
      });
    },
  });
}

/**
 * Was the allowance really set to `want`, judged only on evidence good
 * enough to overturn our own successful receipt (#1529 review round 12)?
 *
 * A public RPC commonly answers a read taken immediately after a receipt
 * from PRE-transaction state — the lag `receiptSync.ts` was written for.
 * A single mismatched read is therefore not evidence of anything, and
 * treating it as proof that a mined approve did not land is how the
 * caller ends up retracting a write that really happened.
 *
 * The pinned read is what makes a NEGATIVE answer trustworthy: asking at
 * the exact block our transaction mined in, a node that has the block
 * answers about post-transaction state, and a node that does not have it
 * errors rather than quietly answering about an earlier one. Only that
 * form of disagreement returns `contradicted`.
 *
 * Everything else is `unknown` — genuinely unknown, and deliberately not
 * called failure. A caller holding a successful own-call receipt should
 * proceed on it rather than on a read that could not be taken.
 */
async function confirmAllowanceValue(
  publicClient: PublicClient,
  token: `0x${string}`,
  owner: `0x${string}`,
  spender: `0x${string}`,
  want: bigint,
  blockNumber: bigint,
): Promise<'confirmed' | 'contradicted' | 'unknown'> {
  const read = (at?: bigint) =>
    publicClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [owner, spender],
      ...(at === undefined ? {} : { blockNumber: at }),
    });

  // Pinned first: its answer is conclusive in BOTH directions.
  try {
    return (await read(blockNumber)) === want ? 'confirmed' : 'contradicted';
  } catch {
    // No archive depth, provider rejects the parameter, or the node has
    // not reached the block yet. Fall through to the latest-state read.
  }

  // Unpinned, with a short backoff for the ordinary lag case. A match
  // confirms; persistent mismatch does not refute, because we cannot
  // tell a node that never caught up from a value someone changed after
  // us — and those call for opposite responses.
  for (let attempt = 0; attempt < 3; attempt++) {
    await new Promise((r) => setTimeout(r, 250 * 2 ** attempt));
    try {
      if ((await read()) === want) return 'confirmed';
    } catch {
      /* keep trying */
    }
  }
  return 'unknown';
}

/**
 * Is the allowance STILL `want` right NOW — a different question from
 * the one `confirmAllowanceValue` answers.
 *
 * That helper reads pinned to a receipt block, so it settles history:
 * "did our write take effect when it mined". Necessary, but it cannot
 * stand in for the present. An allowance another tab revoked a moment
 * ago still reads as ours at our own block, forever.
 *
 * The distinction only matters where the CURRENT value is the thing
 * being guarded — the reconciliation in `restoreAllowance`, whose whole
 * job is deciding whether someone else owns the allowance now.
 * `ensureAllowance` and `revokeAllowance` ask the historical question on
 * purpose: their contract is about the effect of their own call, and a
 * later third-party change is outside the window they speak for.
 *
 * `notBefore` is the receipt block our write mined in. Answering from a
 * node that has not reached it would reproduce the very lag the pinned
 * read exists to defeat, so the head is checked first and the read is
 * pinned to the head that was verified — a load-balanced provider
 * routing it to a laggard errors rather than quietly answering about an
 * earlier state.
 */
async function confirmAllowanceStillLive(
  publicClient: PublicClient,
  token: `0x${string}`,
  owner: `0x${string}`,
  spender: `0x${string}`,
  want: bigint,
  notBefore: bigint,
): Promise<'confirmed' | 'contradicted' | 'unknown'> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const head = await publicClient.getBlockNumber();
      if (head >= notBefore) {
        const live = await publicClient.readContract({
          address: token,
          abi: erc20Abi,
          functionName: 'allowance',
          args: [owner, spender],
          blockNumber: head,
        });
        return live === want ? 'confirmed' : 'contradicted';
      }
    } catch {
      /* fall through to the backoff and ask again */
    }
    await new Promise((r) => setTimeout(r, 250 * 2 ** attempt));
  }
  return 'unknown';
}

/**
 * Ensure the Diamond may pull `amount` of `token` from the connected
 * wallet: read the live allowance, send `approve` only when short,
 * and wait for it to mine. Returns the approve tx hash, or null when
 * the existing allowance already covers the amount.
 */
export async function ensureAllowance(opts: {
  publicClient: PublicClient;
  walletClient: WalletClient;
  token: `0x${string}`;
  owner: `0x${string}`;
  spender: `0x${string}`;
  amount: bigint;
  /** Called immediately before EACH approve prompt (once normally,
   *  twice on the zero-first reset path) — drives the "step x of y"
   *  submit-progress label (#1037). */
  onPrompt?: () => void;
  /** AWAITED before each approve prompt, and may THROW to abort (Codex
   *  #1703 r3). Distinct from `onPrompt`, which is a progress label and
   *  cannot gate: the zero-first path prompts TWICE, and the gap between
   *  them is a user-held wallet confirmation plus a mined transaction — so
   *  a caller with a live precondition (a tariff quote that can cross a
   *  signed ceiling) needs a re-check before the SECOND prompt too, not
   *  only before the helper is entered. */
  beforeEachApprove?: () => Promise<void>;
  /** Called as soon as EACH approve is SUBMITTED, with the value it
   *  sets — deliberately before the receipt, not after.
   *
   *  Callers that unwind on failure need this rather than the return
   *  value: when the zero-first reset succeeds and the second approve
   *  then throws, this function never returns, yet the allowance HAS
   *  been changed — to 0 — and an unwind keyed on the return value
   *  would walk away leaving the prior grant destroyed.
   *
   *  Reporting at submission rather than on the receipt covers the case
   *  where the approve MINES but `waitForTransactionReceipt` times out
   *  or loses the RPC before observing it: the allowance changed on
   *  chain, and a caller told nothing would leave a live grant standing
   *  (or, on the zero-first path, leave the user's prior grant erased).
   *  Reporting optimistically is safe because it is not treated as
   *  fact — `restoreAllowance` re-reads and acts only if the allowance
   *  really does equal this value, so a submission that never landed
   *  reconciles to a no-op on its own (#1529 review).
   *
   *  MAY BE CALLED MORE THAN ONCE, and a later call SUPERSEDES an
   *  earlier one. It reports the best current estimate of what this
   *  function has put on chain, so an optimistic report is corrected
   *  when the receipt comes back reverted: on the zero-first path the
   *  reset has landed and the second approve has not, so the truth is
   *  the reset value, not the amount. `null` means nothing is believed
   *  to have landed at all. Leaving the stale optimistic value in place
   *  made `restoreAllowance` read "somebody else owns this" and walk
   *  away from a grant it had itself just erased (#1529 review round 8). */
  onWrote?: (value: bigint | null, hash: `0x${string}` | null) => void;
  /** Called once with the allowance THIS function observed, before it
   *  changes anything. Unwinding callers must take `previous` from here
   *  rather than reading the allowance themselves: two separate reads
   *  are two separate moments, and anything that moves the allowance
   *  between them makes the caller's figure stale — so a later unwind
   *  would "restore" a value that was never the one replaced (#1529
   *  review). One read, one truth. */
  onObserved?: (current: bigint) => void;
  /** Called when an approve is CONFIRMED on chain. Distinct from
   *  `onWrote`, which is optimistic: this is the value the caller can
   *  fall back to when a later, still-unresolved approve turns out to
   *  have reverted. The unwind needs both because the revert can be
   *  discovered HERE (correction runs) or LATER by the unwind's own
   *  receipt wait, after this function has already thrown on a timeout
   *  and can no longer correct anything (#1529 review round 9). */
  onConfirmed?: (value: bigint, hash: `0x${string}`) => void;
}): Promise<`0x${string}` | null> {
  const {
    publicClient, walletClient, token, owner, spender, amount,
    onPrompt, beforeEachApprove, onWrote, onObserved, onConfirmed,
  } = opts;
  const current = await publicClient.readContract({
    address: token,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [owner, spender],
  });
  onObserved?.(current);
  if (current >= amount) return null;

  // The last write CONFIRMED on chain, so an optimistic report can be
  // rolled back to the truth when a later approve reverts.
  let confirmed: { value: bigint; hash: `0x${string}` } | null = null;

  const approve = async (value: bigint): Promise<`0x${string}`> => {
    // Before the prompt, and before EVERY prompt — including the second one
    // on the zero-first path (Codex #1703 r3). May throw to abort.
    await beforeEachApprove?.();
    onPrompt?.();
    const hash = await walletClient.writeContract({
      address: token,
      abi: erc20Abi,
      functionName: 'approve',
      args: [spender, value],
      account: owner,
      chain: walletClient.chain,
    });
    // Report BEFORE waiting — see onWrote's contract. The hash goes with
    // it so an unwind can tell "this has not landed YET" from "someone
    // else moved it", which an allowance read alone cannot distinguish.
    onWrote?.(value, hash);
    // Two independent questions, and conflating them cost a round each.
    //
    // 1. DID OUR CALL RUN? A successful receipt does not say so: viem
    //    follows replacements, so a cancel resolves with the
    //    replacement's `status: 'success'` receipt having set no
    //    allowance at all (round 10). `settled` answers this, and
    //    answers it with a REASON — a cancel is positive evidence that
    //    nothing happened, so the optimistic report can be safely
    //    retracted. A Speed Up is our own call and passes.
    const s = await settled(publicClient, hash);
    if (!s.ok) {
      // Roll the optimistic report back to what IS on chain, or to null
      // when this function has confirmed nothing at all. Safe precisely
      // because the evidence is positive: this call did not execute.
      onWrote?.(confirmed?.value ?? null, confirmed?.hash ?? null);
      throw new Error(`Token approval did not take effect (${hash})`);
    }
    // A Speed Up mines under a DIFFERENT hash, and the submitted one
    // stops being served once its replacement lands. The unwind's whole
    // job is to re-wait on this transaction, so handing it the dead hash
    // means a viem wait that can never resolve — it times out and walks
    // away from a live payoff-sized allowance. `restoreAllowance`'s own
    // approve helper already returns the mined hash for exactly this
    // reason; this is the same rule on the other write path (#1529
    // review round 17).
    const minedHash = s.receipt.transactionHash;
    if (minedHash.toLowerCase() !== hash.toLowerCase()) onWrote?.(value, minedHash);
    // 2. IS THE VALUE THERE? Worth asking separately — it catches a
    //    reorg, and a token whose approve does not do what its name
    //    says. But a public RPC routinely answers the read immediately
    //    after a receipt from PRE-transaction state (the lag
    //    `receiptSync.ts` exists for), and round 11 read a single stale
    //    answer as "it did not land" and retracted a write that HAD
    //    landed — leaving the payoff approval standing with the catch
    //    path told nothing was written (round 12).
    //
    //    So a disagreement is only believed when it comes from a node
    //    that has demonstrably seen the block. Anything less is
    //    unknown, and an unknown does not get to overturn our own
    //    successful receipt.
    const state = await confirmAllowanceValue(
      publicClient, token, owner, spender, value, s.receipt.blockNumber,
    );
    if (state === 'contradicted') {
      // A node that HAS our block says the value is not there. Our call
      // still ran, so the optimistic report STAYS — the unwind needs to
      // know we wrote in order to reason about the state at all.
      throw new Error(
        `Token approval did not take effect (${minedHash}) — the allowance` +
          ` does not read back as approved.`,
      );
    }
    // 'confirmed' or 'unknown'. An `approve(value)` call of ours that
    // executed successfully DID set the allowance to `value` at its
    // block; the read above is the cross-check for a reorg or a token
    // that does not honour its own interface, not the primary evidence.
    // When it could not be taken, the receipt stands.
    confirmed = { value, hash: minedHash };
    onConfirmed?.(value, minedHash);
    // RPC read-diet PR A (§4.1.4) — approvals go through this helper,
    // not diamond.ts, so they feed the same centralized receipt floor
    // (standingApprovals / funding-watch roots ride push+focus+net
    // otherwise and would stay stale until the 180s net).
    publishReceiptInvalidationGlobal();
    // The MINED hash, matching `revokeAllowance` and `writeDiamond`. No
    // caller links to it today (the one that keeps it only null-checks),
    // but handing back a hash that never mined is the defect the other
    // two write paths already fixed — leaving it here just waits for a
    // caller to trip over it.
    return minedHash;
  };

  // Zero-first: tokens like mainnet USDT revert on a non-zero→non-zero
  // approve. Resetting to 0 first costs one extra tx only in the
  // leftover-allowance case and keeps every listed token workable.
  if (current > 0n) await approve(0n);
  return approve(amount);
}

/**
 * Put an allowance BACK to what it was before a flow raised it (#1529
 * review).
 *
 * Unwinding with {@link revokeAllowance} is only correct when the flow
 * created the grant out of nothing. `ensureAllowance` also raises a
 * NON-ZERO but insufficient allowance, so an unwind that keys on "did
 * we send an approve?" would zero a grant some OTHER live arrangement
 * is relying on. Restoring the observed prior value is right in both
 * cases: zero when there was nothing, the original figure when there
 * was.
 *
 * `wrote` is what makes it safe to act at all. The caller passes the
 * value THIS attempt set, and the restore proceeds only while the
 * allowance still reads exactly that. Anything else means another tab,
 * another flow, or a spender that consumed it has moved the allowance
 * since — and overwriting that with our stale `previous` would be the
 * very clobbering this function exists to avoid. Nothing to undo is
 * the common case, not an error: a flow whose `ensureAllowance` found
 * the allowance already sufficient wrote nothing and must restore
 * nothing.
 */
export async function restoreAllowance(opts: {
  publicClient: PublicClient;
  walletClient: WalletClient;
  token: `0x${string}`;
  owner: `0x${string}`;
  spender: `0x${string}`;
  /** Allowance observed BEFORE this flow touched it. */
  previous: bigint;
  /** Value this attempt actually wrote, or null if it wrote nothing. */
  wrote: bigint | null;
  /** Hash of the transaction that wrote `wrote`, when the caller has it.
   *  Needed because an allowance read cannot tell "our write has not
   *  landed yet" from "somebody else moved it" — both read as
   *  `current !== wrote`, and treating the first as the second walks away
   *  from a grant that is about to appear (#1529 review round 6). */
  wroteTxHash?: `0x${string}` | null;
  /** The last value `ensureAllowance` CONFIRMED, when it got that far.
   *  Used only if the awaited `wroteTxHash` turns out to have reverted:
   *  the optimistic `wrote` then never took effect, and the truth is this
   *  instead. `ensureAllowance` corrects `wrote` itself when it observes
   *  the revert — but when its own receipt wait timed out first, the
   *  revert surfaces here, after it has thrown and can correct nothing
   *  (#1529 review round 9). */
  confirmed?: bigint | null;
}): Promise<`0x${string}` | null> {
  const {
    publicClient, walletClient, token, owner, spender, previous, wroteTxHash, confirmed,
  } = opts;
  let { wrote } = opts;
  // This attempt changed nothing, so it has nothing to put back.
  if (wrote === null || wrote === previous) return null;

  /**
   * True when this wallet has a transaction IN FLIGHT.
   *
   * An allowance read answers from mined state, so it cannot see an
   * approve another tab has submitted but that has not landed yet. Read
   * "the allowance is still ours", queue a restore behind that pending
   * transaction, and the other grant mines first — our restore overwrites
   * it at the next nonce, which is the clobber this function exists to
   * prevent, just displaced by one block (#1529 review).
   *
   * The signal is coarse on purpose: it cannot tell an unrelated pending
   * transaction from a competing approve, so an unrelated one also
   * abstains. That direction is the right one to be wrong in. Abstaining
   * leaves the allowance where this flow last put it — and on the
   * zero-first path that is zero, which every spender reads as "no
   * permission" and the user can re-approve. Proceeding instead risks
   * silently re-granting spending authority over a decision someone else
   * has already made.
   *
   * Our own transactions never trip it: each approve here is awaited to
   * its receipt, so by the time this runs it is mined state, not pending.
   */
  const ownerHasPendingTx = async (): Promise<boolean> => {
    try {
      const [pending, mined] = await Promise.all([
        publicClient.getTransactionCount({ address: owner, blockTag: 'pending' }),
        publicClient.getTransactionCount({ address: owner, blockTag: 'latest' }),
      ]);
      return pending !== mined;
    } catch {
      // Cannot tell — treat as in-flight and abstain. An unwind is a
      // best-effort courtesy; guessing wrong costs someone their grant.
      return true;
    }
  };

  const readAllowance = () =>
    publicClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [owner, spender],
    });

  let current = await readAllowance();
  /** Set when the settle-wait below could not reach an answer at all —
   *  distinct from "answered, and the value is not ours to put back". */
  let unresolved = false;
  if (current !== wrote && wroteTxHash) {
    // Our own write may simply still be in flight — the caller reports at
    // submission precisely so a lost receipt is not mistaken for "nothing
    // happened", and the mirror of that is not mistaking "not yet" for
    // "someone else's". Give it a bounded chance to settle, then look
    // again. A revert lands here too and correctly leaves `current`
    // unequal, so the restore stands down.
    try {
      const r = await settled(publicClient, wroteTxHash);
      // A CANCEL or a REPLACEMENT counts the same as a revert here:
      // either way the value this attempt submitted never took effect,
      // so what it actually left behind is the confirmed one (#1529
      // review round 11).
      if (!r.ok) {
        // The optimistic value never took effect, so what this attempt
        // actually left behind is the confirmed one (on the zero-first
        // path, the reset). Judging against the stale optimistic value
        // here is what left a user's prior grant erased with the restore
        // convinced the zero wasn't its doing.
        wrote = confirmed ?? null;
        if (wrote === null || wrote === previous) return null;
        current = await readAllowance();
      } else {
        // It DID land — but the read that would show it is the one a
        // public RPC most often answers from pre-transaction state. An
        // unpinned read here sees the old value, `current !== wrote`
        // below abandons the unwind, and the payoff-sized approval stays
        // live (#1529 review round 13). Confirm at the block it mined
        // in, where the answer is conclusive.
        const landed = await confirmAllowanceValue(
          publicClient, token, owner, spender, wrote, r.receipt.blockNumber,
        );
        // Abstaining is the safe direction for a courtesy unwind, but it
        // must not be SILENT. `unknown` here means our own call ran and we
        // could not read what it left: the flow's payoff-sized approval is
        // most likely live, and returning null below would tell the caller
        // the cleanup was clean. That is the same conflation of "nothing
        // to undo" with "could not find out" that round 17 fixed in the
        // catch below — this branch, and the live re-read inside it, were
        // left on the old footing (#1529 review round 20).
        if (landed === 'confirmed') {
          // Our write landed. That is HISTORY, and on its own it must not
          // overwrite the live read: pinned at our own receipt block the
          // answer is "ours" no matter what happened afterwards, so
          // `current = wrote` here would march straight past the guard
          // below whose entire job is to notice that somebody else owns
          // the value now. The concrete loss is re-granting `previous`
          // over an allowance another tab has just revoked to zero
          // (#1529 review round 16).
          //
          // So the pinned answer settles only the pending-write question,
          // and the present is asked separately, of a node that has our
          // block. Only a live match unblocks the unwind; `contradicted`
          // (someone moved it) and `unknown` (no trustworthy read) both
          // leave `current` alone and stand down below.
          //
          // `contradicted` is a POSITIVE answer — a node holding our block
          // says someone else owns the value — so that one stands down
          // quietly, as before. `unknown` is not an answer at all.
          const still = await confirmAllowanceStillLive(
            publicClient, token, owner, spender, wrote, r.receipt.blockNumber,
          );
          if (still === 'confirmed') current = wrote;
          else if (still === 'unknown') unresolved = true;
        } else if (landed === 'contradicted') {
          // Our call ran, but a node that HAS its block says the value is
          // not there — so the optimistic `wrote` is not what this
          // attempt left behind. `confirmed` is, exactly as on the
          // `!r.ok` path above, and reconciling to it is what makes the
          // zero-first case recoverable: the reset landed, the approve
          // after it did not stick, and the truth on chain is the zero.
          //
          // Without this the guard below compares a live 0 against a
          // stale `wrote` of the payoff amount, returns null, and both
          // callers read that as a clean cleanup — while the user's prior
          // grant sits erased by our own confirmed reset (#1529 review
          // round 18).
          //
          // The re-read still guards: it proceeds only if the live value
          // IS what we confirmed, so a third party who moved the
          // allowance after us still stands the unwind down.
          wrote = confirmed ?? null;
          if (wrote === null || wrote === previous) return null;
          current = await readAllowance();
        } else {
          // landed === 'unknown' — no node that has our block would answer.
          unresolved = true;
        }
      }
    } catch {
      // Still unresolved — stand down below, but NOT silently. Returning
      // null here says "there was nothing to undo", and both callers read
      // that as a clean cleanup and show only the generic
      // transaction-failed banner. What actually happened is that we
      // could not find out: the flow's approval may still mine into a
      // live payoff-sized allowance, or a confirmed zero reset may have
      // erased a grant the user had before. Either is a wallet state they
      // have to act on, so the unresolved case has to reach them
      // (#1529 review round 17).
      unresolved = true;
    }
  }
  if (unresolved) {
    throw new Error(
      `Could not confirm what happened to this token approval` +
        ` (${wroteTxHash}). Check this spender's approval in your wallet` +
        ` before retrying.`,
    );
  }
  // Someone else owns the current value now — leave it alone. This one is
  // a positive read of the live allowance, so silence is right: there is
  // genuinely nothing of ours left to undo.
  if (current !== wrote) return null;
  // Not standing down for the same reason. Here `current === wrote`, so
  // the flow's payoff-sized approval IS live, and we are declining to
  // clear it only because something else is in flight — or because the
  // nonce read failed and `ownerHasPendingTx` fails closed, which is not
  // even evidence of a pending transaction. Returning null told both
  // callers the cleanup was clean and left that approval standing with no
  // warning (#1529 review round 20). Abstain, but say so.
  if (await ownerHasPendingTx()) {
    throw new Error(
      `The approval could not be cleaned up because another transaction is` +
        ` in flight on this account. The earlier approval is still standing —` +
        ` revoke it from your wallet's approvals view if you no longer want it.`,
    );
  }

  // `what` names the STEP, because this helper sends both of them and
  // the two failures need different sentences: a cancelled reset leaves
  // the flow's own oversized approval standing, while a cancelled
  // put-back leaves the allowance at zero. Telling a user their "reset"
  // was cancelled when the restore was is a wrong instruction on a
  // fund-adjacent error they are being asked to act on.
  const approve = async (
    value: bigint,
    what: string,
  ): Promise<{ hash: `0x${string}`; blockNumber: bigint }> => {
    const hash = await walletClient.writeContract({
      address: token,
      abi: erc20Abi,
      functionName: 'approve',
      args: [spender, value],
      account: owner,
      chain: walletClient.chain,
    });
    // Whether OUR call ran, not merely whether a transaction did. A
    // cancelled reset otherwise returns here looking successful, and the
    // guard below then reads the flow's own value still standing and
    // interprets it as a competing grant to defer to — leaving the
    // payoff-sized approval live behind a failed handover (#1529 review
    // round 12). A Speed Up is our call and passes.
    const r = await settled(publicClient, hash);
    if (!r.ok) {
      throw new Error(
        r.reason === 'reverted'
          ? `The ${what} reverted (${hash}).`
          : `The ${what} was cancelled or replaced before it took effect` +
            ` (${hash}). Check this spender's approval in your wallet` +
            ` before retrying.`,
      );
    }
    publishReceiptInvalidationGlobal();
    // The MINED hash, and the block to confirm against. On a Speed Up
    // these are the replacement's — the submitted hash never mined, so
    // handing it back would name a transaction that does not exist.
    return { hash: r.receipt.transactionHash, blockNumber: r.receipt.blockNumber };
  };

  // Same zero-first rule as ensureAllowance — tokens like mainnet USDT
  // revert on a non-zero→non-zero approve, and this path is by
  // definition running against a non-zero current value.
  if (current > 0n && previous > 0n) {
    const reset = await approve(0n, 'allowance reset');
    // The no-clobber guarantee has to hold across BOTH transactions, not
    // just before the first. Between the reset mining and this restore
    // being submitted, another tab can grant a fresh allowance — and
    // writing `previous` over it would be exactly the overwrite the
    // guard above exists to prevent, merely one transaction later
    // (#1529 review). Anything but the zero we just wrote means the
    // value is no longer ours to put back.
    // Confirm the reset at ITS block. An unpinned read here is the one
    // a public RPC most often answers from pre-transaction state, and
    // the round-12 guard below turns a stale answer into a thrown error
    // that skips the restore entirely — erasing the user's prior grant
    // over an RPC's lag (#1529 review round 13). Our own reset call
    // demonstrably ran, so `unknown` proceeds on that receipt; only a
    // node that HAS the block gets to say otherwise.
    const resetLanded = await confirmAllowanceValue(
      publicClient, token, owner, spender, 0n, reset.blockNumber,
    );
    if (resetLanded === 'contradicted') {
      const afterReset = await readAllowance();
      // Standing down is right for a COMPETING grant and wrong for a
      // reset that did not stick, and `afterReset === wrote` tells them
      // apart: our own flow's value still sitting there means nothing
      // else claimed the slot, so there is no third party's decision to
      // defer to — only our own unwind having failed. Silently returning
      // then leaves the payoff-sized approval live, the opposite of what
      // this function was called to do. `approve` above catches the
      // ordinary cancel directly; this covers the same outcome arriving
      // by another route, such as a reorg after its receipt.
      if (afterReset === wrote) {
        throw new Error(
          `The allowance reset did not take effect — the earlier approval` +
            ` is still standing. Revoke it from your wallet's approvals view.`,
        );
      }
      // A competing approve MINED in this window.
      if (afterReset !== 0n) return null;
    }
    // The reset having landed is HISTORY, and history cannot clear the
    // restore — the same trap round 16 found on the first write, here on
    // its sibling. Pinned at the reset's own block the answer stays zero
    // however much has mined since, so a grant another tab landed in this
    // window is invisible to the check above and `approve(previous)`
    // writes straight over it. The pending-nonce check below cannot cover
    // it either: that transaction has MINED, so pending equals latest
    // again (#1529 review round 18).
    const stillZero = await confirmAllowanceStillLive(
      publicClient, token, owner, spender, 0n, reset.blockNumber,
    );
    if (stillZero === 'contradicted') {
      // "Not zero" is not the same claim as "someone else owns it", and
      // this branch was treating them as one. The `resetLanded ===
      // 'contradicted'` branch above already draws the distinction; round
      // 20 applied it there and left this sibling on the old footing
      // (#1529 review round 21).
      //
      // Our own flow's value still sitting there means the reset did not
      // stick — reorged out after its receipt, or a token whose approve
      // reported success without moving the allowance. There is no third
      // party's decision to defer to, only our own unwind having failed,
      // and returning null tells both callers the cleanup was clean while
      // the payoff-sized approval stays live. That is the precise outcome
      // this function is called to prevent.
      //
      // Reaching here with `resetLanded === 'unknown'` is the likeliest
      // route, since that verdict proceeds on our receipt alone and so
      // never runs the earlier re-read. But the gap is not conditional on
      // it: a reset CONFIRMED at its own block can still be undone
      // afterwards, and this live read is the first thing positioned to
      // see that.
      const afterReset = await readAllowance();
      if (afterReset === wrote) {
        throw new Error(
          `The allowance reset did not take effect — the earlier approval` +
            ` is still standing. Revoke it from your wallet's approvals view.`,
        );
      }
      // Any OTHER non-zero value is a competing grant: a positive read of
      // something that is not ours. Standing down silently is right for
      // that — it is the case this branch was written for.
      if (afterReset !== 0n) return null;
      // A live zero: the contradiction was transient (a head that moved
      // under the read, a race with our own reset settling). The allowance
      // is where our reset left it, so the restore below is still ours.
    }
    if (stillZero === 'unknown') {
      // This is the one place where standing down silently is the WORST
      // option available. We have already cleared the user's grant, and
      // we cannot establish what is there now: restoring blind risks
      // writing over a fresh grant, while a silent null tells the caller
      // the cleanup was clean and leaves them believing nothing needs
      // doing while their allowance sits at zero. Stand down, and say so.
      throw new Error(
        `The earlier approval was cleared, but the allowance could not be` +
          ` re-checked to restore it safely. Re-approve this spender from` +
          ` your wallet if you still need it.`,
      );
    }
    // …or a competing approve was merely SUBMITTED, which no read can see.
    //
    // Standing down is still right — theirs would mine first and ours
    // would overwrite it at the next nonce — but the stakes here are the
    // opposite of the pre-reset case, and worse: our reset has ALREADY
    // landed, so the user's prior grant is sitting at zero and we are
    // walking away without putting it back. Reporting that as a clean
    // cleanup is the one outcome they cannot act on (#1529 review
    // round 20). Same treatment as the `unknown` re-read just above,
    // which is the same predicament reached by a different route.
    if (await ownerHasPendingTx()) {
      throw new Error(
        `The earlier approval was cleared, but it could not be restored` +
          ` because another transaction is in flight on this account.` +
          ` Re-approve this spender from your wallet if you still need it.`,
      );
    }
  }
  const restored = await approve(previous, 'allowance restore');
  // Confirm on OBSERVED STATE as well, exactly as `ensureAllowance` does.
  // `approve` has already established that OUR call ran; this catches
  // what a receipt cannot — a reorg, or a token whose approve does not
  // do what its name says. Returning the hash without it would tell the
  // caller the grant was restored when it was not (#1529 review round 11).
  //
  // (An earlier version of this comment claimed the zero-first reset
  // needed no such check because a reset that did not stick could only
  // mean someone else moved the allowance. That premise was false — the
  // other way it does not stick is our own cancel — and round 12 found
  // the bug it licensed. Both writes are checked now; see the guard
  // above for how the two failures are told apart.)
  const landed = await confirmAllowanceValue(
    publicClient, token, owner, spender, previous, restored.blockNumber,
  );
  if (landed === 'contradicted') {
    throw new Error(
      `The allowance restore did not take effect (${restored.hash}). Check` +
        ` the token approval for this spender before retrying.`,
    );
  }
  // `unknown` is not success here, and this was the last site still
  // treating it as one (#1529 review round 25).
  //
  // Elsewhere in this file a caller holding its own receipt is told to
  // proceed on it, and the reset above does exactly that — deliberately,
  // because throwing there would SKIP the restore and erase the very grant
  // it is protecting (round 13). Nothing comes after this write, so that
  // reasoning does not reach it, and what is left is the shape rounds 20
  // and 21 settled twice already: the user's grant has ALREADY been zeroed,
  // and we cannot establish that the put-back is there. If it was reorged
  // out, or the token's approve reported success without moving the
  // allowance, returning the hash tells both flows the cleanup was clean
  // while the grant sits at zero — the one outcome the user cannot act on,
  // because nothing tells them to look.
  //
  // Both callers append `approvalCleanupFailed` on a throw, which is
  // exactly the "check this token's approvals in your wallet" the
  // unconfirmable case warrants.
  if (landed === 'unknown') {
    throw new Error(
      `The allowance restore was submitted (${restored.hash}) but could not` +
        ` be confirmed. Check the token approval for this spender.`,
    );
  }
  return restored.hash;
}

/**
 * Revoke a standing allowance (approve 0), skipping the tx when it is
 * already zero. For flows that granted a long-lived approval (e.g. a
 * refinance payoff) and are unwinding it.
 */
export async function revokeAllowance(opts: {
  publicClient: PublicClient;
  walletClient: WalletClient;
  token: `0x${string}`;
  owner: `0x${string}`;
  spender: `0x${string}`;
}): Promise<`0x${string}` | null> {
  const { publicClient, walletClient, token, owner, spender } = opts;
  const current = await publicClient.readContract({
    address: token,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [owner, spender],
  });
  if (current === 0n) return null;
  const hash = await walletClient.writeContract({
    address: token,
    abi: erc20Abi,
    functionName: 'approve',
    args: [spender, 0n],
    account: owner,
    chain: walletClient.chain,
  });
  // Same two questions as everywhere else. Did OUR call run — a cancel
  // resolves with the replacement's successful receipt and would report
  // a revoke that never happened (#1529 review round 11). Then: is the
  // allowance actually zero, confirmed at the block it mined in rather
  // than by an unpinned read a public RPC answers from parent state —
  // which reported a mined revoke as failed, so the pending card showed
  // `cancelledRevokeFailed` and the approvals page kept the row (#1529
  // review round 13).
  const r = await settled(publicClient, hash);
  if (!r.ok) {
    throw new Error(
      r.reason === 'reverted'
        ? `The approval revoke reverted (${hash}).`
        : `The approval revoke was cancelled or replaced before it took` +
          ` effect (${hash}). The approval is still standing.`,
    );
  }
  const after = await confirmAllowanceValue(
    publicClient, token, owner, spender, 0n, r.receipt.blockNumber,
  );
  if (after === 'contradicted') {
    throw new Error(`Approval revoke did not take effect (${hash})`);
  }
  // RPC read-diet PR A (§4.1.4) — same centralized floor as ensureAllowance.
  publishReceiptInvalidationGlobal();
  // The MINED hash: on a Speed Up the submitted one never mined, and
  // callers link to this.
  return r.receipt.transactionHash;
}
