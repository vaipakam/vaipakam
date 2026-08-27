# Forfeited loan-initiation VPFI: the matcher's share is now stated

**Task:** #1980

Two places in the public documentation said that when a loan on the retired
VPFI fee path defaults or is liquidated, the VPFI held against its initiation
fee is forfeited **to treasury**. That is not where all of it goes. On a loan
that a matcher created, the matcher receives its configured share of that
amount first, and only the remainder reaches treasury. The share defaults to
1% and is governance-tunable up to a hard ceiling, so the omission was not a
rounding detail.

Both statements now describe the split. Nothing about the platform's behaviour
changed — this corrects what the documents claimed it was.

The correction is also an internal-consistency fix rather than a new
disclosure. The matcher's share of the loan-initiation fee flow was already
described in the whitepaper's participant and matching sections, and the
Advanced user guide already worded the illiquid-default case correctly. The
same guide then contradicted itself a few hundred lines later, which is the
sentence this changes.

Still outstanding on the card, and deliberately not folded in here: the nine
non-English user guides carry the same claim in the illiquid-default passage
and need the same correction, and a separate question about whether the fee
discount is time-weighted or point-in-time is filed as its own issue.
