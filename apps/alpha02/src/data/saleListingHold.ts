/**
 * Borrower-side listing-hold state (#1503 PR-A follow-up).
 *
 * While a lender-sale listing stands on a loan, the contracts hold
 * the borrower's preclose and collateral-withdrawal paths (partial
 * and full repayment are never held). The chain exposes no
 * loanId→saleOfferId view, so EXISTENCE is detected the same way the
 * borrower would act on it: by SIMULATING the permissionless
 * `teardownStaleSaleListing(loanId)` cleanup and classifying the
 * outcome —
 *
 *   - reverts `NoStaleSaleListing`      → no listing; nothing held
 *   - reverts `SaleListingLoanStillLive`→ a live bounded listing
 *                                          stands; options held until
 *                                          it ends
 *   - SUCCEEDS                          → an ended (expired / legacy
 *                                          GTC / terminal-loan)
 *                                          listing still holds the
 *                                          options — the borrower can
 *                                          free them right now with
 *                                          one transaction
 *
 * Any other outcome (RPC failure, a pre-refresh Diamond that doesn't
 * route the probe, an unexpected revert) classifies `unknown` and the
 * surface renders NOTHING — never a false "held" or a button for a
 * transaction that would revert. The probe is a plain eth_call: it
 * costs no gas and mutates nothing.
 */
import { useQuery } from '@tanstack/react-query';
import { usePublicClient } from 'wagmi';
import { BaseError, ContractFunctionRevertedError } from 'viem';
import { DIAMOND_ABI_VIEM } from '../contracts/diamond';
import { useActiveChain } from '../chain/useActiveChain';
import { tipAware } from '../chain/railHealth';

export type SaleListingHoldState = 'none' | 'live' | 'clearable' | 'unknown';

/** Pure classifier for the teardown probe outcome — split from the
 *  hook so the mapping is unit-testable without a chain. */
export function classifyTeardownProbe(input: {
  ok: boolean;
  errorName?: string | null;
}): SaleListingHoldState {
  if (input.ok) return 'clearable';
  switch (input.errorName) {
    case 'NoStaleSaleListing':
      return 'none';
    case 'SaleListingLoanStillLive':
      return 'live';
    default:
      return 'unknown';
  }
}

/** Extract the custom-error name from a viem simulate/write failure;
 *  null when the revert doesn't decode against the Diamond ABI. */
export function probeErrorName(err: unknown): string | null {
  if (err instanceof BaseError) {
    const revert = err.walk(
      (e) => e instanceof ContractFunctionRevertedError,
    ) as ContractFunctionRevertedError | null;
    return revert?.data?.errorName ?? null;
  }
  return null;
}

export function useSaleListingHold(loanId: number, enabled: boolean) {
  const { readChain, address } = useActiveChain();
  const readClient = usePublicClient({ chainId: readChain.chainId });

  return useQuery({
    queryKey: ['saleListingHold', readChain.chainId, loanId],
    enabled: enabled && Boolean(readClient) && loanId > 0,
    // The state flips exactly once (at the listing's expiry moment),
    // so a slow cadence is enough; the post-receipt invalidation
    // floor refreshes it immediately after the borrower's own writes.
    refetchInterval: tipAware(60_000, Boolean(readChain.wsUrl)),
    queryFn: async (): Promise<SaleListingHoldState> => {
      try {
        await readClient!.simulateContract({
          address: readChain.diamondAddress,
          abi: DIAMOND_ABI_VIEM,
          functionName: 'teardownStaleSaleListing',
          args: [BigInt(loanId)],
          // The entry is permissionless — any account works for the
          // eth_call; the connected wallet keeps the probe faithful
          // to the transaction the button would actually send.
          account: address,
        });
        return classifyTeardownProbe({ ok: true });
      } catch (err) {
        return classifyTeardownProbe({
          ok: false,
          errorName: probeErrorName(err),
        });
      }
    },
  });
}
