## Thread — Partial liquidation no longer accelerates a loan's default deadline (PR #<n>)

A partial liquidation re-stamps a loan's term so the reduced principal
accrues interest from the moment of the partial. The loan's term is
stored as a whole-day duration, and that one value was overloaded for
three jobs at once: the maturity date, the grace window that follows
maturity, and the interest-accrual clock. The old logic reset the clock
to "now" and recomputed the remaining duration by rounding the time left
until maturity **down** to whole days. Two things went wrong as a result.

First, rounding the remainder down dropped the sub-day portion and moved
the loan's maturity *earlier* — a partial twelve hours into a thirty-day
loan matured the loan about twelve hours ahead of schedule, and repeated
partials compounded the shortening. Second, and more seriously, shrinking
the stored duration also shrank the **grace period**, which is sized by
tiers of the loan's duration. A deep or late partial could drop the live
duration into a much smaller grace tier — for example a ninety-day loan's
three-day grace collapsing toward the sub-seven-day, one-hour tier — so
the borrower could be declared in default far sooner than their agreed
term. Both effects accelerated the borrower's exposure to the default and
late-fee windows and quietly clipped the lender's coupon window.

The fix decouples the three jobs. The maturity is now preserved exactly:
the remaining term is rounded up to whole days and the accrual clock's
start is back-dated so the term still lands on the original end date to
the second — never earlier, and with no drift in either direction across
repeated partials. The grace window is now sized from the loan's
**original committed duration**, snapshotted once at origination (and
re-snapshotted when a loan is genuinely re-termed by an offset or
refinance), so reducing the live remaining duration during a partial can
no longer collapse the grace bucket. The interest clock still restarts on
the reduced principal, exactly as before; the pre-partial interest was
already settled interest-first from the swap proceeds. Partial repayment,
which shares the same re-stamp pattern, inherits the grace-preservation
fix for free.

Closes #641. Surfaced during the #395 partial-liquidation sizing review
and deepened by the Codex review of the first fix, which showed the
maturity rounding was only half the problem — the grace-tier collapse was
the load-bearing defect. A new `originalDurationDays` field on the loan
carries the immutable committed term; existing loans (none in production —
the platform is pre-live) fall back to the live duration. The loan-detail
ABI gains the new field; frontend and keeper ABI bundles are re-exported
in the same change.
