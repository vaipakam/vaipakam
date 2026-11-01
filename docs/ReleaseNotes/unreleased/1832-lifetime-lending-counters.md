## Lifetime lending totals are counters, not scans (PR #3085)

The protocol-wide totals for principal lent and interest earned used to be
computed by reading every loan ever made, on every call. That cost grew with
the history, and the interest figure was not interest anyone paid: it was each
closed loan's principal times its yearly rate, whatever the loan actually
charged, including for loans that defaulted. By the owner's decision, both are
now per-asset counters written as loans open and settle, and valued when read.

Principal lent is recorded once per loan, as it opens, at the amount it opened
with. Interest paid is recorded as each settlement charges it: the interest
and any late fee, before the treasury's share. Every payment on a loan that
stays open already passes through one shared step (the one that pays past
sellers of the lender position first), so it is recorded there once; each
closing settlement records its own figure where that figure is final. A forced
sale records what it recovered, and a payment that reaches a sanctions-held
lender short (a token that charges on transfer) records only the interest
that arrived; the rest is still owed and is recorded when it is paid. A recovery in kind, or through the liquidation
fallback and its retry, is not counted, because it settles principal, interest
and any bonus as one amount and no interest figure can be stated for it.
Rental fees on NFT loans are rent, not interest, and are not counted.

Two new views expose the counters in each asset's own units, exact and
unvalued: the list of lending assets, and the two totals for one asset. The
headline stats view now values those counters at today's prices, one valuation
per asset, and reports "interest paid" rather than "interest earned". The
separate full-scan interest view is retired.

The counters start empty on the Diamond they are added to and do not count
history from before it, so they reach a chain by fresh deploy, like the rest
of the current wave.

Closes #1832.

> Caveat: interest settled in kind or through the liquidation fallback is not in the interest total.
