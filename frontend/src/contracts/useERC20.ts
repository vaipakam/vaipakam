import { useMemo } from 'react';
import { usePublicClient, useWalletClient } from 'wagmi';
import {
  parseAbi,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { useWallet } from '../context/WalletContext';

/** Minimal ERC20 surface used by the app's approve + allowance flows.
 *  Expanded-beyond-spec variants aren't needed — USDT's non-standard
 *  `approve` returns get coerced through the ABI decoder without
 *  reverting the tx. */
const ERC20_ABI = parseAbi([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function transfer(address to, uint256 amount) returns (bool)',
]) as unknown as Abi;

const VIEW_FUNCTIONS = new Set([
  'name',
  'symbol',
  'decimals',
  'balanceOf',
  'allowance',
]);

/**
 * Ethers-Contract-shaped handle exposing dynamic `.method(args...)` access
 * against a single ERC20 token. Reads dispatch to viem's `readContract`,
 * writes dispatch to `writeContract` and return `{ hash, wait() }` so the
 * existing `const tx = await token.approve(...); await tx.wait();`
 * pattern at call sites works unchanged.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Erc20Handle = Record<string, any>;

function buildErc20Proxy(
  address: Address,
  publicClient: PublicClient,
  walletClient: WalletClient | null,
): Erc20Handle {
  return new Proxy({} as Erc20Handle, {
    get(_t, prop) {
      if (typeof prop !== 'string') return undefined;
      return async (...args: unknown[]) => {
        if (VIEW_FUNCTIONS.has(prop)) {
          return publicClient.readContract({
            address,
            abi: ERC20_ABI,
            functionName: prop,
            args,
          });
        }
        if (!walletClient) {
          throw new Error(
            `Cannot call ${prop} on ERC20 ${address}: wallet not connected.`,
          );
        }
        const account = walletClient.account;
        if (!account) {
          throw new Error(
            `Cannot call ${prop} on ERC20 ${address}: wallet has no account.`,
          );
        }
        const hash: Hex = await walletClient.writeContract({
          address,
          abi: ERC20_ABI,
          functionName: prop,
          args,
          account,
          chain: walletClient.chain,
        });
        return {
          hash,
          // Throw on reverted txs — see the matching docstring on
          // `useDiamond.ts`'s wait(). Failed approvals are common
          // enough (insufficient balance to spend, paused token,
          // etc.) that swallowing the receipt's failure status
          // produces the wrong end-state (page renders "approved"
          // while the allowance is still 0).
          wait: async () => {
            const receipt = await publicClient.waitForTransactionReceipt({ hash });
            if (receipt.status !== 'success') {
              throw new Error(
                `ERC20 ${prop} reverted on-chain (status=${receipt.status}). ` +
                `Tx ${hash} mined but did not succeed.`,
              );
            }
            return receipt;
          },
        };
      };
    },
  });
}

export function useERC20(tokenAddress: string | null): Erc20Handle | null {
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();
  const { isCorrectChain } = useWallet();

  return useMemo(() => {
    if (!tokenAddress) return null;
    if (!publicClient) return null;
    // Without a wallet we still expose a read-only handle — lets `balanceOf`
    // / `allowance` fire even before the user clicks Connect.
    const wc = walletClient && isCorrectChain
      ? (walletClient as WalletClient)
      : null;
    return buildErc20Proxy(
      tokenAddress as Address,
      publicClient as PublicClient,
      wc,
    );
  }, [tokenAddress, publicClient, walletClient, isCorrectChain]);
}
