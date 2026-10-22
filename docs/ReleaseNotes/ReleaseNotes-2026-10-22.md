# Release Notes — 2026-10-22

Today the protocol began to book only what arrived. Every token move it records is now measured where the tokens land:

- a flow a user chose refuses a short arrival;
- a forced close-out (a liquidation, a default or the in-kind fallback) acts on what arrived, puts any shortfall on that loan's own figures and pays the lender first;
- every fee or share sent to the treasury goes through one host, which records what reached the treasury.

For an ordinary token, which delivers exactly what it sends, nothing changes. The change has not reached the testnets yet: testnet refreshes wait until the current waves of work are done.

## Thread — The protocol books only what arrived (PR #2622)

Every token move the protocol records is now measured where the tokens land,
so no ledger can name tokens that are not there. Before this change the
protocol recorded the amount it asked a token to move. For an ordinary token
that is the same thing, but a token that delivers less than it sends (a fee on
transfer, share rounding, an upgradeable token that switches a fee on after a
loan opens) left the books ahead of the balances. A forced close-out then sold
or forwarded the full recorded collateral, and the difference came out of
tokens the protocol holds for other users. A deposit or repayment recorded the
full amount against a vault that received less, so the lender's claim could
not be paid in full.

The rule has three outcomes, and the FLOW a move belongs to decides which
one applies, never the move alone. A payment from a user's wallet (offer
funding, collateral, a rental prepayment, repayment, preclose, refinance, a
liquidator's payment, a fee, and Permit2 pulls) is refused by name unless all
of it arrived, in every flow. A flow someone chose to start now (accepting an
offer, repaying, preclosing, refinancing, swap-to-repay, selling a lender
position on either route, a rental day, an in-place extension, a marketplace
sale of the collateral) records the party it pays as paid in full, so every
hop inside it is refused when it lands short: out of a vault, onward from the
protocol, and into the receiving vault. A token can charge one hop and not
another, which is why the first review round's fixes, which measured only some
hops, were not enough. A move the protocol must complete (liquidation in all
its routes, time-based default including the in-kind and rental cases,
periodic-interest auto-liquidation, the fallback entry and the fallback retry)
never stalls: it acts on what arrived, the claim, lien or custody row beside a
credit names that same figure, and the shortfall reduces only that loan's own
figures. In an internal match, a leg that delivers less clears only what it
delivered of the receiving loan's debt, and the rest stays owed on that loan.
This keeps the lender-first principle (owner decision 2026-10-20): issue #2440
suggested refusing a short delivery on liquidation, which was deliberately not
taken because it would trap the lender once a token switched a fee on.

Three kinds of move pay no counterparty, so they act on what arrived in every
flow. A fee drawn from a vault for the treasury or for the party who matched
two offers is recorded as it arrived, and its recipient bears the charge. A
payout of a user's own balance, or of a recorded claim, pays what the token
delivers. And a transferred position's backing following it to the new
holder's vault (the borrower's collateral, or the lender's parked proceeds)
carries one side's own backing between that side's vaults: that side bears its
token's charge, its records fall to what arrived, and the checks of the flow
that triggered the move then run on those true figures. A move whose source is
also its destination (one user on both sides of a match or a default, or a
payer who is also the payee) counts as delivered in full for an ordinary
token, because the tokens stay where they were sent.

The review rounds brought every move recorded as a payment in full under the
rule. Accepting an offer refuses a lending asset whose net principal reaches
the borrower short, as it already refused short collateral. A rental
repayment's share reaching the lender's vault, a rental day's fee, a partial
or full swap-to-repay (the lender's proceeds and the borrower's surplus), an
in-place extension, and a seller's net from either sale route are refused the
same way, so a seller always receives at least the floor they set. A rental
whose prepay token starts charging is no longer serviced day by day and
settles through the time-based default at the end of its term (the renter's
buffer then goes to the treasury, as on any rental default). A partial
liquidation leaves the loan open and records its payment to the lender as
received in full, so it is now refused when that payment lands short; the full
liquidation stays open and acts on what arrived. The periodic
auto-liquidation's payout to the lender-position holder's wallet must arrive
in full (see below); when that holder's share is frozen into the stored
lender's vault instead, the loan books what the vault received, and a short
payout leaves the period it settles open. A
failed fallback retry that restores less than it pulled lowers the loan's
recorded collateral along with the custody. The optional backstop purchase of
fallback collateral is priced on what actually reached the backstop, and its
cash to the lender must arrive in full. Every return from the backstop to the
treasury (unused capital, unused purchase cash, a resolved loan's proceeds and
a swept residue) credits the treasury with what reached it. Three of those are
forwarded by the backstop vault, which is its own upgradeable contract: until
governance upgrades it, those three still report what the vault sent.

