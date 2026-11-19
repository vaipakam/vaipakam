## Thread — Early close with a sanctioned stored lender: confirmed fixed and now tested (branch, no PR yet)

#1124 recorded that a sanctions flag on a loan's stored lender would block the borrower's direct early close, because the lender's vault was looked up through the sanctions-screened route. The fix waited for room in the preclose facet.

Both legs have since been fixed without that wait. #3178 resolves the lender's vault as a receiver on the token-loan payoff, and the rental prepay shares go through a separate close-out host. The preclose facet was also split in #3410, so it now has room to spare. This change adds tests that close a token loan and an NFT rental early while the stored lender is flagged, and removes the code comments that still described the old gap. The payoff lands in the lender's own vault, behind the usual claim screen.

Closes #1124.
