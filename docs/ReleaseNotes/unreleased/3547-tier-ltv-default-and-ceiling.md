## Tier LTV — a default and a ceiling per tier (PR #<n>)

Each liquidity tier now has two numbers: a default starting loan-to-value
(50%, 60% and 65% for tiers 1, 2 and 3) and a governance ceiling (55%, 69%
and 82%). This is the rule the owner set on 2026-11-11.

A fresh reading from peer lending protocols replaces the default, whether it
is lower or higher, and whichever applies is never above the ceiling. A
reading above the ceiling is now stored and clipped to the ceiling when a loan
reads it, rather than thrown away; so a ceiling governance lowers binds the
next loan at once, without waiting for a refresh. The lower edge of the old
per-tier range is gone: when peers lower what they lend against, the platform
follows. With no usable reading (none yet, older than 14 days, or peer reads
paused) the default applies, and it too is capped at the ceiling.

Each reference asset also now contributes the lowest of its agreeing peer
readings instead of their midpoint, so one peer loosening its own
configuration can no longer raise the platform's value.

The hard maximum on any tier setting rises from 80% to 82%, so the tier-3
ceiling can be configured at its default. The governance setter now takes a
ceiling and a haircut per tier (the floor argument is gone), and the refresh
no longer reports "out-of-band" rejections.
