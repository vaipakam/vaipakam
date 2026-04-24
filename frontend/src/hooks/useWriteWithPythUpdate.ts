import { useCallback } from 'react';
import { type Address, type Hex } from 'viem';
import { usePublicClient, useWalletClient } from 'wagmi';
import { useReadChain } from '../contracts/useDiamond';
import { DIAMOND_ABI_VIEM } from '../contracts/abis';
import {
  buildPythUpdatePlan,
  submitPythUpdate,
  type PythUpdatePlan,
} from '../lib/pyth';
import { beginStep } from '../lib/journeyLog';

/**
 * Two-transaction helper for price-reading Vaipakam actions.
 *
 * Some Vaipakam actions (initiateLoan, triggerLiquidation, addCollateral,
 * refinance, preclose, and any other handler that hits
 * `OracleFacet.getAssetPrice`) may fall under the Phase 3.2 Pyth
 * secondary-oracle deviation check. For those, the frontend submits
 * two sequential transactions from the same EOA, in nonce order:
 *
 *   Tx 1 — `IPyth(endpoint).updatePriceFeeds{value: fee}(updateData)`
 *          to prime the on-chain Pyth state with a fresh signed update
 *          fetched from Hermes.
 *   Tx 2 — the actual Vaipakam action on the Diamond.
 *
 * When no Pyth feed is configured for the assets touched by the
 * action, the hook skips tx 1 entirely and just submits the action
 * tx — no user-visible change vs. today's flow.
 *
 * Example call site (inside a React action handler):
 *
 *     const { send } = useWriteWithPythUpdate();
 *     const actionTx = await send({
 *       pythFeedIds: [wethPythId, usdcPythId],
 *       action: { functionName: 'initiateLoan', args: [offerId] },
 *     });
 *     setTxHash(actionTx);
 *
 * Error handling: if Tx 1 reverts or fetches badly, Tx 2 is NOT
 * submitted — the caller sees the first-step error and can retry.
 */

export interface PythWriteParams {
  /** Pyth price feed ids that the action's on-chain call will read
   *  (via `getAssetPrice`). Empty array skips the update step. */
  pythFeedIds: Hex[];
  /** Diamond action to submit after Pyth is primed. */
  action: {
    functionName: string;
    /** Any args. Type-loose on purpose — viem's generic inference
     *  is happy with mixed tuples when `abi` is wide. */
    args: readonly unknown[];
    /** Optional msg.value for the Diamond action tx (separate from
     *  the Pyth update fee). */
    value?: bigint;
  };
}

export interface PythWriteResult {
  /** Tx hash of the Diamond action (tx 2). */
  actionHash: Hex;
  /** Tx hash of the Pyth update (tx 1) — null when the feed set was
   *  empty or the chain has no Pyth endpoint installed. */
  pythUpdateHash: Hex | null;
  /** Hermes-fetched plan that drove tx 1 — null when skipped. */
  plan: PythUpdatePlan | null;
}

export function useWriteWithPythUpdate() {
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();
  const chain = useReadChain();

  const send = useCallback(
    async (params: PythWriteParams): Promise<PythWriteResult> => {
      if (!walletClient) throw new Error('Wallet not connected');
      if (!publicClient) throw new Error('Public client unavailable');
      if (!walletClient.account) throw new Error('Wallet has no account');
      const diamondAddress = chain.diamondAddress as Address | null;
      if (!diamondAddress) throw new Error('Diamond not deployed on this chain');

      const step = beginStep({
        area: 'dashboard',
        flow: 'pythWrite',
        step: 'bundle',
        wallet: walletClient.account.address,
        chainId: chain.chainId,
      });

      try {
        // Read the chain's configured Pyth endpoint. When zero, skip
        // Tx 1 entirely — the chain doesn't have the secondary-oracle
        // feature turned on and the Diamond action will run against
        // Chainlink-only (the existing behaviour).
        const pythEndpoint = (await publicClient.readContract({
          address: diamondAddress,
          abi: DIAMOND_ABI_VIEM,
          functionName: 'getPythEndpoint',
        })) as Address;

        let pythUpdateHash: Hex | null = null;
        let plan: PythUpdatePlan | null = null;
        if (
          pythEndpoint !== '0x0000000000000000000000000000000000000000' &&
          params.pythFeedIds.length > 0
        ) {
          plan = await buildPythUpdatePlan(
            params.pythFeedIds,
            publicClient,
            pythEndpoint,
          );
          pythUpdateHash = await submitPythUpdate(
            plan,
            pythEndpoint,
            walletClient,
            publicClient,
          );
        }

        // Tx 2 — the actual Diamond action. Nonce-ordered after the
        // update tx above (when present), so the Diamond reads a
        // fresh Pyth price.
        const actionHash = await walletClient.writeContract({
          address: diamondAddress,
          abi: DIAMOND_ABI_VIEM,
          functionName: params.action.functionName,
          args: params.action.args as readonly unknown[],
          value: params.action.value ?? 0n,
          account: walletClient.account,
          chain: walletClient.chain,
        });

        step.success({
          note: `pyth=${pythUpdateHash ? 'yes' : 'skip'}, action=${actionHash}`,
        });

        return { actionHash, pythUpdateHash, plan };
      } catch (err) {
        step.failure(err);
        throw err;
      }
    },
    [walletClient, publicClient, chain.diamondAddress, chain.chainId],
  );

  return { send };
}
