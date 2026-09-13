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
though the region can scroll it back inside the wrapper. A second review
round then showed that a blanket exemption for such wrappers overshoots in
the other direction, admitting a region whose slit the wrapper never shows
and content a region can only carry further away. So the clipping rule
and the origin rule now share one measure of what a scrolling region can
do, a range of movement in both directions rather than only back toward
its resting position, which is also what rescues content in a region
turned upside down. At a scrolling region the rule asks only whether the
content can reach the slit at all, since asking whether most of it can be
seen at once is the wrong question of something read by scrolling; at a
non-scrolling wrapper above it, the rule asks whether the slit itself is
mostly shown. A wrapper with no extent at all is still condemned whatever
scrolls inside it. A third round added two refinements to the same idea:
when one scrolling region sits inside another, the inner region's slit is
itself carried by the outer region's scroll, so it is placed where that
scroll can best bring it into view before the content is judged against
it; and a region styled to scroll but with nothing to scroll is treated as
the plain wrapper it behaves as, decided per axis. A fourth round tightened
the same model further: whether a region scrolls is read in on-screen axes
after any rotation, one scroll position has to serve every wrapper above
a region rather than each wrapper choosing its own, a wrapper that clips
only one axis leaves the other alone, and the two ways a horizontal
direction can be reversed cancel each other when combined, as measured in
the check's browser. One case from that round, a sticky row pinned to its
region, is deferred to its own issue with the reasoning recorded there.
The root element's overflow was also found to have been read as clipping
at the root's own box when it clips at the viewport, and is now judged as
the viewport. A fifth round added that a reversed flex direction only
reverses an actual flex container, and that the newer stand-alone rotate
and scale properties count as transforms the way the combined property
does; the exact treatment of a region rotated off the page's axes, where
the per-axis bounds admit more than a single scroll position can reach,
is deferred to its own issue with the reasoning recorded there. A sixth
round drew two boundaries and closed one gap: a region inside a
three-dimensional scene or written vertically is declared beyond what the
rule quantifies and is admitted rather than mis-measured, and a row that
is off-screen and admitted only because a region can scroll it back is now
checked for cover at the place it would come back to, so an opaque overlay
parked over the whole region rejects it. A seventh round refined those
edges: the cover check applies only where the page's own scrolling could
not bring the row back and looks inside the region's frame rather than at
its border, a row fixed to the viewport is never credited with the page's
scroll, page zoom is declared beyond the rule, the position chosen for a
nested region is the one that brings the row's reachable part into view
rather than the region's middle, and a stack of wrappers is measured
against the region's original size so that halving twice cannot pass as
half. One refinement, checking cover only over the exact band a scrolled-
out row can return to, is deferred to its own issue. The list of properties that make an element the
reference for absolutely positioned descendants gained two more, each
confirmed by measurement in the check's own browser, and one candidate the
review raised, container queries, was measured not to be one and left out
on that evidence.

Also carried: the wording of the previous entry's call-site ordering, in
the test header and the coverage row, now states the two sites separately
as the release-notes fold already does.

Closes #2138. No product surface changes.
