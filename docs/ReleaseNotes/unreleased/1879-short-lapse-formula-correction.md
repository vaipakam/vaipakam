## A published note carried a payout formula that was never right (#1879)

A release note from earlier this month described how a compensated-but-
underfunded reward day pays out when its deadline passes, and said that
every settlement path pays proportionally within the funding that
arrived. That is not what the platform does. A per-entry allowance comes
off the funded pool before the proportion is worked out, so a day whose
funding does not clear that allowance pays nothing at all — even though
funding did arrive.

Dated release notes are normally left as they were written, on the
grounds that they record what was believed at the time. That rule does
not cover this one. The allowance was already in the platform two days
before the note was written, so the paragraph was not true-then-stale; it
was wrong when it was published.

The difference matters because of who it costs. A stale status claim
leaves a reader with an out-of-date picture of where things stand. A
wrong formula hands them a number, and anyone sizing an expected payout
from that paragraph would have arrived at one the platform will not pay.

The published wording is left where it is, with a marker pointing at a
correction appended to the same file. A reader who finds the old
paragraph is told it was corrected, and a reader who reads to the end is
told what the correction says — neither is quietly rewritten out of what
was actually published.
