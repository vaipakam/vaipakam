## Thread — Treasury reserve routing and flash-loan profit measured per run (PR #<n>)

The productive treasury reserve now refuses any venue it has no route for.
Before, routing a deployment or a withdrawal was an open chain of cases with
no final refusal, so a venue value added to the setter later without a route
would have moved the books (principal recorded as deployed, an event saying
so) while the tokens never left the Diamond. Both directions now end in an
explicit refusal, which unwinds the bookkeeping with it. Closes #964.

Aave supplies and withdrawals are now measured rather than assumed. A supply
must take exactly the amount supplied from the Diamond's own balance. A
withdrawal must be reported by the pool as the amount requested, and the
treasury is credited with what actually arrived, never the request: for a
token that charges on transfer, crediting the request would have recorded a
treasury balance with nothing behind it, later paid out of other funds the
Diamond holds. A new withdrawal event states both the requested and the
received amount, so any shortfall is visible rather than silent. Setting the
Aave pool now also checks that the pool's own Aave addresses provider names
it back. That is a guard against a mistyped address or a contract that is not
an Aave pool; it is not proof a market is genuine, which remains the job of
the governance timelock's review window. The two Aave pool interface copies
in the codebase are merged into one, and an unused Lido interface is removed.
Closes #965.

The flash-loan liquidation receiver now judges each run on its own. It keeps
earned profit between runs until the owner sweeps it, and its safety check
used to compare against its whole balance, so a swap that lost money could
pass by spending that kept profit and still report a positive net profit. The
check and the reported net profit are now measured from what the receiver
held when the run began: the run must at least cover its own flash-loan fee,
and collateral left from an earlier run is neither counted as seized nor
offered to the swap. Closes #961.
