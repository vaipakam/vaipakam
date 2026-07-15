## alpha02 Claim Center — "Claim everything at once" (PR #<n>)

The Claim Center gains a one-signature Claim-All CTA (#1268 / E-10), the
frontend half of the on-chain `MulticallFacet.multicall` batching shipped
in #1212. When two or more payouts are ready, the user can collect them
all in a single wallet signature instead of one transaction per claim.

The batch spans the four data-ready payout types: lender and borrower
loan/rental proceeds, pending interaction rewards, and free
(unencumbered) vault VPFI. Each payout is shown for individual
include/exclude before signing. Withdrawing parked vault VPFI is opt-in
and off by default — that balance backs the fee-discount tier, so pulling
it lowers the tier, and quietly draining it would be a footgun.

Honesty is preserved throughout: every batched item is best-effort
(`allowFailure`), so a payout another party finalizes between preview and
signing is skipped rather than aborting the batch, and the rest still
execute; the per-item outcome is surfaced by re-deriving eligibility
after the receipt, so claimed items drop off and skipped ones remain
listed to claim on their own. The selection is capped at the on-chain
batch bound (30). The batch can include the interaction-rewards claim, so
a live, fail-closed sanctions re-read gates submission — matching the
standalone rewards button. The card only appears once the claimables list
has settled and only for two or more batchable payouts, so it never
advertises a partial loan set that is still loading.

Lender-intent capital and payroll salary are a documented follow-up — no
alpha02 read surface exists for them yet.

Closes #1268.
