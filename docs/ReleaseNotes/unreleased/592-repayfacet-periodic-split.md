# RepayFacet split — periodic-interest + NFT-rental cluster moved to RepayPeriodicFacet (#592)

The #592 VPFI lender-proceeds reservation logic grew `RepayFacet` past the
EIP-170 24,576-byte contract-size limit. To stay deployable, the
permissionless NFT-rental daily-deduction loop and the periodic-interest
settlement cluster were moved out of `RepayFacet` into a new
`RepayPeriodicFacet`. `RepayFacet` keeps the borrower-driven full/partial
repayment surface; both facets are now comfortably under the size limit.

This is a **pure structural move** — no behaviour change. The moved functions
keep the same names, signatures, and semantics; they simply route to a
different facet behind the Diamond. From a caller's perspective nothing
changes (the Diamond resolves each function to its facet by selector as
before).

Integrators that hold per-facet ABIs gain a new `RepayPeriodicFacet` ABI; the
moved functions are no longer in the `RepayFacet` ABI. The full-Diamond ABI
bundle (frontend / workers) is unchanged in aggregate — the same selectors are
present, just split across two facet ABIs.
