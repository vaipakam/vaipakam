## Lender fee discount now works without a VPFI price (E-1, direct-reduction)

The lender yield-fee discount previously required the VPFI pricing peg to be
configured: the discounted treasury cut was paid *in VPFI* out of the lender's
vault, and with the peg intentionally left unset at launch, a consenting,
VPFI-holding lender simply paid the **full** fee — vaulted VPFI carried no
day-one fee utility.

E-1 adds a second, peg-free delivery: when no VPFI price source is configured,
the same tier discount is delivered as a **direct reduction of the
lending-asset treasury fee**. A consenting lender who holds a discount tier now
pays a smaller fee in the loan's own asset — "hold VPFI, pay lower fees" — with
no token conversion and no VPFI moving. When a price source *is* configured,
the existing VPFI-payment mode remains authoritative and this fallback stays
inert; the mode is chosen from the price-source configuration directly, so a
transient oracle gap can't flip it.

The reduction applies across the terminal lender-yield settlement paths that
already carried the VPFI-payment discount — ordinary repayment, preclose,
refinance, and the keeper auto-lifecycle servicing — and is exact: treasury
receives `fee × (1 − tierDiscount)` and the lender keeps the difference.
Lenders without discount consent, or at tier 0, pay the full fee unchanged.

Not in this slice (tracked as follow-ups on #1203): extending the discount to
the periodic-interest and swap-to-repay servicing sites (which apply no lender
discount today), an analytics event distinguishing the delivery mode, and the
tariff-priced discount-entitlement route (deferred with the parked VPFI
recycling work). Part of #1221 (E-1). Closes the peg-free half of #1203.
