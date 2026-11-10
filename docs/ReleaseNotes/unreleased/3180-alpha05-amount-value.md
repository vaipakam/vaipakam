## Thread — alpha05 shows an amount's value now (PR #3477)

The new app's borrow and lend forms now show, under each typed amount, what
the protocol values it at right now, in the protocol's own numeraire. The
figure comes from the protocol's own valuation, by the same rule it uses for
loan-to-value: a principal is rounded up, collateral rounded down. It is read
once typing pauses, not on every keystroke.

The line never shows a figure the protocol would not stand behind. For an
asset the protocol gives no price, it says the protocol values it at nothing.
When the protocol's price sources disagree, it says that is why no value is
shown. A value that could not be read is said to be unread, not shown as zero.

The take-an-offer review, for a borrower and for a lender, now states the
principal's and the collateral's value now in the same words. These rows are
informational and never binding, since the price moves after signing.

The line is one shared component, so later routes (Vault, Claims) can carry
it with the same rule and wording.

Closes #3225. Advances #3180.
