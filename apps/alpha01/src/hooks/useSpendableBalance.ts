import { useQuery } from '@tanstack/react-query';
import { erc20Abi, type Address } from 'viem';
import { getUserVaultAddress } from '@vaipakam/defi-client';
import { useDiamondContract, useDiamondPublicClient, useReadChain } from './useDiamond';
import { peekTokenMeta } from '../lib/tokenMeta';

export interface SpendableBalance {
  wallet: bigint;
  vault: bigint;
  total: bigint;
  decimals: number;
  symbol: string;
}

export function useSpendableBalance(
  tokenAddress: string | null | undefined,
  userAddress: string | null | undefined,
) {
  const chain = useReadChain();
  const publicClient = useDiamondPublicClient();
  const diamond = useDiamondContract();

  return useQuery({
    queryKey: ['spendable-balance', chain.chainId, tokenAddress, userAddress],
    enabled: Boolean(tokenAddress && userAddress && publicClient),
    queryFn: async (): Promise<SpendableBalance> => {
      const token = tokenAddress as Address;
      const user = userAddress as Address;
      const cached = peekTokenMeta(token, chain.chainId);
      const [wallet, vaultAddr, decimalsRaw, symbolRaw] = await Promise.all([
        publicClient.readContract({
          address: token,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [user],
        }) as Promise<bigint>,
        getUserVaultAddress(diamond, user),
        cached?.decimals != null
          ? Promise.resolve(cached.decimals)
          : (publicClient.readContract({
              address: token,
              abi: erc20Abi,
              functionName: 'decimals',
            }) as Promise<number>),
        cached?.symbol
          ? Promise.resolve(cached.symbol)
          : (publicClient.readContract({
              address: token,
              abi: erc20Abi,
              functionName: 'symbol',
            }) as Promise<string>).catch(() => 'tokens'),
      ]);

      let vault = 0n;
      if (vaultAddr) {
        vault = (await publicClient.readContract({
          address: token,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [vaultAddr],
        })) as bigint;
      }

      return {
        wallet,
        vault,
        /** Wallet-only — vault custody is not spendable for new locks/approvals. */
        total: wallet,
        decimals: Number(decimalsRaw),
        symbol: symbolRaw || 'tokens',
      };
    },
    staleTime: 15_000,
  });
}