A marketplace sale of collateral is paid by the buyer straight to each
recipient, so the protocol could not measure it from its own side. The listing
contract now does: it reads the recipient's balance before the marketplace
moves any token and again after, and refuses the whole sale unless the share
the platform records as paid arrived in full (the lender's share of a sale of
a loan's collateral, on which the loan closes as repaid, and the platform's
proceeds of a sale of an offer's collateral). The buyer's payment then never
leaves the buyer. The treasury's share, the seller's own remainder and the
seller-agreed marketplace and royalty fees record nobody as paid, so they are
not measured, and a lender buying the collateral of their own loan by filling
that listing on its own pays their own share to themselves. In a marketplace
call that combines orders (a listing matched against a bid, or a batch) the
account submitting it need not be the one paying, so there the share is
measured whoever submitted it, and a lender paying their own listing inside
such a call is refused. When one purchase covers several listings, each is
measured against its own share of the arrivals, and what one listing's
settlement pays onward is never counted as another's arrival. The record lives
only for the transaction. A fill whose first check did not run in the same
transaction is refused rather than accepted unmeasured.

Every fee into the treasury drawn from a wallet or a vault, and every
treasury share the protocol already holds from a settlement, now runs through
one small new facet, TreasuryFeeFacet, which measures what the treasury
received and records the accrual once. A wallet fee is refused unless it all
arrived; a vault fee or a held share is recorded as it arrived and never stops
a close-out. Before, twelve settlement sites (liquidation, default, claim,
swap-to-repay, the marketplace sale of an offer's collateral, the in-place
extension) pushed the treasury's share by hand and recorded the requested
figure. Where the protocol is its own treasury, a share it already holds is no
longer moved at all: the tokens are already where the treasury keeps them, so
the whole share is recorded, and a token that charges on transfer can no longer
take its fee out of the balances held for other users by a transfer from the
protocol to itself.
Moving the fee legs there is also what keeps PrecloseFacet under the contract
size limit. Two related defects were fixed on the way: a rental preclose
moved the lender's rental share into the lender's vault without recording it,
so the lender's claim could not be paid; and a rental default sent the
forfeited buffer to the treasury without recording the accrual. Deployments
must refresh TreasuryFeeFacet together with its callers; the complete refresh
and both curated refresh scripts carry it. The listing contract is upgraded
separately (it is its own upgradeable contract, not a facet), and until it is,
a marketplace sale of collateral is still settled on the amounts the order
names.

The third review round settled where a measurement can be trusted at all. A
balance is a sound measure only inside the protocol's own custody (its
contract, a user's vault, the treasury). A user's wallet can lower its own
reading while a transfer runs (a receiving hook can pass the tokens straight
on), and if the protocol booked that lower figure and left the rest owed, the
same owner could be paid again. So a reading at a wallet is now used only to
refuse: every payment to a wallet whose arrival decides what is still owed is
refused unless all of it arrived, in every flow, a forced one included. That
covers the periodic auto-liquidation's payment to the lender-position holder
and the partial swap-to-repay's surplus to the borrower. A payout that closes
an entitlement whatever arrives (a recorded claim, a user's own balance, a
liquidator's or keeper's bonus, a treasury claim, a payroll withdrawal) takes
no reading at the wallet. The round also added the sender's side: a move out
of custody that costs the sender more than it sends (a token that charges its
sender on top of the amount) is refused in every flow, because the excess
would come out of tokens held for someone else. And a lender's claim that a
close-out recorded at zero (a token that delivered nothing) now completes and
closes the position, where before it was stuck behind "nothing to claim"; a
borrower claiming first no longer settles the loan over it. The app offers
that claim too.

A new pre-deploy check reads the compiled contracts and fails on any ERC-20
move written outside the delivery library that is not listed, with the reason
it may skip the library, in an allowlist. The list is exact: a new raw move,
a second one in a listed function, or a listed one that has gone all fail.
Writing it is what found the backstop returns above. The thirty-two moves it
lists are the VPFI reward, recycling and fee paths, the cross-chain receivers,
the keeper's own contracts, the swap adapters (each attempt is measured as a
whole), the vault's two primitives behind measured callers, and owner sweeps
that record nothing.

Closes #2440. Closes #667. Closes #2623. Addresses #1281 item 011. Out of scope and
unchanged: the VPFI recycling and reward custody paths, which already measure
their own deliveries.
<!-- assembled-fragment: 2440-measured-delivery.md sha256=092d6ad86dc15ba0888bb57c4694af2febf7b554140682974b562d6b13521df1 -->
