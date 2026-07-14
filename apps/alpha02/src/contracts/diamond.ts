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
import { useQueryClient } from '@tanstack/react-query';
import { usePublicClient, useWalletClient } from 'wagmi';
import type { TransactionReceipt } from 'viem';
import { DIAMOND_ABI_VIEM } from '@vaipakam/contracts/abis';
import { useActiveChain } from '../chain/useActiveChain';
import { publishReceiptInvalidation } from '../chain/receiptSync';

export { DIAMOND_ABI_VIEM };

export interface DiamondWriteResult {
  hash: `0x${string}`;
  /** The mined receipt — for flows that need an id out of the logs
   *  (e.g. the offer id a createOffer minted). */
  receipt: TransactionReceipt;
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
  const queryClient = useQueryClient();

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
      // RPC read-diet PR A (§4.1.4) — the centralized post-receipt
      // floor: every confirmed Diamond write dirties the standard
      // own-state set (here, in every other tab via broadcast, and
      // once more after ~2 block times for lagging public RPCs).
      // ADDITIVE: flows keep their surface-specific invalidations on
      // top of this — the floor is what no future flow can forget.
      publishReceiptInvalidation(queryClient);
      return { hash, receipt };
    },
    [
      onSupportedChain,
      walletChain,
      walletClient,
      publicClient,
      address,
      queryClient,
    ],
  );

  return { write, ready: onSupportedChain && Boolean(walletClient) };
}
