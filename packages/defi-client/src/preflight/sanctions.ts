import type { Address, PublicClient } from 'viem';
import { DIAMOND_ABI_VIEM } from '@vaipakam/contracts/abis';

export async function checkSanctioned(
  publicClient: PublicClient,
  diamondAddress: Address,
  who: Address,
): Promise<boolean> {
  try {
    return (await publicClient.readContract({
      address: diamondAddress,
      abi: DIAMOND_ABI_VIEM,
      functionName: 'isSanctionedAddress',
      args: [who],
    })) as boolean;
  } catch {
    return false;
  }
}