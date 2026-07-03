/**
 * Diamond access for alpha02.
 *
 * The Vaipakam Diamond (EIP-2535) exposes every facet function at one
 * address per chain; `DIAMOND_ABI_VIEM` is the combined ABI from
 * @vaipakam/contracts. alpha02 keeps the call surface deliberately
 * explicit — a small set of named read/write helpers instead of a
 * dynamic proxy — so it is greppable which protocol calls the naive-
 * user app actually makes.
 */
import { useCallback } from 'react';
import { usePublicClient, useWalletClient } from 'wagmi';
import { DIAMOND_ABI_VIEM } from '@vaipakam/contracts/abis';
import { useActiveChain } from '../chain/useActiveChain';

export { DIAMOND_ABI_VIEM };

export interface DiamondWriteResult {
  hash: `0x${string}`;
}

/**
 * Write-side handle. `write` submits a Diamond call on the wallet's
 * active (supported) chain and resolves after the tx is MINED with
 * success status — callers can refresh reads immediately after.
 * Throws with the wallet/RPC error otherwise.
 */
export function useDiamondWrite() {
  const { walletChain, onSupportedChain, address } = useActiveChain();
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient({ chainId: walletChain?.chainId });

  const write = useCallback(
    async (
      functionName: string,
      args: readonly unknown[],
    ): Promise<DiamondWriteResult> => {
      if (!onSupportedChain || !walletChain || !walletClient || !address) {
        throw new Error('Connect a wallet on a supported network first.');
      }
      if (!publicClient) throw new Error('No RPC client for the active chain.');
      const hash = await walletClient.writeContract({
        address: walletChain.diamondAddress,
        abi: DIAMOND_ABI_VIEM,
        functionName,
        args: args as unknown[],
        account: address,
        chain: walletClient.chain,
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') {
        throw new Error(`Transaction reverted (${hash})`);
      }
      return { hash };
    },
    [onSupportedChain, walletChain, walletClient, publicClient, address],
  );

  return { write, ready: onSupportedChain && Boolean(walletClient) };
}
