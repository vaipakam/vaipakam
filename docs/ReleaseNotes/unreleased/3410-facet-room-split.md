## Thread — Two facets split to make room for the outage clock (#3410)

The work for #3410 (an L2 sequencer outage moves a loan's grace end) adds a
small read to every facet that checks a loan's grace end. Two facets had no
room left for it under the EIP-170 contract size limit: PrecloseFacet and
AutoLifecycleFacet. Each is split along a boundary that was already there,
before the #3410 change lands, so that change stays reviewable on its own.

PrecloseFacet keeps the direct early close and the obligation handover. The
borrower's offset route (posting a new lender offer that offsets the loan,
and closing the loan once someone accepts it) moves to a new
PrecloseOffsetFacet. The completion step was already reached across the
Diamond by its selector when a third party accepts the offset offer, so
nothing calls it differently. The steps both facets take (who may act, which
asset is paid, the lender's fee discount, the rental reset and the position
marking) now live once in a shared library instead of as private copies.

AutoLifecycleFacet keeps the in-place extension, its window and the
extension reserve. The consent and limits settings (auto-lend consent,
opt-in on new loans, refinance limits and extension limits, with their
readers) move to a new AutoLifecycleSettingsFacet.

Nothing changes for users or integrators that call the Diamond: the
selectors, arguments, events and errors are the same, and only the contract
that holds the code differs. Off-chain code that reads one facet's ABI file
instead of the combined Diamond ABI has to read the new file for the moved
functions; the keeper's auto-extension and pre-grace passes are updated in
the same change. The facet refresh scripts carry both halves of each split,
so a refresh never leaves half of a route on old code.

Advances #3410.
