### A direct position sale must now fit what the buyer authored — on both size and term

When a lender sells an active loan straight into a standing buy offer, the buyer
steps into the loan as it stands. Two of the checks on that step were loose, and
both let a buyer end up in a position they had not agreed to.

**Amount is now an exact match, not a floor.** The path used to accept any offer
whose amount was at least the loan's principal, fund the principal, and refund
the rest — while consuming the whole offer and burning it. A buyer who had
authored a larger, fixed amount was placed into a smaller position than they
signed for, with their offer used up and nothing left to deploy at the size they
wanted. A sale now requires the offer's amount to equal the loan's principal
exactly; an over-funded offer is refused rather than silently trimmed. This
matches how the listed sale route already builds its vehicle — at exactly the
principal — so the same position can no longer sell on different terms depending
on which route it leaves by.

**The loan's remaining term must fit within the duration the buyer authored.**
The old check was inverted: it refused an offer whose duration was *longer* than
the loan's remaining term (harmless, since a sale never changes the loan's
maturity) while admitting a *shorter* one — so a buyer who offered to lend for a
few days could be locked into a position with weeks left to run. Because a loan's
maturity is fixed at origination and a sale cannot move it, the buyer's authored
duration acts as a ceiling on how long they consent to be locked, not as the
loan's term. A sale is now refused when the remaining exposure exceeds that
ceiling, and permitted when it is shorter — the same one-directional shape
already used for the loan's inherited risk terms and treasury-fee rate, where a
better-than-authored position stays sellable. The check is measured against the
maturity timestamp rather than whole days, so a fill cannot slip up to a day past
the buyer's window.

Both refusals name their specific condition. The former over-funding refund path
is removed with the over-funding it served.

Closes #1923 (#1503 items 9 and 15). Of the four lender-sale items being closed
in place, item 5 landed earlier (#1921); item 6 remains.
