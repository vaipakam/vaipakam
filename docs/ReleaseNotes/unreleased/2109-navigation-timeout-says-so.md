# A page that ran out of time now says so

The sweep that walks every screen of the deployed app prints one line per
screen. When a screen fails to load, the line ends with "DID NOT LOAD".

Three kinds of thing can put it there, and two of them have always said
which: the server answered with an error page, or the app sent the
visitor somewhere else. The third is the opening itself throwing, and
that covers more than one situation — the screen ran out of time, or the
connection was refused, or the name would not resolve, or the browser
went away. Whichever it was, the line said nothing at all about it. It
read as a broken screen.

In the run that prompted this, four screens reported it, and other passes
of the same run loaded those same screens without trouble. That does not
prove the screens are fine — a screen that hangs intermittently is a real
problem, and one pass succeeding does not excuse another failing. It does
mean the reader is being told something the run did not establish: the
line says "DID NOT LOAD" and stops, so anyone reading it starts looking
for a fault in the app, when what actually happened may be that the
attempt ran out of time and nobody knows why.

The distinction is not cosmetic. A screen that answered with an error is
something the sweep established. A screen that ran out of time is a
screen the sweep never finished looking at, and it cannot say whether
that screen works. Reporting the second as though it were the first
states a finding nobody made.

That line now names the deadline that expired and says the screen is not
fully reviewed. Not that nothing was seen — the sweep may have watched
the page arrive, load scripts and report errors before one slow piece of
it ran the clock out, and the counters printed on that same line say so.
Claiming nothing was observed would contradict the numbers next to it,
which is the same kind of overreach in the other direction.

It cites the time budget rather than how long this attempt took, because
the elapsed figure only means something once you know what the screen was
allowed — and the budget is now written down once instead of being
repeated wherever a page is opened.

A failure the sweep does not recognise is reported as itself, in its own
words, on one line. It is not sorted into a category it has not earned,
which would be this same defect in a new place.

Whether the deadline expired is settled by asking the failure what it is,
at the moment it happens, rather than by reading its wording afterwards.
The first version read the wording, which would have handed the softer
"ran out of time" explanation to any failure whose text happened to
mention a timeout — an infrastructure excuse for a real defect, and the
one direction that matters.
