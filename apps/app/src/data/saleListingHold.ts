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
import { zeroAddress } from 'viem';
import {
  BOUNDED_LISTING_SELECTOR,
  probeSaleHoldLive,
  type SaleListingHoldState,
} from '@vaipakam/lib/saleHold';
import { DIAMOND_ABI_VIEM } from '../contracts/diamond';
import { useActiveChain } from '../chain/useActiveChain';
import { tipAware } from '../chain/railHealth';

// The probe and its classifier live in `@vaipakam/lib/saleHold` (#2483):
// the keeper's grace-default pass must refuse an accepted sale by exactly
// the rule this app's close-out card applies, so there is one copy of it.
export {
  classifyTeardownProbe,
  probeErrorName,
  probeSaleHoldLive,
  type SaleListingHoldState,
} from '@vaipakam/lib/saleHold';

/** Query state as this module consumes it — the three fields the gate
 *  below actually reads, so it can be exercised without a QueryClient. */
export type HoldQueryState<T> = {
  data?: T;
  isPending: boolean;
  isError: boolean;
};

/** The fail-closed gate, split from the hook so the whole cut×probe
 *  matrix is unit-testable (two separate P2s have come out of this
 *  interaction — Codex #1511 r6/r11 and the pre-merge review).
 *
 *  Two outputs that must stay in lockstep:
 *   - `data`     — what the surfaces RENDER. Undefined means "say
 *                  nothing".
 *   - `resolving`— whether the settlement surfaces must PAUSE.
 *
 *  The invariant: `data === undefined && !resolving` is permitted for
 *  exactly two reasons — the hook is disabled, or the capability
 *  answered a definite NO (a Diamond with no bounded-listing facet has
 *  no hold and no accepted-sale window, so there is nothing to pause
 *  for). Every OTHER route to an undefined `data` must pause. */
export function computeHoldGate(input: {
  enabled: boolean;
  cut: HoldQueryState<boolean>;
  probe: HoldQueryState<SaleListingHoldState>;
}): { data: SaleListingHoldState | undefined; resolving: boolean } {
  const { enabled, cut, probe } = input;
  const capabilityPresent = cut.data === true;
  // Never answered at all: pending, or errored with nothing cached.
  //
  // Scoped to `data === undefined` deliberately. A query that already
  // answered FALSE keeps that answer through a failed re-ask, and on a
  // deployment whose answer IS false — which is every user on the
  // pre-refresh Diamond today — pausing there would strand borrowers
  // behind one rate-limited RPC call, repay included, for as long as
  // the RPC stays unhealthy. That is a pure availability regression
  // against a feature the chain does not even have yet.
  //
  // The counter-argument is that an errored negative has UNBOUNDED
  // staleness (the capability could have flipped and we cannot tell),
  // so it is not the same as a bounded-stale success. True — but this
  // flag was never the thing keeping a settlement safe. Every
  // settlement path re-probes the chain LIVE immediately before it
  // sends, with no version gate, and refuses on anything it cannot
  // classify. That gate is the arbiter; `resolving` only decides
  // whether the UI says "checking…" first. Failing this flag open
  // costs no safety and buys back the borrower's ability to repay.
  const capabilityUnanswered =
    cut.data === undefined && (cut.isPending || cut.isError);
  const resolving =
    enabled &&
    (capabilityUnanswered ||
      (capabilityPresent &&
        // A failed REVALIDATION of a positive capability masks the
        // data below, so it has to pause too.
        (cut.isError ||
          probe.isPending ||
          probe.isError ||
          // An undecodable outcome on a CAPABLE Diamond is ambiguous.
          probe.data === 'unknown')));
  // `enabled` masks too: a disabled hook keeps both queries' cached
  // data, and a surface that has been switched off must not keep
  // reporting the last hold it saw.
  const data =
    enabled && capabilityPresent && !cut.isError && !probe.isError
      ? probe.data
      : undefined;
  return { data, resolving };
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
    // Capability answers age on deployment-scale cadences (Codex
    // #1511 r4 + r7): a NEGATIVE (or errored) result re-asks every 10
    // minutes so a tab opened before the facet refresh notices it
    // arriving; a POSITIVE result re-validates hourly so a facet
    // ROLLBACK can't leave the probe interpreting legacy semantics as
    // bounded ones indefinitely. (A deploy doesn't reload open tabs
    // in either direction.)
    refetchInterval: (query) =>
      query.state.data === false || query.state.status === 'error'
        ? 600_000
        : 3_600_000,
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
    // The account keeps the probe faithful to the transaction the
    // button would send; the entry is permissionless, so any works.
    // Unknown RPC failures propagate as query errors (fail closed
    // upstream). The lock corroboration inside costs one extra read
    // ONLY when the ambiguous NoStaleSaleListing arm fires.
    queryFn: () =>
      probeSaleHoldLive(
        readClient!,
        readChain.diamondAddress,
        loanId,
        lenderTokenId,
        address,
      ),
  });
  // Fail-CLOSED gate for the settlement surfaces — see computeHoldGate
  // for the full rationale and the data/resolving invariant it keeps.
  const { data, resolving } = computeHoldGate({
    enabled,
    cut: { data: cut.data, isPending: cut.isPending, isError: cut.isError },
    probe: {
      data: probe.data,
      isPending: probe.isPending,
      isError: probe.isError,
    },
  });
  return { ...probe, data, resolving };
}
