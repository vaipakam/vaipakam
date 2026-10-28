## Thread — One cadence admission rule, and a preview of it (PR #3020)

Offer creation refused every offer longer than a year that asked for no
periodic interest, even where the specification accepts one: with periodic
interest switched off (when no cadence at all would have been admitted, since
the switch also refuses the annual one) and when either leg is illiquid (when
only "none" is allowed). The mandatory annual checkpoint on multi-year loans
now binds only while the feature is on and both legs are liquid ERC-20, which
is what the specification says. Nothing reached this before, because the
offer-duration cap still defaults to one year.

The fix is a single admission rule that offer creation, the amount re-check
on offer modification and a new preview all read, instead of a copy in each
facet. Modification now applies the whole rule to a changed amount, against
the liquidity classes the offer recorded at creation: so with the switch
turned off after an offer was posted with a finer cadence, a change to that
offer's amount is refused, as a fresh offer on the same terms would be. The
offer can still be cancelled and posted again.

The preview takes proposed offer terms and returns, for every cadence,
whether creation would admit it and, if not, the exact error creation would
raise, along with what the rule read: the feature switch, both legs'
liquidity classes, whether the annual floor binds, the principal's value and
the threshold it is compared with. It covers the cadence rule only; an offer
refused for another reason is refused whatever the preview says. Closes #3009
and gives the app's cadence picker (#2524) its source.

> Caveat: liquidity is classified live, so a preview can differ from the
> answer creation gives if the oracle, the switch or the threshold changes in
> between.
