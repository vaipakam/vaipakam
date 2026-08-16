## The contract size guard now says how close each part is to its limit

Each part of the protocol's contract has a hard ceiling on how much compiled
code it may contain. Going over means it cannot be deployed at all, so a guard
already fails the test run when any part exceeds it.

That guard is a wall: it says nothing until someone crosses it. A part sitting
one byte under the ceiling looks exactly like one that is half empty, right up
until the next person adds a line and discovers — after writing a perfectly
correct change — that there was no room for it.

That is not hypothetical. Measuring found **two parts within about thirty bytes
of the ceiling**, which is roughly one more safety check each, and four more
inside a kilobyte. None of it was visible from a passing test run, and one of
the two was found only because a change happened to touch it; the other had
been sitting there unnoticed.

The guard now also reports, on every run, any part with less than a kilobyte of
room left, naming it and saying how much it has. Six parts currently qualify.
The wall becomes a gradient: running short is visible while there is still time
to plan for it, rather than arriving as a blocked change on someone else's
work.

Deliberately a report rather than a failure. A part may legitimately sit close
to its ceiling for a while, and failing the run for that would only teach
people to raise the threshold instead of reading it. Exceeding the actual limit
still fails, which is where refusal belongs.
