## Thread — owed VPFI leaves the wrong wallet's fee tier on every close-out (PR #TBD)

When a loan closes, what each side is owed — the lender's proceeds, the
borrower's returned collateral or surplus — waits in the original party's vault
until the current holder of that side's position NFT claims it. If the position
has changed hands, that VPFI sits in one wallet's balance while belonging to
another, and the VPFI fee-discount tier is worked out from the balance. Until
now only the swap-to-repay full close-out kept such VPFI out of the vault
owner's tier. Repayment, preclose, default and the liquidation paths did not,
so a party who no longer held the position kept tier credit on VPFI that was
not theirs — indefinitely when the holder was sanctioned and could not claim.

The platform now applies one rule to every close-out and to both sides: once a
loan has closed, the VPFI the platform is holding in reserve for a side's
position holder is excluded from the vault owner's tier whenever someone else
holds that position. The rule is checked when the loan closes, whenever the
position changes hands afterwards (selling an unclaimed position moves the VPFI
out of the seller's tier; selling it back returns it), and whenever the
reserved amount changes. At claim the exclusion is lifted before the VPFI
leaves the vault, so the vault owner's tier never dips below what they own.
Sanctions are no longer part of the test — the VPFI belongs to the holder
whether or not the holder can claim yet. The excluded amount is readable per
loan and per vault owner. Loans that were frozen under the old swap-to-repay
rule carry over without being counted twice.

Scope and trade-offs: live loans are unchanged. Whether tier credit on a
transferred position should move to the holder before the loan closes is an
open product decision, so a live loan's collateral keeps counting toward the
original party until the position is consolidated. A tier change made at close
or on a position sale is recorded locally at once and reaches other chains
with the vault owner's next ordinary balance change, because a cross-chain
update inside a close-out could fail and block it. Closes #2342.
