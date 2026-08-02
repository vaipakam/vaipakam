## Thread — Borrower-side listing-hold surface (#1503 PR-A follow-up)

The listing lifecycle shipped in PR-A exists for the borrower — the
mandatory expiry, the permissionless teardown, and the relist cooldown
all bound how long a lender's sale listing can hold the borrower's
offset close-out and collateral-withdrawal options. This change gives the
borrower the surface where that protection actually reaches them. On
their loan page, a listing on their loan now renders a hold notice:
while the listing is live it explains which options are held (the
offset exit and collateral withdrawal), which stay open (repaying
fully, partially, or closing early — a partial repayment shrinks
what a buyer would take over), and the structural bound on the hold;
once the listing has ended, the same notice grows a one-click "Free
held options" cleanup — the permissionless, pause-exempt teardown —
and confirms the lender's one-day relist quiet period after it runs.
The early-repayment chooser's offset entry is marked held with the
same explanation instead of jumping to its hidden card. (The review
rounds caught and corrected an inversion here: the on-chain hold is
on the offset path — offsetWithNewOffer refuses a listed loan — and
NOT on the direct early close, which carries no listing guard; the
same correction is applied to the PR-A wording in the specs and the
still-unassembled PR-A release fragment.)

One narrow state gets a stronger treatment than a notice. When a buyer
has already accepted the lender's listing and that sale is still
mid-completion, the buyer's funds are committed but the purchase has
not finished — and a borrower who repays, part-pays, closes, transfers
or refinances in that window would terminalize or reshape the loan the
purchase depends on, permanently stranding it. The app therefore
pauses the borrower's settlement options for the duration, with the
reason stated up front rather than surfacing as an unexplained
failure, and keeps adding collateral available throughout.

That pause deliberately stops at the edge of one state. A purchase can
only complete against a running loan, so once a loan has fallen into
fallback resolution the purchase is already stranded — a pause there
would protect nothing, could never lift on its own, and would shut the
borrower's last door while the lender's own claim stayed open to them.
In that state the app explains rather than enforces: it says a purchase
is attached, that it cannot finish until the loan is brought back to
normal, and that settling instead ends the purchase too — and leaves
the decision with the borrower. This is app-level protection over a
window the contracts still permit; the matching on-chain close-out
guard belongs to the #1503 PR-E slice.
Every settlement path additionally re-asks the chain immediately
before it sends, so an acceptance that lands while a review screen sits
open cannot slip past a cached answer, and any unanswered check pauses
rather than proceeds.

The state is judged from the chain alone, by simulating the exact
cleanup transaction the button would send and classifying the outcome
— no local marker, no off-chain index, so a listing made by the
lender on any device shows, and an outcome the app cannot classify
renders nothing rather than a false hold or a doomed button. The
committed fork spec drives the full lifecycle (live hold → expiry →
cleanup → on-chain link severed) and arms itself automatically once
the PR-A facet refresh reaches the live testnet Diamond; until then
it self-skips on a loupe probe — the same positive facet-version
signal the in-app probe requires before classifying, so the
pre-refresh Diamond (whose older teardown shares error names with the
new one) renders nothing rather than a wrong hold.

The review rounds also removed the app's stale
pre-acceptance-binding partial-repayment freeze: the partial-repay
surface no longer blocks while a listing stands (the contracts never
held it — a partial shrinks the claim and the pending buyer
re-signs), the cleanup
goes through the app-standard review receipt, and the freed
confirmation survives the state refetch. A matching stale passage in
the connected-app functional spec (which claimed the reverse hold
set) was corrected the same way.

Part of the #1503 series; the lender-side pending-card teardown
surface remains tracked as #1506.
