/**
 * #3242 — the offer-book value floor, read as the smallest amount of a
 * lending token an offer's `amount` may carry. For a lender offer that is
 * its smallest fill, which the guided flow sets for the user (10% of the
 * total by default), so the flow must raise it to the floor or the post is
 * refused with `OfferBelowMinimumValue`.
 *
 * The figure comes from the Diamond's `getMinOfferAmount`, the same rule the
 * protocol enforces at posting: an illiquid token, or one whose price cannot
 * be read now, is not bound (`binds = false`), and any amount is admitted.
 * While the read is in flight or fails, `minAmount` is undefined and the
 * payload keeps its default; the protocol's own refusal is the backstop.
 */
import { useQuery } from '@tanstack/react-query';
import { usePublicClient } from 'wagmi';
import { DIAMOND_ABI_VIEM } from '@vaipakam/contracts/abis';
import { useActiveChain } from '../chain/useActiveChain';
import type { OfferBookFloor } from '../lib/offerSchema';

export type { OfferBookFloor };

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export function useOfferBookFloor(lendingAsset: string | undefined): OfferBookFloor {
  const { readChain } = useActiveChain();
  const publicClient = usePublicClient({ chainId: readChain.chainId });
  const asset = lendingAsset && ADDRESS_RE.test(lendingAsset)
    ? (lendingAsset as `0x${string}`)
    : undefined;

  const { data } = useQuery({
    queryKey: ['offerBookFloor', readChain.chainId, asset],
    enabled: Boolean(publicClient && asset),
    staleTime: 60_000,
    queryFn: async () => {
      const [binds, amount] = (await publicClient!.readContract({
        address: readChain.diamondAddress,
        abi: DIAMOND_ABI_VIEM,
        functionName: 'getMinOfferAmount',
        args: [asset!],
      })) as readonly [boolean, bigint];
      return binds ? amount : null;
    },
  });

  return { minAmount: data ?? undefined };
}

/**
 * #3242 — where `wallet` stands against the per-wallet open-offer cap, from
 * `getOfferBookBounds(wallet)`. `undefined` while the read is in flight, has
 * failed, or there is no wallet: the flow then says nothing about the cap and
 * the protocol's own refusal (`TooManyOpenOffers`) is the backstop.
 */
export function useOpenOfferCount(
  wallet: string | undefined,
): { open: bigint; cap: bigint } | undefined {
  const { readChain } = useActiveChain();
  const publicClient = usePublicClient({ chainId: readChain.chainId });
  const who = wallet && ADDRESS_RE.test(wallet) ? (wallet as `0x${string}`) : undefined;

  const { data } = useQuery({
    queryKey: ['openOfferCount', readChain.chainId, who],
    enabled: Boolean(publicClient && who),
    staleTime: 30_000,
    queryFn: async () => {
      const [, cap, open] = (await publicClient!.readContract({
        address: readChain.diamondAddress,
        abi: DIAMOND_ABI_VIEM,
        functionName: 'getOfferBookBounds',
        args: [who!],
      })) as readonly [bigint, bigint, bigint];
      return { open, cap };
    },
  });
  return data;
}
