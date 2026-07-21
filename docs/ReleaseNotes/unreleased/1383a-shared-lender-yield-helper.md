## Thread — Extract the shared lender-yield-fee resolve helper (M2 PR-6 follow-up, part A) (PR #<n>)

Groundwork for #1383. The lender yield-fee settlement delivery — the
`consent OR Full`-stamp eligibility gate followed by the
"try VPFI-payment, else direct-reduction" fallback that #1354 wired into the
four **primary** lender-yield settlement paths (terminal repay, preclose direct
close, refinance, and the auto-lifecycle interest sweep) — was duplicated
almost verbatim across those four facets. This change extracts it into a single
shared helper, `LibVPFIDiscount.resolveLenderYieldFee`, and points the four
primary facets at it.

The helper takes the settlement's pre-split interest and the full treasury share
and returns the deltas the caller folds into its plan: how much extra the lender
keeps in the lending asset, the treasury share that actually transfers, and any
VPFI debited from the lender's vault. The four call sites collapse to a single
call plus a three-line apply, with no change to what any of them compute or
move — the lender still receives exactly the same discounted settlement as
before.

This is a **pure, behaviour-preserving refactor**. It ships **dark** for the
same reason #1354 did — no loan carries a `Full` lender stamp until the M2
`feeEntitlementEnabled` cut-over, so every current settlement still resolves to
the pre-existing consent-gated hold discount. Nothing an external caller can
observe changes today.

Its purpose is to give the **secondary** settlement paths (#1383 part B:
swap-to-repay, partial repay, preclose obligation-transfer / offset /
rental-prepay, periodic interest) one proven, size-cheap entry point to honor
the same lender Full/hold discount — several of those facets sit too close to
the EIP-170 limit to inline the delivery block a fifth, sixth, and seventh time.
Part B wraps this same helper behind a diamond-internal host so those
size-constrained facets can call it without carrying the delivery logic in their
own bytecode, and extends eligibility to the current position-NFT holder on the
paths that don't consolidate the lender.

Part of #1383. Does not itself close the `feeEntitlementEnabled` cut-over
blocker — part B does.
