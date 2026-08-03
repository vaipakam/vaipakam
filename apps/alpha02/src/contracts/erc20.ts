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
  /** Called after EACH approve mines, with the value now on-chain.
   *  Callers that unwind on failure need this rather than the return
   *  value: when the zero-first reset succeeds and the second approve
   *  then throws, this function never returns, yet the allowance HAS
   *  been changed — to 0 — and an unwind keyed on the return value
   *  would walk away leaving the prior grant destroyed. */
  onWrote?: (value: bigint) => void;
}): Promise<`0x${string}` | null> {
  const { publicClient, walletClient, token, owner, spender, amount, onPrompt, onWrote } =
    opts;
  const current = await publicClient.readContract({
    address: token,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [owner, spender],
  });
  if (current >= amount) return null;

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
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') {
      throw new Error(`Token approval failed (${hash})`);
    }
    onWrote?.(value);
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
}): Promise<`0x${string}` | null> {
  const { publicClient, walletClient, token, owner, spender, previous, wrote } =
    opts;
  // This attempt changed nothing, so it has nothing to put back.
  if (wrote === null || wrote === previous) return null;
  const current = await publicClient.readContract({
    address: token,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [owner, spender],
  });
  // Someone else owns the current value now — leave it alone.
  if (current !== wrote) return null;

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
  if (current > 0n && previous > 0n) await approve(0n);
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
