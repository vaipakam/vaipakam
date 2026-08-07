### Deep links into the user guide now land in every language, and a blind spot in the check that proves it

Two long-standing gaps in the guide are closed.

The Advanced guide's section on how a VPFI discount tier travels between
chains existed only in English. It is now written in all nine other languages.
It ends by pointing the reader at the fuller discount walkthrough, and because
that chapter is still English-only, each translation says so plainly rather
than sending the reader after something their edition does not contain.

The Korean Basic guide carried a section no other edition had, including the
English it was translated from: it described a withdraw control on the Rewards
page. There is no such control there — the same action lives on the VPFI page,
and the Korean Basic guide already describes it correctly in that chapter. The
stray has been removed. (The Advanced guide mentions the same action under
Rewards in every language including English, where it says plainly that it is
the same surface as the VPFI one. That is the source's own choice, present
everywhere, so it is not a divergence and is left alone.)

The English guide also introduced three points with the words "two things to
know". It now says three.

The more useful outcome is what closing those gaps exposed. The check that
compares editions worked by comparing the hand-written link targets each one
carries. That can only see a section that went missing while its neighbours
stayed — if an entire chapter is absent from a translation, every link target
it would have contributed is missing from both sides of the comparison at
once, and the check has nothing to compare. It reported all ten editions in
agreement while every one of the nine was missing a whole chapter, and two of
them were missing three.

The check now also compares how many chapters each edition has. The known
shortfalls are recorded so they cannot quietly grow, and a recorded shortfall
that has been fixed must be removed or the check fails — the record cannot
drift out of date in either direction. Translating those chapters is tracked
separately; it is roughly ninety-six thousand characters of translated output
across the nine languages, which is a translation project rather than a repair
to the check.

Chasing exactly what counts as a chapter turned up a defect on the live English
site, which is now filed on its own. The guide builds its contents list from the
link targets under each chapter, and drops any chapter that has none — so "How
VPFI Discounts Work" is printed on the Advanced page today but appears nowhere
in its contents list. A reader can only reach it by scrolling past everything
above it. Counting chapters the way the contents list does would have hidden
that, and would also have stopped reporting the chapter the nine translations
are genuinely missing, so the check counts what each file contains instead. The
difference between the two counts is the bug.
