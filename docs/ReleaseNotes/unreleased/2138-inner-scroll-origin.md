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
granted, and review sharpened what "measured" means: only a scrolling
region that actually carries the element counts, which is decided by the
same containing-block walk the clipping rule already uses, so a
viewport-fixed element gets no credit and an absolutely positioned one is
credited only from its containing block upward; an element's own scroll
counts for its text and not for its box; the distance a region can move
its content back runs to that region's minimum, which is negative for a
reversed layout; the distance is mapped through any ancestor transforms
before it is compared with on-screen positions, so a doubled region is
credited double; and only the page's own scrolling element is left out,
since the page scroll is already accounted for, so a body element that
scrolls independently is credited. Where the engine cannot supply the
transform mapping the rule admits rather than guesses. Text parked far
above inside a scrolled region is still rejected. The fixtures reproduce
the exact measurements, a negative row position with the page unscrolled,
and assert them to the pixel so no case can pass without reaching the
state it claims to test.

Writing those fixtures found the same gap one level up, in the clipping
rule. A non-scrolling wrapper around a scrolling region, the usual
rounded-corner card around a scrolling list, judged content scrolled out
of the region's slit by where it currently sits and condemned it, even
though the region can scroll it back inside the wrapper. The exemption the
clipping rule already grants to a scrolling region now also covers a
wrapper above it on the axis that region can scroll. A wrapper with no
extent at all is still condemned whatever scrolls inside it, since nothing
is shown through it.

Also carried: the wording of the previous entry's call-site ordering, in
the test header and the coverage row, now states the two sites separately
as the release-notes fold already does.

Closes #2138. No product surface changes.
