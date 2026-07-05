## Thread — operators can pause new-position flows without a code change

The retail app gained a write-path kill switch: by setting one deploy
variable, the operators can switch off posting offers, accepting
offers, listing NFTs, renting NFTs, or depositing VPFI — individually
or all at once — while an incident or suspected bug is investigated.
A switched-off flow explains itself with a banner in plain words and
reassures the user that everything already theirs is unaffected.

The switch is deliberately one-sided: only flows that OPEN a new
position can be paused. Repayments, claims, and withdrawals are
structurally outside the switch's reach — an operator precaution must
never be able to trap funds or make a borrower miss a deadline. This
mirrors the same tier principle the sanctions gate follows: entry
paths can close, exit paths stay open.
