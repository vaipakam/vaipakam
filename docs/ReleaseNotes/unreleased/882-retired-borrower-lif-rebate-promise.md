## The public pages no longer promise borrowers a rebate that cannot arrive (#882)

The whitepaper and the user guides told borrowers that their Loan Initiation Fee
discount arrives as a **VPFI rebate paid when they claim** — that the full fee is
taken in VPFI up front, held for the life of the loan, and partly returned at
settlement.

That stopped being true when the fee model changed. A loan opened today has the
discount applied **directly to the fee it pays in the lending asset**, at the
moment the loan is accepted. No VPFI is taken to pay it, nothing is held, and
there is no rebate. A borrower reading the old pages would have been waiting for
money that could never arrive — and would have had no way to discover that from
the pages themselves.

Every public page now says what actually happens, and says it in the same place
the old promise stood: the discount is a direct reduction, no VPFI leaves the
vault to pay the fee, and there is nothing to claim afterwards.

**The old mechanism is scoped, not deleted.** Loans opened while it was live
still settle exactly that way, and their rebates remain claimable. The pages now
mark those passages as describing those loans, so a reader can tell which
paragraphs apply to them. Deleting the description outright would have stranded
the people it still applies to.

**One thing deliberately not over-corrected.** Where the optional per-party
tariff is enabled, VPFI genuinely does leave the borrower's vault at origination.
The correction says so rather than flattening everything into "no VPFI ever
moves", and states the three things that make the tariff different from the
retired path: it is an *additional* fee rather than a substitute, it is not
refundable and is not a rebate, and it is opt-in with a cap the borrower
authorises up front.

**All ten languages moved together**, which was the point rather than a detail. A
partial sweep would leave some readers told the rebate is gone while others are
still promised it — worse than a uniformly stale set, because it makes the
correct pages look like the mistaken ones. Finding every instance meant searching
for the *idea* in each language rather than the English word: three locales carry
the promise as `ردّ VPFI`, `reembolso de VPFI` and `rabais VPFI`, and one of them
also spells it a second way in the same file. An English-only search finds none of
those.

**Known limitation, stated rather than left to be discovered.** The correction is
placed where each page introduces the fee discount, and the settlement passages
deeper in the guides are marked as describing loans on the retired path. Those
deeper passages remain individually unqualified, so a reader arriving directly at
one of them — the guides use anchor links — may read it without the surrounding
scope. They are not false (they describe what happens to a rebate that exists),
but they are not self-contained either, and closing that gap is follow-up work.

The application itself needed no change: it reads each loan's actual held amount
and shows a rebate only where one exists, which was already correct for both old
and new loans. The documentation was the only thing making a promise.
