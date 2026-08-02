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
it self-skips on a loupe probe. Also corrected a stale passage in the
connected-app functional spec that predated the acceptance-binding
design and claimed the reverse hold set (partial repayment held,
close-early open).

Part of the #1503 series; the lender-side pending-card teardown
surface remains tracked as #1506.
