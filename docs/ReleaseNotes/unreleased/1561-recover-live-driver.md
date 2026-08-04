## Thread — The recovery guide link now actually lands on the guide (PR #1561)

The connected app's stuck-token recovery flow makes the user sign a declaration
stating they have read the Advanced User Guide's section on stuck-token
recovery, and links them to it. That link has been landing on the wrong place:
it opened the guide, but not the section. Users got the top of a very long
document and had to find the section themselves — while having attested they
had read it.

The cause was two id schemes quietly competing. The guide files mark their
sections with stable, hand-authored anchors that are identical in every
language, and a plugin correctly attached those to the right headings. But the
component that renders headings then rewrote each one with an id derived from
the heading's own text, discarding the anchor the plugin had just computed. The
anchor never reached the page. Now the heading keeps its text-derived id — the
guide's own contents list links to those, so it has to — and the hand-authored
anchor renders as its own marker immediately before the heading. Both kinds of
link work, and the off-site one keeps working in every language, which is the
whole reason those anchors exist: the text-derived id changes when the heading
is translated, the hand-authored one does not.

This surfaced because the post-deploy review driver for the recovery page was
hardened first, and its previous version had been reporting the link healthy.
It checked that the URL returned a success status — but the marketing site
serves its app shell with a success status for *every* unknown path, so that
check could never have failed, whatever the link pointed at. It now opens the
link and requires the attested section to actually be present on the page it
reaches.

Seven other checks in the same driver were tightened for the same reason —
each could report green while the thing it named was broken. The discoverability
gate (recovery is deliberately unlisted; the Help explainer is the only way in)
was looking for links whose *label* mentioned recovery, so a link added under
any other wording would have passed unnoticed; it now looks at where links
point. The robots directive was read from the page's own markup rather than
from the server response, which is what a crawler that runs no JavaScript
actually sees. Two checks raced the page instead of waiting for it, so a slow
but healthy deployment could be reported broken. The driver also discarded the
read-only guard's own record of blocked write attempts, meaning the run could
print "all checks passed" over an attempted transaction; those now fail the run.
And where the page correctly withholds the recovery form because the connected
wallet is flagged or has an unresolved attempt outstanding, that is now reported
as a skip rather than a deployment failure.

The anchor mechanism was also only ever installed on the user guide, even though
the same stable-link promise covers the overview and whitepaper — an author
adding one of those anchors to either document would have found it silently did
nothing. It now applies to all three. And the marker the browser actually scrolls
to had no allowance for the fixed header, so even once the anchor existed the
link would have landed with the section's own title hidden behind the navbar; it
now clears it by the same margin the headings use.

Five further checks in the driver were tightened in a second review round. The
Help deep link is now required to point at this app's own recovery route rather
than merely a path that looks like one — a link redirected to another site would
otherwise have been reported as the working entry point. The Settings scan waits
for that page to actually render, because it loads lazily and its placeholder has
no links at all, which made a deployment that *had* added the forbidden link look
clean. And the separately-opened guide page now reports its own errors, which the
run's closing claim about uncaught errors did not previously cover.

The guide fix needs a marketing-site deploy before the link is correct in
production; the driver was verified against a local production build of the site
in the meantime.
