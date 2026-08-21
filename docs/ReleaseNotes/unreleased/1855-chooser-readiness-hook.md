## The lender's options card now says whether it has finished deciding

The card that lists a lender's ways out of a position has always had to answer a
question before it can render: is any of these options actually available right
now? While it is working that out, the shortcut into the detailed tools is not
shown — and when the answer turns out to be no, it is not shown either.

From inside the app those two situations are obviously different. From outside —
to anything checking that the card behaves correctly on a real position — they
look identical, because the only evidence either way was the absence of a
control. That left post-deploy review with two bad options: wait a fixed length
of time and then assume the answer had arrived, or treat every quiet card as a
possible fault.

The card now states its own answer: whether the decision has settled, and what
it settled to. Nothing about the page looks different — no wording changes, no
new controls, nothing moves. The card simply stops keeping to itself something
it already knew.

**A failed check is reported as its own answer, not as either of the others.**
If one of the reads the sale options depend on fails outright, the card has
finished deciding — a reader should not be left waiting — but "finished" is not
the same as "the answer is no". A review that treated those alike would report a
position as having no exits available when the truth is that we could not tell.

Two things deliberately do not count towards the decision being settled. One is
the loan's interest schedule: it changes how the waiting option is worded and
nothing else, so waiting on it would hold up an answer it cannot affect — and on
a position whose schedule never loads, the answer would never come at all. The
other is a check that will never run: on a position where the app does not sweep
the market for buyers, and on one where the listing record cannot be read at all,
there is nothing to wait for. Treating a permanently-unanswerable check as
"still coming" would leave the card looking undecided forever.

The reason this was worth doing is that the alternative had already been tried.
Reviewing this card against a live position currently costs forty-five seconds
per page of waiting for an answer that may already have arrived, and three
separate classes of mistake in that review have traced back to guessing at an
absence rather than reading a fact.
