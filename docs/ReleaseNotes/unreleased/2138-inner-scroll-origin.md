## Thread — Live-drive visibility rule credits an inner scroll container (PR #2157)

The check that watches the lender's forced close-out card on the deployed
build reads only copy a sighted lender can actually see. One of its rules
rejects text parked before the document's top-left corner, the older
screen-reader trick, on the grounds that no scrolling reaches it. That
reasoning is right for the page's own scroll and was wrong for a scrolling
region inside the page: a row inside such a region, scrolled above the
region's own visible slit, sits above the viewport while the page itself
has not scrolled, so the rule condemned copy the lender can scroll straight
back to. Nothing the check reads sits inside such a region today, so the
gap was latent rather than live, and the failure direction is the one the
check is built to avoid: dropped text reads as absent copy, and absent copy
can be reported as a card failure.

The rule now asks the reachability question once, for both places it is
used, the element's box and the text's own glyph rectangles, and credits a
scrolling ancestor's offset before condemning. The credit is measured, not
granted: a region scrolled down by some amount can be scrolled back up by
that amount and no further, so text parked far above inside a scrolled
region is still rejected. The fixture reproduces the exact measurement the
issue recorded, a negative row position with the page unscrolled, and
asserts both facts so the case cannot pass without testing the rule.

Also carried: the wording of the previous entry's call-site ordering, in
the test header and the coverage row, now states the two sites separately
as the release-notes fold already does.

Closes #2138. No product surface changes.
