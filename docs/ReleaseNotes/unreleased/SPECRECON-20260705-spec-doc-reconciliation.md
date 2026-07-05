## Thread — FunctionalSpecs reconciled with 2026-07-05 owner intent-decisions (PR #1011)

The spec-vs-code conformance review (2026-07-05, recorded in PR #997) produced
fourteen owner intent-decisions. This PR lands the "spec is stale" half of
those decisions in the FunctionalSpecs test oracle, so the documented intended
behaviour matches what the owner has confirmed the platform should do: the
risk-adjusted Health Factor formula (collateral times its liquidation
threshold, over borrowed value), the 30-day grace bucket for loans of 365 days
and longer, grace-window interest accrual with late fees charged in addition
to it, the yield-fee base covering interest and late fees, the widened
peer-LTV agreement band, the governance-cap stale-tier fallback, the
KYC-valuation base of principal plus collateral (dormant industrial-fork spec
only), the launch-versus-ceiling loan-duration distinction, and the
keeper-initiation execution class with per-action opt-in grants.

The tokenomics allocation table was also normalized to exactly 100% of the
230M supply cap by the owner's reconciliation: the Reserve line becomes 24%
(the freed staking pool only — the removed 1% fixed-rate-sale slice is
dropped), and Exchange/Market-Making is fixed canonically at 12%, with the
public whitepaper's allocation table aligned to the same numbers in the same
change-set. The bug-bounty allocation is consistently described as a
multisig-held operational treasury bucket — never an insurance product — and
any automated surplus recycling is disabled-by-default and industrial-fork
gated.

A Codex review pass then propagated these decisions to every stale echo:
the deployment runbook's production-readiness gate now points at the VPFI
TokenPool per-lane CCIP rate limits (the removed buy-adapter caps are
tombstoned as historical), the reward-mesh funding formula and accounting
identity are stated per side (lender and borrower halves each scaled by their
own chain-over-global ratio, matching the implementation), the public
overview's yield-fee copy states the interest-plus-late-fee base with the
principal-first exception, and the create-offer duration copy derives from
the live configured maximum. Follow-ups deferred: locale translation sync
for the overview copy (nine non-English locales), and a shell-comment cleanup
in the deploy scripts.
