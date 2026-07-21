## Thread — A sold lender position keeps the fee discount it paid for, on automated loan extensions (PR #<n>)

Follows #1383 and #1391. This closes the last settlement path where the lender
fee discount was not honored: the automated loan-extension flow.

The problem was specific and unfair to the lender. A lender can pay an upfront
tariff to buy a standing discount on the fee taken out of their interest. If that
lender later **sold their position** to someone else, the automated extension
flow stopped applying the discount at all — so the benefit that had been paid for
simply evaporated the moment the position changed hands, and the treasury quietly
took the undiscounted cut instead.

The skip was not arbitrary. The older discount machinery always charged the
*originally recorded* lender internally, so applying it after a sale would have
billed the seller for interest the buyer was receiving. Refusing to apply it was
the safe choice available at the time.

That constraint no longer exists: the discount can now be resolved for an
explicitly named party. So instead of opting out after a sale, the flow now
resolves the discount for **whoever currently holds the lender position** — the
same party the interest is actually paid to. The original concern is addressed
properly rather than avoided:

- The portion of the discount bought by the upfront tariff belongs to the loan,
  not to a person, so it survives a sale intact.
- The portion earned by holding tokens is read live for whoever holds the
  position now, so the new holder's own standing applies — not the seller's.
- If the fee is to be settled in tokens from a vault, that is still gated on the
  current holder's own recorded opt-in. A holder who never opted in is never
  charged; they receive the benefit through the route that moves no tokens.

Two side effects of the change: discounts applied on this path now emit the same
analytics record every other settlement path emits, so reporting no longer has a
blind spot here; and the contract itself got noticeably smaller, since the
discount logic is now shared rather than duplicated.

Ships **dark**: no loan carries a paid lender stamp until the fee-entitlement
cut-over, so every current extension settles exactly as it did before — now also
including the opt-in holding discount this path formerly ignored on transferred
positions.

Closes #1392. Umbrella: #1349.
