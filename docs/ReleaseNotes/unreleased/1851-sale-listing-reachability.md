## A reported stuck-listing state turned out to be unreachable (#1851)

A review of an unrelated design document raised a worrying pairing in the
position-sale code: a listing that has been taken but not yet finished cannot
be finished once the underlying loan ends, and the permissionless cleanup that
clears dangling listings deliberately skips listings that have been taken. Put
together, those two rules would leave a listing that could neither complete nor
be cleared.

Both rules are real. The question nobody had asked was whether anything can
actually put a listing into that state, and the answer is no — a state with no
way out only matters if there is a way in.

Taking a listing finishes the sale in the same transaction, and a finish that
cannot succeed undoes the whole purchase, so "taken" and "finished" are set
together or not at all. The one route that could mark a listing taken without
that step is the partial-fill matcher, and a position sale cannot be matched at
all — it is an all-or-nothing transfer that only direct acceptance can take. And
if the loan behind a listing has already ended, the purchase is refused outright,
before any of the buyer's money moves, leaving the listing untaken and the
cleanup available.

Nothing about how the platform behaves changes here. What changes is that the
reasoning is now written down where it is needed and enforced by a test: the
cleanup's own code carries the explanation of why skipping taken listings is
safe, and a test drives the exact scenario that was reported — list a position,
let its loan end, attempt the purchase — and checks both halves of the claim,
that the purchase is refused *and* that the listing stays clearable afterwards.

The intended behaviour was already recorded correctly in the platform
specification, which states that no buyer can be harmed by a dangling listing
because a purchase against an ended loan is already refused. That is worth
noting: the specification is written from the design documents rather than read
back off the code, so it stood as an independent statement of the same property
the code turns out to have.

Closes #1851.
