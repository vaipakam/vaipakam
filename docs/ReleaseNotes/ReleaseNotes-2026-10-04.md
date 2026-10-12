# Release Notes — 2026-10-04

Seven changes merged on this day. Two are contract and deployment work: the
Base Sepolia in-place refresh that removed its retired routes (#2400) and the
illiquid-collateral refinance fix (#2401). Five are connected-app and tooling
follow-ups from the 2026-10-03 live review: exact parsing of typed amounts
(#2397), the Rate Desk's disclosure of missing signed offers (#2398), the
combined Diamond ABI covering every facet (#2402), the loan-to-value on
Offer Book cards (#2404), which completes that review's UX3-007, and finding
refinance requests on chain wherever they were made (#2406). Each thread
below states its own scope and limits.

## Thread — Base Sepolia no longer routes the eleven functions its code had retired (PR #2400)

Base Sepolia was refreshed in place once more on 4 October (paused briefly from 03:00 to 03:07 UTC), using the refresh change from #2385. That change removes every function the current code no longer has. Base Sepolia had still routed eleven of them, each to the code it was last installed with:
- older shapes of the offer-accept entry points;
- two keeper-approval setters from before keeper permissions changed shape;
- four reward and acknowledgement receive hooks.

The refresh removed all eleven and checked each one afterwards, and a read of the live chain confirms none of them is routed. All 103 transactions succeeded. Every facet the deployment script installs was replaced with a fresh copy of current main. The facet that performs upgrades, which the Diamond installs when it is created, was not touched, and neither was the vault template, and the Diamond address did not change. The deployment record now covers every address the Diamond routes to. Those records are the per-chain file, its provenance record and the consolidated copy the apps and workers read. This closes #2313.

The routing record that reward-custody activation checks was taken again over the clean routing. Activation itself was not run: the owner deferred it on 4 October until the VPFI recycling work is ready. Until it runs, Base Sepolia keeps refusing reward claims and remittances that need freshly funded VPFI. Payouts funded only from recycled VPFI are unaffected.
<!-- assembled-fragment: 2313-base-sepolia-stale-routes-removed.md sha256=642cf818c9012e7acd0db1874dbdfda1589dd27eeb6f57dc0427d65ccc334682 -->

## Thread — a loan backed by illiquid collateral can now be refinanced, with both parties' consent (PR #2401)

Refinancing a loan whose collateral is illiquid used to fail every time. The new lender's acceptance opened the replacement loan and paid off the old one. Then the refinance's final risk check asked for a loan-to-value ratio and a health factor, figures the platform never computes for an illiquid asset because it values that asset at zero. The whole transaction reverted. This surfaced on a copy of the live Base Sepolia deployment in #2355's verification, as #2380.

The owner decided on 4 October that such a refinance is allowed when both parties to the new loan consent to the illiquid terms. The borrower consents in the refinance request, and the new lender consents when accepting it. The exiting lender's consent is not needed, because they are paid out in full. The final check now makes the same decision the new loan was opened under: a consented illiquid loan passes, as it does at opening. The check reads the facts recorded on the new loan when it was accepted, so a change in an asset's liquidity in between cannot strand a borrower already admitted. A fully liquid replacement is checked exactly as before.

Contract change: the refinance facet only. Base Sepolia gets it at its next in-place refresh.
<!-- assembled-fragment: 2380-illiquid-refinance.md sha256=4f9f7a407b32c5f6d1fda8bfcece58bae7ef6e3aae152d2dae0f03b7d4bdd1ed -->

## Thread — Offer Book cards state the loan-to-value (PR #2404)

The October live review asked the Offer Book to show the three facts a lender
decides on: the collateral amount, whether the collateral is liquid, and the
resulting loan-to-value. The first two shipped earlier; this adds the third.

Each token-for-token offer card now states its loan-to-value — the loan's
value as a share of the collateral's, said in those words on the card — worked
out from the protocol's live oracle prices with each side valued by its own
token's precision, the same way the protocol values a position. The figure is
the ratio at the amounts the card shows; where a fill of another size could
carry a different ratio (a ranged or part-taken lend offer, and any borrow
request, whose collateral is only a floor) the card says so rather than
calling it exact or a limit. Where a figure cannot be backed the card says
why: one side is treated as illiquid (no reliable price or too little
trading), one side's value rounds to nothing at that size, a price could not
be read right now, or the prices are still loading. Rentals, offers with an
NFT on either side, offers with no collateral and loan-position sales state no
ratio. The prices for the visible page are read in one batch and refreshed
every minute.

While building it, the contract's public pair-level loan-to-value view turned
out to ignore token decimals, which makes it wrong for pairs whose tokens use
different precision. The card does not use it; the contract issue is tracked
separately as #2403. Closes #2384.
<!-- assembled-fragment: 2384-offer-book-ltv.md sha256=c6c5e434168cf13c00f2faed57a2441a882b27f643455aa6e1717a3a27b13a18 -->

## Thread — Rate Desk says when signed offers are missing (PR #2398)

The Rate Desk merges free signed offers, which live with the offer-book
service rather than on the blockchain, into the same view as on-chain offers.
When that service did not answer, the page quietly fell back to on-chain
offers only and looked complete. When the service had more signed offers than
it returns, the page ignored that too. In both cases the best rates and the
middle rate could leave signed offers out with nothing saying so.

The market now carries one short note above all of its views — the header's
middle rate, the offers list and the chart all draw on the same offers, and on
a phone the list or the chart can be shown alone. While signed offers are
loading or could not be loaded, the note says the rates shown come only from
offers posted on the blockchain, and an offers list that is empty on the
blockchain no longer claims the market has no offers. When the service may not
have returned every signed offer — it says it cut some, or an older service
does not say — the note says the rates and amounts shown, even at the best
rate, may leave some out, and claims nothing about which ones were included. A
deployment with no offer-book service set up says so plainly, rather than
looking like a temporary failure. A signed book
whose latest refresh failed is treated as missing instead of merging the last
copy the page saw, since those orders may have been taken or cancelled since.

Closes #2386.
<!-- assembled-fragment: 2386-desk-signed-depth.md sha256=65956c3b57ab53db0c5e477f34272abc722178f8988706f7abd7fd8ed8b673af -->

## Thread — Typed amounts are sent exactly as typed, everywhere (PR #2397)

The take-back-collateral form (#2389) was the first to refuse an amount with
more decimal places than its token allows instead of quietly rounding it. This
change brings every other money input in the connected app onto the same rule:
the offer amount and collateral on the guided lend and borrow forms, the Rate
Desk order ticket and its amend fields, adding collateral, partial repayment,
the offset exit's collateral, VPFI deposits and withdrawals, the rental daily
fee, both Full-tariff fee ceilings, and the stuck-token recovery amount.
Before, most of these fed the typed text through a parser that rounds, so a
review could echo one figure while the transaction carried a slightly
different one.

Each of those inputs now shows one shared hint when the amount is too
precise, naming the token and how many decimal places it accepts, and the
step or button that would act on it stays unavailable until the amount is
fixed. The shared offer builder refuses such an amount outright as a
backstop, so no path can turn it into a rounded offer. The add-collateral and
partial-repayment actions now send the exact amount the review showed rather
than re-reading the text box at signing time.

A new unit test fails the build if any app source imports the rounding parser
again. The only exception is the faucet, which mints fixed whole-unit
presets that nobody types. Closes #2390.
<!-- assembled-fragment: 2390-typed-amounts-exact.md sha256=0eb93ac359ed2ac34427c1cd20753b666b9143987557ff61099ca14f4296a8ec -->

## Thread — The combined Diamond ABI covers every facet the Diamond has (PR #2402)

The app, the indexer and the keeper read the Diamond through one combined ABI
built from a hand-kept list of exported facets. That list left out eight
facets the Diamond actually runs, on the reasoning that they were internal
plumbing nobody calls directly. But a facet carries its events and errors as
well as its functions, so the combined ABI was missing things the Diamond does
emit: four reward-expiry events, which the indexer could therefore not decode;
the revert raised when an unexpected NFT is sent in, which the app could not
name; the role, ownership and diamond-upgrade events; and the borrower-fee
step of accepting an offer.

Following an owner decision, every facet the Diamond has is now exported —
the eight added are the access-control, ownership, NFT-receiver, diamond-cut,
offer-acceptance-fee and three reward-walk facets — and the exclusion list is
gone rather than reasoned about case by case. Listing an internal function in
an ABI authorizes nothing. A new deploy-sanity check fails whenever the
exported list and the Diamond's own facet set differ in either direction, so a
facet added later cannot be left out silently. No existing facet's ABI
changed, and no function or event name became ambiguous.

One gap remains and is tracked separately: the Diamond proxy's own
"function does not exist" revert is declared on the proxy contract rather than
on a facet, so it is still not in the combined ABI. Closes #2394.
<!-- assembled-fragment: 2394-export-every-facet.md sha256=eb27bae3babca6fd0dacdcfa16cdb4c8c8b83e92b0da7295054ae4675bcff6f0 -->

## Thread — Refinance requests are found wherever they were made (PR #2406)

A refinance request ties a loan to its current amount and collateral, so the
loan page holds back taking collateral back, partial repayment, early
close-out, handing the loan to a new borrower and offsetting it while one is
open — any of them would leave the request impossible to fill. Until now the page only knew about a request from a note the posting
device kept for itself, so a request made on another device or through
another tool was invisible, and those actions stayed available.

The page now finds the request on the blockchain. The protocol will only
settle a request made by whoever currently holds the borrower position, and a
request can only have been made after the loan existed, so the app searches
that holder's offers posted since the loan's own offer was made — a bounded
search, however long the wallet's history. An open request is preferred over an expired one,
and an expired one is still shown so it can be cancelled and its approval
removed. The card for it now shows to whoever posted it, the only wallet
that can cancel it. A request
from any device now shows with its cancel action and holds those actions
back. If the search cannot give a complete answer, the page keeps those
actions held back rather than assuming there is none, and says which of two
reasons applies: a read failed (it may answer on a later try), or the holder
has posted more offers since the loan's own offer than one search reads (a
retry will not help, so it does not suggest one; full repayment stays open).
The early-repayment chooser says the same on the rows it cannot offer, rather
than pointing at a card that is held back, and the full-repayment review warns
that a request could exist while the search has not answered. An expired
request no longer holds anything back, including posting a new request. A
wallet that posted a request and then transferred the position, or whose loan
has settled, is shown that request from any device, since only the poster can
cancel it and remove its payoff approval. If an offset, a partial repayment, an
early close-out or a full repayment stops after its token approval was
granted — for instance because a last check found a refinance request, or
the transaction failed — the approval is now put back to what it was, as the
handover and refinance flows already did, and a failure to do so is said.
A full-repayment review is checked again every time it is confirmed; if
the check finds something the review did not say, the review says it first
and the next confirmation repays, and a warning from an earlier check is
dropped once a later one comes back clear. A wallet whose own offers could
not be searched — the search failed, or there are too many — is told the
page cannot show a request it may have posted, and how to clean it up by
hand. Two devices posting a refinance request at the same moment can still
both succeed; the specification says so, and the second is shown for
cancelling once the first is gone.
Each of those actions repeats the search just before the wallet opens. One
narrow race remains and is stated in the specification: a request posted in
the moments between that last check and the transaction being mined, since the
protocol itself does not refuse those actions while a request stands. This needs no indexer change, which also avoids the
deploy-ordering risk a new indexer column would carry. Closes #2391.
<!-- assembled-fragment: 2391-refinance-discovery.md sha256=bc5ce2fa0ddb46217524cd2b678fdd77cde4e5116e67cb2c05cfe25f4698814d -->
