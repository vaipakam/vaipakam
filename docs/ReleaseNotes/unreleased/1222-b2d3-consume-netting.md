## #1222 M3 B2-d3 — mirror chains fund their own share, and the platform stops shipping tokens a chain already holds

Stage B2-d3 of the recycling completion programme (plan #1348 §M3; umbrella
#1349; design record `Vpfi1222B2dDeliveredBackingDesign.md` §2e). The previous
stages let the canonical chain fund the entire multi-chain reward budget by
itself, because a mirror chain funding its own share was only safe once the
delivered-backing ledger existed. It does now, so this stage turns local
funding on and closes the round-trip waste the cross-chain design exists to
remove.

**Each chain now funds its reward share from its own recycled balance first.**
When the platform sizes a day's reward budget across chains, a mirror chain's
share is covered from the recycled VPFI that chain has already absorbed
locally, and the canonical chain tops up only the shortfall. What a chain can
fund locally is bounded by what it has actually reported absorbing, less
everything the platform has already instructed it to fund — so the same
tokens can never be committed twice across days, and the standing invariant
that a chain is never instructed to fund more than it has reported now binds
in practice rather than vacuously.

**The daily broadcast commits; it does not spend.** When a chain receives its
day's funding instruction, it encumbers that amount of its own recycled
balance — reserving it for the day's payouts. The balance itself is drawn down
later, as users actually claim, and an unclaimed or forfeited remainder is
released back to availability. That is the same reserve-then-spend-then-release
lifecycle the canonical chain has always run for its own commitments, so a
chain's books stay honest without any new machinery. (Debiting at instruction
time instead would have charged the same tokens twice, since claims already
debit as they pay — the review record documents that finding.)

**Remittances now carry only the top-up.** Because a chain funds part of its
own share, the platform sends only the remainder it actually funded — the two
sides sum exactly to that chain's funded budget, with nothing shipped
round-trip and nothing double-funded. The netting applies identically to the
send and to every planning quote, so what a quote reports is what a send
moves.

Everything remains dark until the governor arming ceremony, and on a
single-chain deployment the entire surface is inert.
