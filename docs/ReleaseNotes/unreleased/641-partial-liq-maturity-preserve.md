## Thread — Partial liquidation no longer accelerates a loan's default deadline (PR #<n>)

A partial liquidation re-stamps a loan's term so the reduced principal
accrues interest from the moment of the partial. The loan's term is
stored as a whole-day duration, and that one value was overloaded for
three jobs at once: the maturity date, the grace window that follows
maturity, and the interest-accrual clock. The old logic recomputed the
remaining duration by rounding the time left until maturity **down** to
whole days. Two things went wrong as a result.

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
late-fee windows and clipped the lender's coupon window.

The fix:

- **Maturity** — the remaining term is now rounded **up** to whole days,
  with the accrual clock kept at the partial's timestamp. The re-stamped
  maturity is the original maturity rounded up to the next whole day:
  never earlier than the agreed end date (the actual harm), at most about
  a day later (borrower-favourable), and never compounding earlier across
  repeated partials. Keeping the accrual clock at the partial's moment
  means the reduced principal never pre-accrues interest from before the
  partial.
- **Grace** — the grace window is now sized from the loan's **original
  committed duration**, snapshotted once at origination (and re-snapshotted
  when a loan is genuinely re-termed by an offset or refinance), so
  reducing the live remaining duration during a partial can no longer
  collapse the grace bucket. Every grace gate now reads this — not just
  direct repayment and time-based default, but also the swap-to-repay,
  intent swap-to-repay, and collateral-listing recovery paths — so a
  partially-liquidated borrower keeps the full grace window on all of
  them. Partial repayment, which shares the same re-stamp pattern,
  inherits the grace-preservation fix.

The interest clock still restarts on the reduced principal at the
partial's timestamp, exactly as before; the pre-partial interest was
already settled interest-first from the swap proceeds.

Closes #641. Surfaced during the #395 partial-liquidation sizing review
and deepened by the Codex review, which showed the maturity rounding was
only half the problem — the grace-tier collapse was the load-bearing
defect, and it had to be honoured on every recovery path, not just the
default path. A new `originalDurationDays` field on the loan carries the
immutable committed term; loans that predate the field (none in
production — the platform is pre-live) have it seeded from the live term
before the first duration shrink. The loan-detail ABI gains the new
field; frontend and keeper ABI bundles are re-exported in the same
change.
