## Thread — Honor the lender Full/hold stamp on the repay-family settlement paths (M2 PR-6 follow-up, part B2 — repay family) (PR #<n>)

Continues #1383 (part B delivered the swap family via the shared resolve host).
This part delivers the same §F2 lender Full/hold yield-fee discount (#1354) to the
**repay-family** secondary settlement paths, which previously transferred the
treasury cut with **no** discount:

- **`RepayFacet.repayPartial`** (ERC-20 and NFT-rental branches) — keyed on the
  current lender-NFT holder (this path does not reliably consolidate
  `loan.lender` — the #597 `heldForLender` exclusion).
- **`RepayPeriodicFacet.autoDeductDaily`** (NFT-rental daily interest) — keyed on
  the current holder, which the daily payout already routes to.

The VPFI-payment delivery can drive the treasury share to zero (the cut is paid
in the lender's VPFI instead). Both paths transfer the treasury cut
unconditionally, and they deliberately stay that way: a zero-amount transfer is
a harmless no-op, and adding a skip would have quietly changed long-standing
behaviour that existing tests pin.

A rental-specific correctness fix rides along: the yield fee on an NFT rental is
denominated in the rental's prepay asset, but the discount quote was pricing it
against the loan's principal asset — which for a rental is the rented NFT
itself. Asking for a price and decimals on an NFT simply fails, so the quote
gave up and every rental lender silently lost the option to pay the fee in VPFI.
The quote now prices against whichever asset the fee is actually denominated in,
which fixes it for every rental settlement path at once. The no-token-move
discount was never affected.

To make the room for these on the at-EIP-170 `RepayFacet`, its **primary**
`repayLoan` path is switched from inlining the discount delivery to calling the
same diamond-internal resolve host the secondary paths use — a net bytecode
**reduction** (the delivery logic lives on one facet), behaviour-preserving, and
it also moves the analytics passthrough event onto the host so the facet no
longer emits it separately. As part of the same hardening, `repayLoan` and
`swapToRepayFull` now key the resolve on the current lender-NFT holder rather
than `loan.lender`, so a settlement whose lender consolidation was skipped (a
sanctioned holder / the `heldForLender` exclusion) can never resolve the
discount — or a VPFI vault debit — for the wrong party.

The remaining secondary paths — preclose obligation-transfer / offset /
rental-prepay, and the auto-lifecycle transferred-position case — are handled
next, reusing this same host.

Ships **dark**: no loan carries a `Full` lender stamp until the M2
`feeEntitlementEnabled` cut-over, so every current repay settlement resolves to
exactly the pre-existing behaviour (which now also includes the consent-gated
hold discount these paths formerly ignored).

Tests: a Full-stamped lender settled through `repayPartial` receives the exact
10% treasury-cut discount (reference vs Full); the existing `repayLoan`
settlement-sweep suite re-runs green through the host (behaviour-preserving
conversion). Part of #1383. Umbrella: #1349.
