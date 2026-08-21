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

It deliberately does not fail the run. The remedy is a hosting setting rather
than a change to any file in the project, so failing would block work that
nobody reading the failure could unblock.

### A detail worth keeping

The message is reported per affected page but counted as one finding, because
it is a property of the deployment rather than of any particular page — every
page sees it. Counting occurrences would have produced a number that says more
about how many pages the sweep happened to visit than about the problem.
