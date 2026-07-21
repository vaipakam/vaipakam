## Thread — Groundwork for the per-user daily reward cap (PR #<n>)

First slice of the new daily reward cap. It lays the foundation only: the
bookkeeping the cap will need, an admin knob to set its size, and the step at
day-close that records what that day's ceiling is. Nothing pays out differently
yet — no day uses the new cap until the reward cutover is switched on, which
remains blocked until the rest of the pieces are in place.

**What the cap will do, once live.** Today a day's reward budget is limited by a
rule tied to the price of ETH. That is being replaced by a straightforward
ceiling: on any one day, a single participant can take at most a set share of
that day's budget for their side of the market — a default of 20%, adjustable
between 0.5% and 50%. The point is to stop one very large participant absorbing
most of a day's rewards.

**Why it needs a durable record of what has already been paid.** A participant
may have several loans that finish at different times. If each one asked "how
much of today's ceiling is left?" without a shared record, each would see the
full ceiling and they would collectively blow past it. So the amount already
paid out for a given person, side, and day is written down permanently, and
counts payouts to the participant *and* amounts diverted to the treasury when a
reward is forfeited — a forfeit must not quietly open a second allowance.

**Two deliberate safety choices worth stating.**

Each day is explicitly stamped with which cap applies to it, rather than that
being inferred from the ceiling's value. A day can legitimately have a ceiling of
zero — a day with negligible or no emission — and if "zero ceiling" were read as
"the old rule applies", such a day would fall through to the *uncapped* path.
Days that close under the new regime without that stamp are treated as an error
rather than silently paid, and the stamp is written in the same step that turns
the old rule off so the two cannot drift apart.

The size knob refuses zero and is bounded at both ends. A zero share would stall
every claimant, and an unbounded one would defeat the cap's purpose entirely. A
stored zero therefore unambiguously means "never configured" and resolves to the
default, so a single mistyped setting cannot strand anyone.

A day's ceiling is fixed when that day closes. Adjusting the knob later changes
future days only — it can never retroactively reprice a day that has already
been settled.

Part of #1351. Umbrella: #1349.
