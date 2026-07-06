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
}): Promise<`0x${string}` | null> {
  const { publicClient, walletClient, token, owner, spender, amount, onPrompt } = opts;
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
    return hash;
  };

  // Zero-first: tokens like mainnet USDT revert on a non-zero→non-zero
  // approve. Resetting to 0 first costs one extra tx only in the
  // leftover-allowance case and keeps every listed token workable.
  if (current > 0n) await approve(0n);
  return approve(amount);
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
  return hash;
}
