# Release Notes — 2026-11-01

A refinance now completes in the single transaction that accepts the borrower's request: the new lender's money pays the old lender directly, and the borrower's wallet pays only the difference. An internal match between two loans is refused when one leg delivers short, so each loan falls back to its own liquidation, which pays the lender first. The protocol's lifetime totals for principal lent and interest paid are now counters kept as loans open and settle, instead of a scan of every loan, and the interest figure is interest actually charged. The discounted liquidation route moves to its own facet with no change in behaviour, and the treasury's unused external-yield feature is removed. These contract changes reach the testnets only with the all-waves fresh deploy.

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

_Committed 2026-11-01 05:06 UTC (263845257)._
<!-- assembled-fragment: 1832-lifetime-lending-counters.md sha256=eb63188207d6b894e521801af0c0a73e31f8d84563934f596f059365581abe7b -->

## Thread — The discounted liquidation route moves to its own facet (PR #3084)

The discounted liquidation route (the liquidator pays the loan's whole debt
and receives the collateral at a per-tier discount, usually inside a flash
loan) has moved out of the risk facet into a facet of its own, the
discounted-liquidation facet. The risk facet was 45 bytes under the
24,576-byte contract size limit, and the queued lifetime-counters change (#1832) would have pushed it
over, which would have made every later change to it undeployable. The
discounted route was already a self-contained entry point, so it moved whole
rather than having unrelated code trimmed to fit, the same way the split-route
and internal-match liquidations were carved out before.

There is no behaviour change. The entry point keeps its exact function
signature, so its selector is unchanged and every caller that reaches it
through the Diamond (the flash-loan liquidator contract, the keeper, external
liquidators) is unaffected. Its checks, the figures it charges and seizes, the
claims it records, the loan's transition to Defaulted and its event are the
same; the event and its errors were moved with it unchanged, so their topic
and selectors are unchanged too. It still reads the health factor, the eager
consolidation and the collateral lien through the same Diamond hosts as
before.

The two facets carry one behaviour and must be refreshed together. The deploy
and the all-facets refresh carry both; the curated liquidation refresh now
carries the new facet too, moving the route's already-routed selector onto it
in the same cut as the risk facet. Refreshing the risk facet alone would leave
the discounted route on the previous risk-facet build.

The connected app, the indexer and the keeper read the combined Diamond ABI,
which now names the route under its new facet. The risk facet's own ABI no
longer lists the discounted route, its event or its four route-only errors.

No functional specification changes: this is a structural move, and what the
platform is meant to do is unchanged.

_Committed 2026-11-01 03:53 UTC (9151cc11b)._
<!-- assembled-fragment: 1832-risk-discounted-split.md sha256=54bdb9ae807681a4438d064c7f218c203363bdd12c4b6736056aea93f690a3da -->

## Internal match refuses a leg that delivers short (PR #3082)

An internal match now refuses itself when one of its legs delivers less to
the receiving lender than it sent. Only a token that charges on transfer,
outside the supported set, can do this. Until now the match went ahead and
cleared the receiving loan's debt by what actually arrived, leaving the
difference owed on that loan, even though its own collateral may already
have been used in full by the other leg. The owner decided to refuse the
match instead, so each loan falls back to its own liquidation, which pays the
lender first.

A match someone starts directly now reverts with the platform's usual
short-delivery error, naming the token and both amounts. A match the protocol
tries first inside a health-factor liquidation, a time-based default or a
fallback claim is skipped instead: it runs in its own call, so the refusal
unwinds the match alone, and a new event reports the skip with the two loans,
the token and both amounts. The loan then carries on to its own close-out in
the same transaction. That includes a loan inside the internal-match priority
window, which normally holds a loan for an internal match and refuses its
own liquidation: the window holds a loan only while a match can run, so after
a refusal the same liquidation goes ahead instead of reverting. Only that refusal is caught. Any other failure inside
the match still stops the whole call, as before, so a caller cannot turn a
match into a skip by starving it of gas.

Because every leg that completes has now delivered in full, the per-leg
"paid" figures the match carried for the short case are gone, and each loan's
debt clears by the amount its leg moved. The matcher's incentive is still not
measured: a charge on it falls on the matcher, who chose the match, and books
no one as paid.

The match facet gains one Diamond-internal entry for the isolated call. The
full refresh and a fresh deploy pick it up; the curated facet refresh adds it
on an older Diamond. Without it every liquidation, default or claim that found
a match candidate would revert.

Advances #2625 (item 3, owner decision 2026-10-28). Items 2 and 4 stay as
they are by the same decision.

_Committed 2026-11-01 02:42 UTC (0da3f27d8)._
<!-- assembled-fragment: 2625-short-internal-match-leg.md sha256=1ee558a6b7cfa8eab72d66a3783afb8c86f054fd2c63936af6f995895cc396df -->

## Thread — Every refinance is atomic, and the new principal pays the old lender directly (PR #3077)

A refinance used to move money in a round trip through the borrower's wallet: the accept delivered the new lender's principal, less the initiation fee, to the borrower, and the refinance then pulled the whole payoff back out of that wallet. It could also be finished later, in a second transaction, by the borrower or a delegated keeper. Both are gone. A refinance now completes only inside the transaction that accepts, or matches, the borrower's refinance-tagged request, and inside it the new lender's net principal goes straight from the new lender's vault to the old lender's vault.

The borrower's wallet now pays only the difference: the rest of the old lender's due and the treasury's cut of the old loan's interest. For a request asking for the old principal, that is the old loan's interest (and any late fee) plus the new loan's initiation fee. The new principal can never exceed what the old lender is owed, because a request may not ask for more than the old loan's outstanding principal, so there is no surplus to return; a refinance in which there would be one is refused rather than leave the excess anywhere.

Each refinance now publishes one settlement statement naming its three legs: what the new lender's net principal paid the old lender, what the borrower's wallet paid the old lender, and what the borrower's wallet paid the treasury. The refinance event itself drops a field that had been a constant zero since the earlier removal of the rate-shortfall top-up.

The standalone refinance step and the keeper permission bit for it are retired. Granting that bit is now refused as an undefined action, and the app no longer offers it in the keeper settings. The auto-refinance switch still governs only the matcher; a lender accepting a request directly is never blocked by it.

The borrower's wallet share is paid through the request's single-use payoff permit (#1558, which landed first), and the permit is now signed for that share instead of the whole payoff. The payoff view reports the share now and at the request's last fillable moment, so the app's figure is the contract's own. The share is an upper bound: it uses the live initiation-fee rate with no discount, so a fee discount only lowers what is actually taken. When the share is zero (nothing beyond what the new loan's money covers), the app asks for no permit at all and says the request can complete as it is, since the contract takes nothing from the wallet and consults none. The copy says that the new loan's money pays the current lender directly; the "Refinance all" batch on Positions signs each request for its own share, and the Activity page lists the settlement statement on the old loan's timeline. On a deployment that predates both changes, the app's temporary approval route still covers the whole payoff, because that contract still pulls it.

This ships by fresh deploy only. The curated refresh scripts refuse a Diamond that still routes the retired refinance step, because the accept and the payoff now hand off within one transaction and must be on the same code. Design: `docs/DesignsAndPlans/Refinance3042NettedAtomicDesign.md`. Closes #3042.

> Caveat: a governance raise of the initiation-fee rate after a request is posted raises the wallet's share above the permit signed for it; the request's card reads the permit as short and asks for a fresh signature.

_Committed 2026-11-01 02:18 UTC (1e8bb5350)._
<!-- assembled-fragment: 3042-refinance-netted-atomic.md sha256=41efff25fc52b887b325c4340d469d30b1223c2cd805f4ae7adcca968a13702a -->

## Treasury yield retired (PR #3081)

The Diamond no longer deploys treasury balances into external yield venues.
The "productive treasury reserve" let governance supply idle treasury tokens
to Aave V3, with a Lido venue reserved. It is removed while the platform is
prelive. Its eleven admin entry points and views are gone from the treasury
facet, along with its library, its events and errors, and its test suite.

Why: on the intended mainnet setup the treasury is an external multisig, so
fees leave the protocol as they are collected and the Diamond holds no idle
treasury to deploy. As built, the feature also took on Aave risk for yield it
could never collect, because there was no harvest path (#962). A single venue
loss would have locked its own configuration for good, because nothing could
write a shortfall off (#963). Rather than build harvest and write-off
machinery for funds the protocol should not hold, the multisig holds any yield
position itself, outside the protocol.

The protocol metrics view now reports the treasury as what the Diamond
actually holds. It no longer adds principal recorded as deployed elsewhere.
The six storage slots the feature used keep their places, are marked retired,
and are no longer written or read. The shared Aave pool interface keeps only
the flash-loan entry the flash-loan liquidator uses.

No deployment configured the feature. No script ever set a venue or a pool,
and the live Diamonds on Base Sepolia, Arbitrum Sepolia and BNB Testnet all
read an unset Aave pool and Lido address. A deployment needs the pool, so no
chain has principal deployed through the feature that this change could
strand.

Closes #962, #963, #486, #487.

_Committed 2026-11-01 01:09 UTC (0fad48f55)._
<!-- assembled-fragment: 962-retire-treasury-yield.md sha256=739b49d209440a35fa9f47734e62899d980f07e8f18a9c9efd9e47e1976f1300 -->
