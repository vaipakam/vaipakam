## Thread — Partial liquidation no longer pulls a loan's maturity earlier (PR #<n>)

A partial liquidation re-stamps a loan's remaining term so the reduced
principal accrues from the moment of the partial. The remaining term is
tracked in whole days, and the previous logic computed it by rounding the
time left until maturity **down** to a whole number of days. Whenever a
partial happened part-way through a day — i.e. almost always — that
rounding silently dropped the sub-day remainder and moved the loan's
maturity *earlier*. A partial twelve hours into a thirty-day loan, for
example, re-stamped the term to twenty-nine days, maturing the loan about
twelve hours ahead of schedule, and repeated partials compounded the
shortening. An earlier maturity exposed the borrower to the default and
late-fee windows sooner than their agreed term and quietly clipped the
lender's coupon window — contradicting the documented intent that a
partial preserves the loan's maturity.

The remaining term is now rounded **up** instead. The re-stamped maturity
equals the original maturity rounded up to the next whole day, so it is
never earlier than the agreed end date — at most about one day later,
which favours the borrower — and successive partials stay monotonic (the
maturity only ever holds or grows). The interest-clock restart on the
reduced principal is unchanged. Because the whole-day granularity can no
longer represent a sub-day remainder by shortening, the prior "remaining
days rounded to zero on a last-sub-day partial" edge case no longer
arises: a partial while the loan is still in term always leaves at least
one whole day of remaining term.

Closes #641. Surfaced during the #395 partial-liquidation sizing review
but independent of that work. A precise sub-day `endTime` field on the
loan was considered the "correct" alternative but would have required a
storage-layout change for a sub-one-day correction; the round-up keeps the
clean "restart the clock at now" semantics and satisfies the invariant
that a borrower-favourable partial never shortens the term.
