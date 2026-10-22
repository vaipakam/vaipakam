## Thread — an NFT rental repaid in grace no longer reverts (PR #<n>)

An NFT rental repaid after its maturity but inside the grace period could
revert with an insufficient-prepayment error, leaving default as the only way
out. The repayment billed every day elapsed since the rental started that the
daily deduction had not yet collected, including the days past maturity, so a
rental whose daily deductions had not run kept accruing rent beyond the term
its prepayment funds. Once that rent plus the late fee passed the prepayment
and buffer, the close-out failed and the borrower lost the buffer to the
default path.

Rent is now never billed past the agreed term. A rental closed after maturity
owes at most its remaining prepaid days, which is its whole remaining
prepayment, and the time past maturity is charged only as the late fee, drawn
from the buffer as before. The owed days are counted by one shared rule, which
both the repayment and the handover of a rental to a replacement borrower now
use; the handover already capped at the term, so its figures do not change. In
term, nothing changes: a rental closed before maturity owes the days elapsed
since the last deduction. The lender receives the full remaining rent plus the
late fee, less the treasury share, where the reverted repayment used to push
the loan into default.

The repayment quote view no longer carries an unused copy of the rent
calculation; for a rental it still returns the late fee alone, since the rent
is drawn from the borrower's vaulted prepayment and not from the wallet.

Closes #901.
