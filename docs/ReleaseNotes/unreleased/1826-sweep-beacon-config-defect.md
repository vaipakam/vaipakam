## The review sweep stops filing a configuration defect under "environmental noise"

The automated review sweep sorts what it sees into problems with the app and
things that are merely background. A refused analytics script had been filed
under background, which was a mistake — and one this project had just finished
arguing against in the surrounding work.

That script is inserted into every page by the hosting configuration, and the
site's security policy refuses it. The refusal is the correct behaviour: the
collector is added after the page leaves the application, so it cannot be held
back until a visitor consents to analytics, and the rule the project settled on
is that such a collector must be switched off where it is injected rather than
allowed through. Filing the resulting message as background noise treated a
configuration defect as weather — and, worse, would have quietly swallowed the
same message if the injection were ever switched back on after someone turned
it off.

The sweep now names it. Once per run, not once per page, it reports that the
injection is on, how many pages are affected, that the refusal is correct while
the injection is not, and where the fix belongs. Loud enough to act on, quiet
enough not to drown the rest of the report.

It also fails the sweep, which was the harder half of the decision. The first
version only warned, reasoning that the remedy is a hosting setting rather than
a change to any file in the project, so a failure would block work nobody
reading it could unblock. Review pushed back and was right. This sweep runs
after a deployment, not before a merge, so it blocks nothing — and the person
reading its verdict is the one who can change the hosting setting. Meanwhile
the batch that collects these runs reads a clean exit as a pass, so warning
only would have placed a confirmed privacy defect inside a green summary. Where
the fix lives decides who does it, not whether a run that found the problem may
call itself clean.

### Watching for the refusal was not enough

The first version noticed the problem by watching for the browser's complaint
that it had refused the script. Review pointed out that this goes quiet in the
one case that matters most: if the site's own security policy were ever
missing, out of date, or widened to let this collector through, there would be
no complaint to notice — and the collector would be running for real. The check
would have turned green at the exact moment the problem got worse.

It now watches for both, by two separate means: the browser's refusal, and a
reply actually coming back from the collector. Either one fails the run, and
they are reported differently, because the remedies differ — a refused script
means one thing to switch off, while a collector that answered means the
security policy is not doing what the project believes it is doing, and both
need attention.

Which signal to watch was measured rather than guessed, and the obvious choice
was wrong. A refused script still counts as an attempt, so watching for
attempts would have accused today's correctly-behaving deployment of running a
collector it in fact blocked — a false report of the worse problem, inside the
check whose whole purpose is to report this one honestly. Watching for the
*reply* separates the two cleanly. Confirmed against the deployed site in both
states: as it stands today, and again with the security policy deliberately
disabled to produce the case under discussion.

### A detail worth keeping

The problem is a property of the deployment rather than of any particular page
— every page sees it — so the report counts the affected pages and mentions the
total once, instead of repeating itself for each one. Reporting per occurrence
would have produced a number that says more about how many pages the sweep
happened to visit than about the problem.
