# A page that ran out of time now says so

The sweep that walks every screen of the deployed app prints one line per
screen. When a screen fails to load, the line ends with "DID NOT LOAD".

There are three ways that can happen, and two of them have always said
which: the server answered with an error page, or the app sent the
visitor somewhere else. The third — the screen simply never finished
loading inside the time allowed — said nothing at all. It read as a
broken screen.

In the run that prompted this, four screens reported it, and none of them
was broken. The evidence was in the same output: other passes of the same
run loaded those same screens fine. But the line that matters says
"DID NOT LOAD" and stops, so anyone reading it starts looking for a fault
in the app.

The distinction is not cosmetic. A screen that answered with an error is
something the sweep OBSERVED. A screen that ran out of time is something
the sweep observed NOTHING about — it cannot say whether that screen
works or not. Reporting the second as though it were the first states a
finding nobody made.

That line now names the deadline that expired and says plainly that the
screen was not observed. It cites the time budget rather than how long
this attempt took, because the elapsed figure only means something once
you know what the screen was allowed — and the budget is now written down
once instead of being repeated wherever a page is opened.

A failure the sweep does not recognise is reported as itself, in its own
words, on one line. It is not sorted into a category it has not earned,
which would be this same defect in a new place.
