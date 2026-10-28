# Batch actions on offer-grouped loans (#126)

**Status:** slice 1 merged or in review, slice 2 in review (sender decided: Diamond multicall). Issue: #126.

## Decision

No batch facet (owner decision 2026-10-28, recorded on #126). Each loan
keeps its own checks and can fail on its own.

**The calls go through the Diamond's own multicall** (owner decision
2026-10-28). The decision on #126 first named an EIP-5792 wallet batch
where the wallet supports one, and one transaction per loan otherwise.
While building slice 1 a closer fit turned up: the Diamond already has
`MulticallFacet.multicall`, which Claim all (#1268) uses, and it meets the
same requirements without the wallet's help. The choice was put back to
the owner, who chose the multicall. The later slices use it too.

Why the multicall fits better here:

- **Every wallet, one prompt.** It is an ordinary Diamond call, so any
  EOA gets one transaction for up to 30 loans. EIP-5792 support is
  uneven, and where it is missing the fallback is one prompt per loan.
- **No atomicity surprise.** Each item runs with `allowFailure` set, so a
  loan whose call reverts at execution rolls back only its own frame and
  the others still close. An EIP-5792 batch is often atomic (a smart
  account usually runs it that way), so one late revert would undo every
  loan, including the approval in it.
- **Same identity, same checks.** Each item is a delegatecall into the
  Diamond itself, so it runs as the borrower, through the same facet code
  and the same per-call checks (position NFT holder, grace, sanctions,
  pause) as a direct call. It grants nothing a direct call does not. The
  facet rejects nesting and caps a batch at 30 calls.
- **No new wallet prompts.** EIP-5792 in MetaMask can ask to upgrade the
  account (EIP-7702) before the first batch, which is a larger decision
  than closing loans.
- **Already gated.** The app's Terms gate already classifies a multicall
  by the calls inside it, so a batch of exits is an exit.

This leaves the lean in `VaultUpgradeBundlingDesign.md` ("why not batch
at the wallet layer") where it was: that bundle had to be atomic; this one
must not be.

## What a group is

Loans group by the offer they came from (the loan's `offerId`). One offer
can fill into several loans, possibly with different counterparties, so a
group is the connected wallet's own borrower positions only, still
active, ERC-20 principal, and only where two or more remain. A borrower
in loan #3 never acts on loan #1 because both came from one offer; the
contract enforces that per call anyway, and the app does not offer it.
Rentals are not grouped.

## The one rule that makes a batch safe: one per-loan plan

The loan page (PositionDetails) runs a long list of live checks before it
lets a borrower repay or close early. A batch that restated them would be
a second copy of the rule, and the copies would drift: the page collected
one review round per missing re-check (sale acceptance, refinance request,
offset lock, grace on the live term, position NFT still held).

So slice 1 moves them into **one per-loan plan builder**,
`apps/app/src/data/closeOutPlan.ts`. Given a loan and an action it reads
the chain and returns either the call and the token pull it needs (what
the contract takes now, and the padded figure to balance-check and
approve), or the reason the loan cannot take the action now. The page's
two handlers and the batch both call it.

Two page behaviours change, both toward the chain:

- The day-boundary pad is computed from the **live** principal and rate,
  not the indexed row's. A partial repayment or a refinance moves both.
- Early close now reads the **offset lock** live before signing. It used
  to rely on the page's own cached offset card.

## A batch carries only loans with nothing to disclose

Where the loan page would stop to show the borrower something before
they confirm, the batch leaves the loan out and says to close it from its
own page:

- an accepted sale waiting to complete (closing would strand the buyer);
- an open refinance request, or a search for one that could not answer;
- an open offset offer;
- a loan in its fallback period (repaying it is a cure, with its own
  explanation);
- a rental.

A loan whose checks could not be read is left out with that reason too.

What the loan page states without stopping is stated in the batch review
instead, under each loan: for an early close, the loan's interest rule,
the late fee when past due, and a paid Full tariff that is not refunded.
The plan carries those as the loan's notes, built by one function from
the plan's own facts and the loan's fee entitlement record (the same read
the loan page uses, `readFeeEntitlement`). An unreadable record leaves the
loan out, as the page holds its early close until the record is known.
The review is the six-row receipt every write shows, worded for several
loans.

## Sending

1. Plan every loan. Show the review: per-loan amounts, loans left out, the
   total, and the approval the batch asks for, stated as including a pad
   for the amount rising before the transaction runs.
2. Check the wallet holds the padded total, then approve it once per
   token (one lending asset per offer, so one approval in practice),
   through the same `ensureAllowance` / `trackApproval` machinery the
   single-loan flow uses.
3. For each chunk of up to 30 loans, immediately before sending it, plan
   every loan in it again in full: the late check is the plan, not a
   subset of it. A sale acceptance, refinance request or offset can land
   while the wallet waits on the approval or on the previous chunk, and
   the position NFT can move; `repayLoan` is permissionless, so without
   the re-check the wallet would pay for a position it no longer holds. A
   loan that now refuses is moved to "left out".
4. Send that chunk's `multicall` through `useDiamondWrite`, the one
   chokepoint for Diamond writes (Terms gate, receipt check).

## Outcomes are read back, never assumed

The multicall's receipt says the transaction mined; it does not say which
items ran. After each transaction every loan is read back **at the block
it mined in**, so a node that has not caught up answers "unknown" instead
of "still open":

- **closed** only when the loan reads `Repaid`, the status both calls
  leave;
- **changed** when it left Active some other way (a default or
  liquidation landed first). It is never reported as this batch's close;
- **still open**, with the reason the call would fail now, simulated at
  the same block, or a note that it was skipped and can be closed from
  its page if the simulation passes;
- **unknown** when the read fails.

If the write throws, what the transaction did is settled before any loan
is called open (`settleFailedSend`). Never signed: a failure. Settled by
the receipt wait as not run (reverted, or cancelled or replaced in the
wallet): a failure. Otherwise its hash is looked up.
Mined and successful, it is read back at its block like any other; mined
and reverted, a failure; not found (still pending after the receipt wait
gave up, or replaced under another hash), every loan it carried that
still reads Active is **pending**, never open. A pending transaction may
yet spend the approval, so no further chunk is sent behind it (those loans
are named as not sent) and the approval is not unwound. The stop is keyed
on the send's own state, not on its loans' outcomes, so a pending send
whose loans could not be read back still stops the batch.

**Approvals.** The approval is set back, through the same unwind as the
single-loan flow, only when it is established that no loan closed: an
unreadable outcome may be a close that spent part of it. The unwind
leaves alone an allowance it did not write, so its success says nothing
about the figure. Whatever happened, the allowance that remains is read
from the chain afterwards and stated, with where to lower it (the unused
pad, and the share of any loan that stayed open). The single-loan flow
leaves its pad as allowance too; the batch says so because its remainder
can be larger. That read is taken from a node that has reached the last
block any of the flow's own writes mined in (the approval, each batch, the
restore), pinned to that node's head; when none answers from that far the
figure is reported as unread, never a stale one from before those writes.

**The card outlives its group.** A batch that closes loans can leave the
offer with fewer than two open loans, which drops the group from the
page's list. The page holds a card from the moment its batch starts until
its results are dismissed, rendering the group as it was when the batch
began. The cards also render outside the page's loading and
unavailable states, so a failed read of the positions lists does not
unmount one either; while the lists cannot be read, only the held cards
show.

## Slices

1. **Plan builder + borrower close-outs.** The plan builder,
   the shared multicall encoding (Claim all now uses it too), and on the
   Positions page a card per group with "Repay all" and, in Advanced mode
   like the loan page's own early close, "Close all early".
2. **Lender: list all for sale.** One bound listing
   (`createLoanSaleOfferBound`) per loan with the same rate and window
   (each carries its own mandatory expiry). See below.
3. **Borrower: refinance all.** One replacement borrower offer per loan
   with the same terms.

Partial repayment across a group needs a rule for splitting one amount
over several loans; that is a product question, so it is not in these
slices. Liquidation stays a keeper concern, as the issue says.

## Slice 2: list all for sale

The lender's positions from one offer, listed for sale together at one
rate and one listing window. It follows the slice-1 rules with three
differences that come from the listing itself.

**One per-loan listing plan.** The listing form on the loan page
(`LoanSaleFlow`) ran its pre-sign checks inline: the sanctions screen,
the lender position still held, both assets unpaused, the loan Active,
not matured and with at least the minimum listing window left, and a
simulation of the exact bound listing (which catches the relisting
pause, an open offset, an existing listing, a position that cannot be
consolidated, and figures that no longer hold). Those move into
`apps/app/src/data/saleListingPlan.ts`, which the form and the batch
both call. The batch planner adds what the review needs: the figures
quoted for the loan (`readSellerBoundsQuote`, the same read the form
uses), today's settlement, and the loan's own statements (a Full fee
mode travels to the buyer; a rate above the loan's own costs the
seller the difference). The fee record is read for that statement, and
an unreadable one leaves the loan out, as the loan page holds its sale
tools until it is read.

**Bound to the reviewed figures, no approval.** Each listing is sent
bound to the minimum and held ceiling the lender reviewed (#1810), so
the chain refuses a listing that would record worse ones; a listing
draws nothing from the wallet and sets no approval (#2674). The late
re-check before each transaction plans every loan again against the
REVIEWED figures, not a new quote, and leaves out a loan whose
statements changed since the review. A loan refused because its
figures moved is named with that reason.

**Listed is read from the transaction's own logs.** Each listing emits
`LoanSaleOfferLinked(loanId, saleOfferId)`, and a multicall item that
reverts has its logs rolled back with it, so the mined transaction's
logs say exactly which loans it listed. A later read of the position
lock could not tell this batch's listing from one made elsewhere in
between. The receipt's logs are therefore carried with a mined send,
including one recovered by `settleFailedSend`. A loan not in the logs
is read at the transaction's block (no longer Active, or still Active
with the simulated reason). Every loan behind a pending send is pending,
read or not: a listing leaves the loan's status as it was, so a loan no
longer Active may have been listed by that send before it was repaid or
liquidated, and only the send's logs can say.
Each listed loan's offer id is written to the loan page's listing
marker, so its page can offer cancel straight away.

The card shows only in Advanced mode, the same as the loan page's form.
On a network where the listing route is not live
(`loanSaleListingEnabled`) the card still shows for an eligible group and
says listing is not available on this network, as the loan page's
chooser does, rather than vanishing as if the positions were not
eligible. A group is the wallet's lender rows, which are the
positions it holds. The batch respects the post-offer kill switch and
the Terms gate, and the consent (recorded on each listing) is one tick
covering every loan in the review, cleared whenever the review changes.

## Tests

Unit: the plan builder's refusals one case each, the pad on the live
term, a failed read becoming that loan's refusal; grouping exclusions and
per-token totals; the shared multicall encoding and chunking. Slice 2:
the listing plan's refusals, the reviewed figures kept on the late
re-check, a changed statement leaving a loan out, and the read-back
(listed only from the logs, pending never read as not listed). CI-Anvil (a
borrower with two loans from one offer closes both with "Repay all") is
listed as a gap in `apps/app/e2e/COVERAGE.md` and follows in its own PR.
