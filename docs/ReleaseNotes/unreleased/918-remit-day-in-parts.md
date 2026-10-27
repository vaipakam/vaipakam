## Rewards — A day's reward budget may be sent to a mirror in parts (PR #2959)

Until now a day's reward budget left Base for a mirror in one transfer, so a
day whose slice was larger than the cross-chain lane could carry could never be
sent: the keeper skipped it with a warning, and the only remedy was to raise the
lane. Following the owner's "send in parts" decision, Base now sends such a day
in several parts. It fixes the day's whole slice, fresh and recycled, when the
first part goes, records every later part against that same whole, and marks the
day remitted only once the parts add up to it. Each part reserves and records
exactly its own value; the amount a day's commitments clamp away is retired
once, with the first part. Every part is checked against what the day still
owes, not against the part alone, so a part goes only when the rest of the day
sent at once would, and no day is started on room it does not fit. Releasing
an undeliverable part restores exactly that part and leaves the day owing it
again. The quotes and planning views now take the same
part size the send uses, so the quote always matches the send, and a new status
reports a day whose part leaves it still owing. The manual-budget path refuses a
day that has already been partly sent.

On the mirror, a day now opens for claims only when every part has landed: each
delivery states the day's whole, and the mirror adds up the parts it receives,
fresh and recycled separately, opening the day only when both reach the whole.
Parts may land in any order and a part delivered twice counts once. The rooted
remittance wire moves to a new generation that carries these figures; the old
shape is refused, and the ingress entry point was renamed accordingly. This is
fresh-deploy only (owner decision O1 = A): no migration, and the retired
one-packet proof record keeps its storage place unused.

The keeper sizes each part to the smaller of its configured ceiling and the
lane's live capacity, sends one part per tick, and keeps reporting the mirror as
not yet covered until the day is whole. `ConfigureCcip` refuses a lane smaller
than the largest fresh day slice the schedule can owe, and the launch-readiness
lane check now says when a lane is below it. A day with only a recycled portion
is still not held on the mirror. Closes #918.
