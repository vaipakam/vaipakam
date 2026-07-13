### Rental loans no longer default early or brick their own repayment (Pass-2 D1, #1188)

An NFT rental amortises by consuming one prepaid day at a time. Previously each
daily deduction (and each multi-day rental partial-payment) shrank the loan's
term counter while its start date stayed put, so the platform computed the
rental's maturity — and its grace window — a little earlier every day. On the
designed daily cadence a 7-day rental could be pushed "past due" and
permissionlessly defaulted around day 4 (forfeiting the borrower's remaining
prepayment and full buffer to the treasury), and a borrower trying to close a
fully-funded, fully-serviced rental in-term was first charged a late fee and then
blocked entirely with a "past grace period" error.

The fix fixes the rental's maturity and grace window at origination and never
moves them. Days consumed are tracked separately, so amortisation no longer
pulls the deadline forward. Concretely: a mid-serviced rental can no longer be
defaulted before its original end-of-term plus grace, and the borrower can always
close a fully-serviced rental in-term. The renter also keeps the NFT for the full
agreed term rather than losing access early (the ERC-4907 expiry no longer
shrinks — resolving the manifestation tracked as #893). Rental economics are
unchanged: the same daily fee, buffer, and refunds apply; only the maturity/grace
accounting is corrected. Non-rental loans are unaffected.
