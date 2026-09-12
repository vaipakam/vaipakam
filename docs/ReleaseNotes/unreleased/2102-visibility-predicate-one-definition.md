## Thread — the live drive's visibility predicate has one definition (PR #TBD)

Closes #2102. Review tooling only; nothing a user sees changes, and the
functional specification is untouched.

The live review drive decides every content claim it makes about the
lender's forced close-out card — that the card is on screen, that its
explanation can be read, that its action can be pressed, that each row
of the confirmation receipt and both halves of every row are legible —
through one question: can the lender actually see this element. That
question was answered by the same body of rules written twice, once for
the card pass and once for the receipt pass, because the two passes run
inside the browser as separate callbacks that cannot share code. The
copies had drifted once before anyone noticed, and every rule added
since has had to be written into both, with a review finding each time
one of them was missed.

The rules now live in one place, as a browser-side module, and every
consumer in the drive composes that module in on the Node side before
handing the browser a plain function. The page runs no evaluated
source, which is the objection the original issue raised against
sharing code by injecting it; nothing is installed on the app under
test, which keeps the drive watch-only; and the two places that had
been evaluating sliced-out source inside the page — the wait for the
card to mount and the read of the confirmation's cancel control — now
go through the same composition, so the drive evaluates no source in
the page at all. The mechanism that sliced the rules out of the drive's
own file by matching braces, which the fixture suite and the mount wait
both depended on, is gone with it.

The fixture suite that exercises the rules against a real layout engine
imports the production definition and runs the same fixtures once
instead of once per copy. What it pins now is not that two copies agree
but that there is one: the drive defines none of the rules inline and
composes the module at every consumer. A rule added to the predicate
reaches the card pass, the receipt pass, the mount wait, the cancel
control read, and the fixture suite by construction — the acceptance
test the issue set.
