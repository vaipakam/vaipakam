### Reward expiry now settles the same way a claim does (#1434)

When a reward entry reaches the end of its claim horizon without being
claimed, the protocol reaps it and returns its value to the recycling
bucket. Working out *how much* an entry is owed at that moment is the same
question a normal claim answers — but until now the expiry path worked it
out separately, with its own arithmetic.

That separation was the problem. Three consecutive review rounds each
corrected the expiry calculation, and each correction was wrong in a new
way: it measured the raw amount owed rather than the amount actually
funded; then an amount that looked capped but was not, on precisely the
chains where it mattered; then a figure borrowed from the claim path that
covered the wrong span of days and the wrong set of limits. The arithmetic
differed every time; the shape of the mistake did not.

Expiry now asks the settlement engine for the answer instead of computing
one. The practical consequences:

- **Entries that share a daily ceiling no longer interfere.** Previously
  two expiring entries could each be measured against the whole shared
  allowance — leaving one of them permanently stuck, or letting both
  together exceed the ceiling. Each now takes its own allocated share, and
  what it consumes is recorded so the next one sees the reduced remainder.

- **Long entries no longer lose value when reaped.** An entry spanning more
  days than a single pass can price used to be closed out in full while
  only part of it was credited; the rest was simply lost to the claimant.
  An expiry now settles only the days it actually priced and carries the
  remainder forward, so a long entry is reaped across several passes with
  nothing dropped.

- **Expiry is no longer limited by a cap that does not apply to it.** An
  expired reward returns to the bucket rather than being paid out to a
  participant, so the per-loan payout ceiling was never meant to bind it —
  the same exemption forfeited rewards already have. Where that ceiling was
  exhausted, an entry could previously be closed out while none of its
  value was returned.

- **A reap still never partially credits within a day.** Where the overall
  emissions budget is nearly exhausted, an expiry waits rather than taking
  what fits and discarding the rest. A claimant asking to be paid is right
  to take what is available; someone being reaped without asking is not, and
  their own claim remains open to them throughout, so waiting costs nothing
  but time.

The claim-horizon sweep also moves onto its own internal component. It now
shares the settlement engine, and no existing component had room for it
within the per-component size limit that the platform's upgrade mechanism
imposes. Nothing changes for anyone calling it: the address and the call
itself are unchanged.
