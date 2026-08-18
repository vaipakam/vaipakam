## Lender sale — the instant route now refuses a loan with a live offset (PR #TBD)

A borrower who has started a Preclose Option-3 offset has a close-out in
flight that pays whoever holds the lender position when it completes. The
listing route has long refused to put that position up for sale while such an
offset is outstanding, because a sale is a *second settlement* of a loan that
already has one running, and the two would race. The instant route — selling
straight into a standing lender offer — never had that refusal, so the same
loan could be sold out from under a live offset in a single transaction.

Worth being precise about what is and is not restricted, because it is easy to
state too broadly. A lender who simply transfers their position NFT to another
wallet is unaffected: the offset holds only the borrower's position, and
completion pays whoever holds the lender side at that moment. Ownership moving
is safe. What is refused is starting a second settlement while one is pending.

It now refuses, with the same error the listing route uses, so a caller sees
identical revert data whichever route turned them away. The remedy is unchanged
and unchanged in cost: cancel or complete the offset first, which is short-lived
by design, then sell.

The instant route is the sharper case, which is why this is worth calling out
rather than filing as a consistency tidy-up. A listing sits in public for a
window during which the borrower, the seller, or a keeper can notice the
conflict and act; the instant route migrates the lender inside one transaction,
so there is no interval in which anyone could intervene.

Worth recording why the gap survived review for as long as it did. The instant
route already carried a check one line away that reads almost identically and
uses the same family of storage — but it asks whether the *offer being consumed*
is itself an offset vehicle, not whether the *loan being sold* has an offset on
it. Opposite subject, near-identical shape. Every other operation of this class
— starting a second offset, listing a prepay, listing the position for sale —
already guarded the loan side; this was the one that did not.

The other half of the tracked item is not addressed here: an active *refinance*
offer should arguably block a sale on the same reasoning, but refinance offers
are not indexed by loan, so there is nothing to consult. That needs an index
before it can be a guard, and is left as follow-up rather than half-built.

Part of #1503 (item 21).
