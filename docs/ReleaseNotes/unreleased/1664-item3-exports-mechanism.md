## Automated readers are now told where the current rates live, instead of the documents pretending to carry them

The plain-text copies of the documentation that the site publishes for automated
readers carry the protocol's original settings — the ones it was built with —
and they do not change when governance later retunes a rate. That was made
explicit a while ago, replacing wording that implied the files were current as
of the day they were produced. What it left open was what to do about it.

The open option was to have the publication step read the live settings and
write those into the files instead. That has been decided against, and the
reasoning is worth recording because the option sounds strictly better than it
is. It would not make the files current; it would move the moment they go out
of date from the release to the publication, while making publication depend on
a service that can be unavailable, and making two publications of the same
source produce different files. It would also pull protocol data into the
documentation surface, which is deliberately the one public surface that holds
no chain credentials and no chain dependencies.

What a reader who needs current figures actually needs is somewhere to read
them. That already existed — the same public, keyless data service the site
itself consults — but the index that tells automated readers what this site
offers never mentioned it, listing only the offer and loan feeds. It does now,
pointing at the deployment the documents describe, and saying plainly that the
documents carry starting rates while that address carries current ones. Static
documents beside a named live source is the same division the site already
publishes for its other data.

### The live figures now arrive with names on them

Advertising that address exposed a second problem. It was returning its numbers
as a bare list, in the order the contract happens to return them — fine for our
own pages, which know the order, and useless to anyone else, who cannot tell
which number is the treasury fee. A public address that automated readers are
pointed at cannot serve numbers only its author can interpret.

Each figure now also arrives under its own name, alongside the original list so
nothing that reads the list today is disturbed. The names are taken from the
compiled contract rather than written by hand, for the same reason the project
already forbids hand-written positional lists in the services that read from
chain: a field added or renamed in the contract silently shifts every position
after it. And if the stored snapshot and the contract ever disagree about how
many figures there are, the named view is withheld entirely rather than guessed
at — a number carrying the wrong name is worse than a number carrying none,
because nothing about it looks wrong.
