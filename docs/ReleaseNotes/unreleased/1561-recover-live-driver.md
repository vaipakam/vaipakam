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

The guide fix needs a marketing-site deploy before the link is correct in
production; the driver was verified against a local production build of the site
in the meantime.
