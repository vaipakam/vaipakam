## Connected app — the offset form's default term now survives the wallet window (PR #<n>)

The "exit by becoming a lender" (offset) form pre-fills the longest
replacement term that fits before the original loan's due date. That
bound is judged by the contract to the second, at the moment the
transaction executes — but the form computed the default at the moment
the page loaded. Right after acceptance the remaining term is a whole
number of days, so the default sat exactly on the boundary, and every
second spent confirming in the wallet (or simply network lag) pushed
the replacement maturity past the due date: the transaction was
refused as "terms do not meet lender-favorability requirements" even
though the user changed nothing.

The form now reserves ten minutes of headroom when sizing the default
and maximum term, and the pre-submission recheck applies the same
margin — so the suggested term still fits by the time it lands. Near a
day boundary this can shorten the suggested term by one day; a term
that genuinely no longer fits keeps producing the existing "must end
before the due date" explanation instead of a failed transaction.
