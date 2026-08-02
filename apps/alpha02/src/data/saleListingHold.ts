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
import {
  BaseError,
  ContractFunctionRevertedError,
  toFunctionSelector,
  zeroAddress,
} from 'viem';
import { DIAMOND_ABI_VIEM } from '../contracts/diamond';
import { useActiveChain } from '../chain/useActiveChain';
import { tipAware } from '../chain/railHealth';

export type SaleListingHoldState =
  | 'none'
  | 'live'
  | 'clearable'
  | 'accepted'
  | 'unknown';

/** LibERC721.LockReason.EarlyWithdrawalSale — the lender NFT's lock
 *  while a sale lifecycle (listing OR accepted-awaiting-completion)
 *  is in flight. Mirrors data/loanSalePending.ts. */
const LOCK_EARLY_WITHDRAWAL_SALE = 2;

/** The PR-A bounded-listing selector — the positive facet-version
 *  signal. The PRE-refresh Diamond routes the same one-argument
 *  teardown selector but with the OLD semantics (terminal-loans-only,
 *  pause-gated, no expiry admission), and it shares error names with
 *  the new facet — so a raw probe against it would misclassify a
 *  legacy GTC listing as boundedly `live` (Codex #1511 r1 P1). Only a
 *  Diamond that routes the 4-arg `createLoanSaleOffer` carries the
 *  lifecycle this surface describes; anything else stays `unknown`
 *  (render nothing). */
const BOUNDED_LISTING_SELECTOR = toFunctionSelector(
  'function createLoanSaleOffer(uint256,uint256,bool,uint64)',
);

/** Pure classifier for the teardown probe outcome — split from the
 *  hook so the mapping is unit-testable without a chain.
 *
 *  `saleLocked` corroborates the ambiguous arm (Codex #1511 r3): the
 *  teardown reverts `NoStaleSaleListing` BOTH when no listing exists
 *  AND for an accepted sale awaiting its documented manual-recovery
 *  completion — but only the latter keeps the lender NFT sale-locked,
 *  and it still holds the borrower's offset path
 *  (`loanToSaleOfferId` is retained). Mapping it to `none` would hide
 *  a real hold. */
export function classifyTeardownProbe(input: {
  ok: boolean;
  errorName?: string | null;
  saleLocked?: boolean;
}): SaleListingHoldState {
  if (input.ok) return 'clearable';
  switch (input.errorName) {
    case 'NoStaleSaleListing':
      return input.saleLocked ? 'accepted' : 'none';
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

export function useSaleListingHold(
  loanId: number,
  /** The loan's lender position token id — corroborates the
   *  accepted-sale arm; pass '' when unknown (arm degrades to
   *  `none`). */
  lenderTokenId: string,
  enabled: boolean,
) {
  const { readChain, address } = useActiveChain();
  const readClient = usePublicClient({ chainId: readChain.chainId });

  // Deployment-level capability probe, cached SEPARATELY (Codex #1511
  // r3): selector routing changes only when a facet cut deploys, so
  // re-reading it on the tip-driven cadence would waste ~2 RPC calls
  // per block per tab. A long staleTime + no focus refetch keeps it
  // to roughly one read per session; a mid-session facet refresh is
  // picked up on the next full page load, which a deploy implies
  // anyway.
  const cut = useQuery({
    queryKey: ['saleListingCut', readChain.chainId],
    enabled: enabled && Boolean(readClient),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    queryFn: async (): Promise<boolean> => {
      const facet = (await readClient!.readContract({
        address: readChain.diamondAddress,
        abi: DIAMOND_ABI_VIEM,
        functionName: 'facetAddress',
        args: [BOUNDED_LISTING_SELECTOR],
      })) as `0x${string}`;
      return facet !== zeroAddress;
    },
  });

  const probe = useQuery({
    queryKey: ['saleListingHold', readChain.chainId, loanId],
    // Version gate BEFORE interpretation — the probe never runs (and
    // the state stays undefined → render nothing) until the loupe
    // confirms the bounded-listing cut. Same signal the fork spec
    // self-arms on.
    enabled:
      enabled && Boolean(readClient) && loanId > 0 && cut.data === true,
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
        const errorName = probeErrorName(err);
        // Corroborate the ambiguous arm with the lender NFT's sale
        // lock (Codex #1511 r3) — one extra read ONLY when the
        // teardown says "nothing stale", which is also the resting
        // state for most loans; a plain unlisted loan costs the same
        // two calls as before the split.
        let saleLocked: boolean | undefined;
        if (errorName === 'NoStaleSaleListing' && lenderTokenId) {
          saleLocked =
            Number(
              await readClient!.readContract({
                address: readChain.diamondAddress,
                abi: DIAMOND_ABI_VIEM,
                functionName: 'positionLock',
                args: [BigInt(lenderTokenId)],
              }),
            ) === LOCK_EARLY_WITHDRAWAL_SALE;
        }
        return classifyTeardownProbe({ ok: false, errorName, saleLocked });
      }
    },
  });
  return probe;
}
