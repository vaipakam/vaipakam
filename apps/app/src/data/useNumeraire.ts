/**
 * The protocol's active reference currency, read live from
 * `getNumeraireSymbol()` and decoded by `numeraireOf`. `undefined` while
 * loading, `null` when the read failed or the word is not printable text —
 * the caller then names the unit by what it is instead of guessing one.
 */
import { useQuery } from '@tanstack/react-query';
import { usePublicClient } from 'wagmi';
import { DIAMOND_ABI_VIEM } from '@vaipakam/contracts/abis';
import { useActiveChain } from '../chain/useActiveChain';
import { numeraireOf, type Numeraire } from './numeraire';

export function useNumeraire(): Numeraire | null | undefined {
  const { readChain } = useActiveChain();
  const publicClient = usePublicClient({ chainId: readChain.chainId });
  const q = useQuery({
    queryKey: ['numeraireSymbol', readChain.chainId],
    enabled: publicClient !== undefined,
    staleTime: 10 * 60_000,
    queryFn: async () => {
      try {
        const word = (await publicClient!.readContract({
          address: readChain.diamondAddress,
          abi: DIAMOND_ABI_VIEM,
          functionName: 'getNumeraireSymbol',
        })) as string;
        return numeraireOf(word);
      } catch {
        return null;
      }
    },
  });
  return q.isLoading ? undefined : (q.data ?? null);
}
