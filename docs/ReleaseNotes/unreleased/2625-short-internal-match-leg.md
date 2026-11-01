## Internal match refuses a leg that delivers short (PR #3082)

An internal match now refuses itself when one of its legs delivers less to
the receiving lender than it sent. Only a token that charges on transfer,
outside the supported set, can do this. Until now the match went ahead and
cleared the receiving loan's debt by what actually arrived, leaving the
difference owed on that loan, even though its own collateral may already
have been used in full by the other leg. The owner decided to refuse the
match instead, so each loan falls back to its own liquidation, which pays the
lender first.

A match someone starts directly now reverts with the platform's usual
short-delivery error, naming the token and both amounts. A match the protocol
tries first inside a health-factor liquidation, a time-based default or a
fallback claim is skipped instead: it runs in its own call, so the refusal
unwinds the match alone, and a new event reports the skip with the two loans,
the token and both amounts. The loan then carries on to its own close-out in
the same transaction. Only that refusal is caught. Any other failure inside
the match still stops the whole call, as before, so a caller cannot turn a
match into a skip by starving it of gas.

Because every leg that completes has now delivered in full, the per-leg
"paid" figures the match carried for the short case are gone, and each loan's
debt clears by the amount its leg moved. The matcher's incentive is still not
measured: a charge on it falls on the matcher, who chose the match, and books
no one as paid.

The match facet gains one Diamond-internal entry for the isolated call. The
full refresh and a fresh deploy pick it up; the curated facet refresh adds it
on an older Diamond. Without it every liquidation, default or claim that found
a match candidate would revert.

Advances #2625 (item 3, owner decision 2026-10-28). Items 2 and 4 stay as
they are by the same decision.
