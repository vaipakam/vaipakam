## Thread — Lender-sale listing lifecycle: finite window, expiry teardown, relist cooldown (PR-A of #1503)

A lender-position sale listing is no longer open-ended. Every listing now
carries a seller-chosen finite window (one hour to thirty days, picked from
presets in the app), and the listing expires on its own when the window
ends. The window can never outlive the loan: a window reaching past the
loan's due date is clamped to end exactly there, and a position too close
to maturity to stand for even the minimum window is refused at listing
time. An expired listing can no longer be bought — a buyer's acceptance at
or after the expiry moment is refused regardless of how fresh the buyer's
own signature is — and independently, no buyer can enter a position sale
at or past the underlying loan's due date (a matured position has zero
remaining term; the buyer would be purchasing nothing). That maturity
refusal fires at the moment of purchase, before any buyer funds move; a
sale entered before the due date remains completable on the documented
manual-recovery path, so a committed buyer is never stranded. The expiry
rides the same offer-expiry machinery regular offers use, so the open
book, the accept gate, and the lazy-clear path all treat a sale vehicle's
window uniformly. Listings created before this change (which carry no
expiry) are admitted to the permissionless cleanup immediately, and the
in-place testnet refresh script now removes the retired listing entry
point so the pre-change shape cannot be recreated.

Once a listing has expired on a still-active loan, anyone may tear it
down: the cleanup unlocks the seller's lender position NFT, cancels the
stale sale offer out of the open book (including the vehicle's own
offer-position record, so it also drops out of the open-position views),
severs the loan↔listing link, and announces the cancellation the same
way an ordinary cancel does — so off-chain indexes mark the listing
terminal without any extra transaction.
This teardown stays available while the protocol is paused — it moves no
value and creates nothing; it only releases a lock that no longer protects
anything, so an incident pause must not trap a seller's NFT behind a dead
listing.

Ending a listing without a sale — expiry or seller cancellation — starts
a one-day quiet period before the same loan can be listed again. This is
the borrower's action window: a live listing holds the borrower's
partial-repayment and collateral-withdrawal options, so back-to-back
relisting must not be able to keep those options frozen indefinitely.

App surfaces follow: the alpha02 listing form gains the window selector
(with the expiry and cooldown explained, and window changes voiding any
given consent), the listing receipts now name expiry as a way the listing
ends, and the legacy defi page pins the seven-day default window. Part of
the lender early-withdrawal prerequisite series tracked on #1503 (design:
LenderEarlyWithdrawalUXDesign.md — items 1 and 14 plus the borrower
action window).
