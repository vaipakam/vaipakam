## Thread — Borrower-side listing-hold surface (#1503 PR-A follow-up)

The listing lifecycle shipped in PR-A exists for the borrower — the
mandatory expiry, the permissionless teardown, and the relist cooldown
all bound how long a lender's sale listing can hold the borrower's
close-early and collateral-withdrawal options. This change gives the
borrower the surface where that protection actually reaches them. On
their loan page, a listing on their loan now renders a hold notice:
while the listing is live it explains which options are held, which
stay open (repaying fully or partially — a partial repayment shrinks
what a buyer would take over), and the structural bound on the hold;
once the listing has ended, the same notice grows a one-click "Free
held options" cleanup — the permissionless, pause-exempt teardown —
and confirms the lender's one-day relist quiet period after it runs.
The early-repayment chooser's close-early entry is marked held with
the same explanation instead of jumping to a flow that would fail.

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
re-signs), the close-early flow itself is gated with the same held
explanation as the chooser row (not just the chooser), the cleanup
goes through the app-standard review receipt, and the freed
confirmation survives the state refetch. A matching stale passage in
the connected-app functional spec (which claimed the reverse hold
set) was corrected the same way.

Part of the #1503 series; the lender-side pending-card teardown
surface remains tracked as #1506.
