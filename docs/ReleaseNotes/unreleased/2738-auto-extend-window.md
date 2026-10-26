## Thread — An in-place extension happens only near maturity and never shortens grace

An in-place loan extension re-terms a loan: it settles the interest so far,
restarts the loan's clock and moves its rate within both parties' limits. The
contract accepted one as soon as a day had passed since the loan started, so
the keeper could re-term a loan with both parties' limits set as early as day
two (#2738). It also checked only that the new end was later than the old
one, so a short new term that earns a smaller grace period could make the loan
defaultable sooner than before, taking grace time from the borrower.

The contract now states both rules once. An extension is accepted only inside
the loan's extension window, which opens three days before its effective
maturity (never within its first day) and closes at its grace end; a pause
moves the window with the loan's other deadlines. And an extension must leave
the loan defaultable no sooner than it is now: the new end plus the grace the
new term earns must not fall before the current grace end. The window binds
every caller, not just the keeper, and a new read gives each active loan's
window so the keeper reads it instead of computing its own. Fresh deploy only,
as for the rest of this pre-live work.

Closes #2738.
