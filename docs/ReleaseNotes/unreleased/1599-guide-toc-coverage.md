### A chapter of the user guide was on the page but not in its contents list

The Advanced guide's chapter on how VPFI discounts work was being printed on the
English help page and mentioned nowhere in that page's contents list. Readers who
navigate the way people actually read a long document — by scanning the contents
and jumping — had no way to reach it at all. It was only findable by scrolling
past everything above it.

The cause was quiet, which is why it lasted. The contents list is built from the
stable link targets attached to each card, and it dropped any chapter that had
none. That chapter's cards have none, so the chapter disappeared. Nothing failed
and nothing was logged; the page simply did not mention it.

A chapter with no linkable cards is now offered as its own entry, pointing at the
chapter heading. That is the durable half of the fix: the next chapter written
without link targets stays reachable instead of vanishing the same way. The
obvious alternative — adding link targets to that one chapter's cards — was
deliberately not taken, because the English guide would then carry targets none
of the nine translations have, which is its own kind of broken link. That chapter
is still untranslated, and it is tracked separately.

Two smaller things came along with it. The contents list now reads the document
the same way the page renders it, rather than by scanning the raw text for lines
that look like headings — so a heading written inside a code sample or a comment
is no longer offered as a section that goes nowhere. And a new check fails the
build if any chapter is missing from its contents list, using the same code the
page itself uses to build that list, so it cannot quietly agree with a future
version of this bug.
