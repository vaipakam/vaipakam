## Thread — a lost internal match on the close-out card now ends in a sale (PR #2671)

When an overdue loan can be settled against an opposing position, the
lender's close-out card sends that settlement. The opposing position is
another loan anyone can act on, so it can be taken between the card's read
and the transaction running. For a loan whose collateral would otherwise be
sold, the protocol then moves on to the sale, and the card used to send no
sale route, so losing that race refused the close-out and cost the lender the
network fee. The card now asks the exchanges for a price on confirm, exactly
as it does for a sale, and sends those routes with the settlement. A lost
match therefore ends in a sale, or in the protocol's fallback if every route
fails at that moment. Where no price can be found, the settlement is still
sent without a route, and the card says beforehand that a lost match would
then fail for the fee alone. The card's race paragraph now names those
endings and the incentive a sale may pay its submitter instead of the matcher
one. The keeper's default pass already sent a quoted route on this route.

The issue also described a second hazard: a close-out ending a loan whose
lender position had just been sold, stranding the buyer's payment. The
current contracts already rule this out. A sale's acceptance completes it in
the same transaction, and a sale cannot be accepted from the loan's maturity
on, while a close-out is possible only after the grace period, so the two
cannot meet. Existing contract tests pin both halves. The card's own sale
check stays, as the rule it shares with the keeper, and the comments and
functional spec that said the protocol does not keep the two apart are
corrected.

Closes #2078.
