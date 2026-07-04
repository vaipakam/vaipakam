## Thread — alpha02 claimables are on-chain-authoritative (#921 item 7 / #958)

alpha02's Claim Center no longer depends on the indexer to decide what's
collectable. Previously it read the indexer's `/claimables` endpoint
(which lists only terminal statuses) and merged `fallback_pending`
lender loans back in client-side — a gap, because the indexer
deliberately does not mirror `FallbackPending` (it's transient and
reversible, and reversible state doesn't belong on shared indexer infra
that apps/defi also reads).

The Claim Center now works the way apps/defi's already does: the indexer
stays the fast approximate candidate layer (the wallet's own loans via
`useMyLoans`), and the chain is the authority. For each candidate loan
the hook confirms on-chain that the wallet still holds that side's
position NFT (`ownerOf`) and that `getClaimable(loanId, isLender)`
reports an unclaimed, actionable payout (mirroring ClaimFacet's own
guard, including the Phase-5 borrower LIF rebate). A `fallback_pending`
lender loan now surfaces naturally — `getClaimable` reports the
recoverable collateral the claim-time fallback resolves — so the
client-side special-case merge is gone, and a sold or fully-settled
position no longer shows a phantom claim.

The honesty contract is preserved: a per-loan revert means "not
claimable this side" and is excluded, while a transport failure means
"couldn't confirm" and collapses the whole result to unavailable rather
than a confident short list that could hide real funds. The
secondary-market parity gap that existed when this thread started —
a pure position-NFT buyer, never an original party to the loan, wasn't
discovered because the candidate set was only the wallet's own loans —
was closed later in this same batch: the candidate set now unions the
indexed loans with the on-chain position-NFT enumeration
(`getUserPositionLoansPaginated`), so chain-held positions are found
even when the indexer has never heard of the wallet (see the #988
remediation thread).
