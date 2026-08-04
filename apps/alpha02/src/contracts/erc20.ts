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
    onPrompt, onWrote, onObserved, onConfirmed,
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
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') {
      // A REVERT is definitive: this value did not take effect. Correct
      // the optimistic report back to whatever actually landed, or to
      // null if nothing did. Without this the caller keeps believing the
      // allowance is `value` while the chain says otherwise, and on the
      // zero-first path that leaves the user's prior grant erased with
      // the unwind convinced it isn't theirs to restore.
      onWrote?.(confirmed?.value ?? null, confirmed?.hash ?? null);
      throw new Error(`Token approval failed (${hash})`);
    }
    confirmed = { value, hash };
    onConfirmed?.(value, hash);
    // RPC read-diet PR A (§4.1.4) — approvals go through this helper,
    // not diamond.ts, so they feed the same centralized receipt floor
    // (standingApprovals / funding-watch roots ride push+focus+net
    // otherwise and would stay stale until the 180s net).
    publishReceiptInvalidationGlobal();
    return hash;
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
  if (current !== wrote && wroteTxHash) {
    // Our own write may simply still be in flight — the caller reports at
    // submission precisely so a lost receipt is not mistaken for "nothing
    // happened", and the mirror of that is not mistaking "not yet" for
    // "someone else's". Give it a bounded chance to settle, then look
    // again. A revert lands here too and correctly leaves `current`
    // unequal, so the restore stands down.
    try {
      const r = await publicClient.waitForTransactionReceipt({
        hash: wroteTxHash,
        timeout: 60_000,
      });
      if (r.status !== 'success') {
        // It landed as a REVERT: the optimistic value never took effect,
        // so what this attempt actually left behind is the confirmed one
        // (on the zero-first path, the reset). Judging against the stale
        // optimistic value here is what left a user's prior grant erased
        // with the restore convinced the zero wasn't its doing.
        wrote = confirmed ?? null;
        if (wrote === null || wrote === previous) return null;
      }
      current = await readAllowance();
    } catch {
      // Still unresolved — fall through and stand down below.
    }
  }
  // Someone else owns the current value now — leave it alone.
  if (current !== wrote) return null;
  if (await ownerHasPendingTx()) return null;

  const approve = async (value: bigint): Promise<`0x${string}`> => {
    const hash = await walletClient.writeContract({
      address: token,
      abi: erc20Abi,
      functionName: 'approve',
      args: [spender, value],
      account: owner,
      chain: walletClient.chain,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') {
      throw new Error(`Token approval restore failed (${hash})`);
    }
    publishReceiptInvalidationGlobal();
    return hash;
  };

  // Same zero-first rule as ensureAllowance — tokens like mainnet USDT
  // revert on a non-zero→non-zero approve, and this path is by
  // definition running against a non-zero current value.
  if (current > 0n && previous > 0n) {
    await approve(0n);
    // The no-clobber guarantee has to hold across BOTH transactions, not
    // just before the first. Between the reset mining and this restore
    // being submitted, another tab can grant a fresh allowance — and
    // writing `previous` over it would be exactly the overwrite the
    // guard above exists to prevent, merely one transaction later
    // (#1529 review). Anything but the zero we just wrote means the
    // value is no longer ours to put back.
    const afterReset = await publicClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [owner, spender],
    });
    // Both checks again: a competing approve may have MINED in this
    // window (visible here) or merely been SUBMITTED (invisible to the
    // read, which is what the pending probe is for).
    if (afterReset !== 0n) return null;
    if (await ownerHasPendingTx()) return null;
  }
  return approve(previous);
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
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') {
    throw new Error(`Approval revoke failed (${hash})`);
  }
  // RPC read-diet PR A (§4.1.4) — same centralized floor as ensureAllowance.
  publishReceiptInvalidationGlobal();
  return hash;
}
