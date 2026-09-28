# Release Notes — 2026-09-28

Two changes, listed in the order they merged. Both are about who is credited
with, or allowed to complete, something on a loan that has changed hands or is
being replaced.

The first makes the VPFI fee-discount tier follow ownership on every close-out:
VPFI held in reserve for a position's current holder no longer counts toward
the tier of the vault it happens to sit in. The second stops the auto-refinance
switch from blocking the ordinary refinance process, a lender accepting a
borrower's refinance request, while it still stops the automated routes, and
makes the app always state whether automatic matching is available.

## Thread — owed VPFI leaves the wrong wallet's fee tier on every close-out (PR #2356)

When a loan closes, what each side is owed — the lender's proceeds, the
borrower's returned collateral or surplus — waits in the original party's vault
until the current holder of that side's position NFT claims it. If the position
has changed hands, that VPFI sits in one wallet's balance while belonging to
another, and the VPFI fee-discount tier is worked out from the balance. Until
now only the swap-to-repay full close-out kept such VPFI out of the vault
owner's tier. Repayment, preclose, default and the liquidation paths did not,
so a party who no longer held the position kept tier credit on VPFI that was
not theirs — indefinitely when the holder was sanctioned and could not claim.

The platform now applies one rule to every close-out and to both sides: once a
loan has closed, the VPFI the platform is holding in reserve for a side's
position holder is excluded from the vault owner's tier whenever someone else
holds that position. The rule is checked when the loan closes, whenever the
position changes hands afterwards (selling an unclaimed position moves the VPFI
out of the seller's tier; selling it back returns it), and whenever the
reserved amount changes. At claim the exclusion is lifted before the VPFI
leaves the vault, so the vault owner's tier never dips below what they own.
Sanctions are no longer part of the test — the VPFI belongs to the holder
whether or not the holder can claim yet. The excluded amount is readable per
loan and per vault owner. Loans that were frozen under the old swap-to-repay
rule carry over without being counted twice. Loans that had already closed
before this change are not re-checked on their own, because nothing happens to
them that would trigger it. Anyone may therefore ask the platform to re-check a
list of closed loans. The result depends only on each loan's recorded state, so
asking can only make the exclusion correct, and asking again changes nothing.
Operators can run this once after the upgrade.

Scope and trade-offs: live loans are unchanged. Whether tier credit on a
transferred position should move to the holder before the loan closes is an
open product decision, so a live loan's collateral keeps counting toward the
original party until the position is consolidated. A tier change made at close
or on a position sale is recorded locally at once and reaches other chains
with the vault owner's next ordinary balance change, because a cross-chain
update inside a close-out could fail and block it. Closes #2342.
<!-- assembled-fragment: 2342-tier-exclusion-every-closeout.md sha256=827cb738e4c524b96a1734e49c06afc8ec78ca1ee1977d241226b01cf1480d74 -->

## Thread — the auto-refinance switch no longer blocks a lender accepting a borrower's refinance request (PR #2355)

A borrower refinances by posting a refinance request, and when a lender accepts it, one transaction opens the new loan, pays off the old lender and closes the old loan. Until now that accept failed whenever the protocol's auto-refinance switch was off, and the switch is off by default on a fresh deployment. So on any deployment that had not turned it on, a posted request could never be filled, and every lender who tried to accept it saw the transaction revert. No funds were ever at risk, because the whole transaction rolled back, but ordinary refinancing was effectively disabled there. The cause was in how the contract decided whether a refinance was "keeper-driven": it looked at who called it, and on the accept path the caller is always the protocol itself, so every lender accept looked like automation.

The switch now does what the functional spec says it is for. It stops the automated ways a refinance can be completed: a keeper acting on the borrower's behalf, and the order matcher filling a request. It never blocks the borrower refinancing directly, and it never blocks a lender accepting the borrower's request. Each completion route now states which route it is, instead of the contract inferring it from the caller. The matcher already refused refinance requests while the switch was off, and that is unchanged. No amount moved by a refinance changes: the old lender is paid, the new loan is funded, and the collateral carries over exactly as before. A new test runs the same accept with the switch on and off and requires the lender's payoff, the borrower's wallet payment and the collateral lock to match.

The app now reads the switch. While it is off, the refinance form and any open request say that automatic matching is switched off on this deployment, and that this setting does not stop a lender accepting the request directly. If the app cannot read the switch it says so, rather than showing nothing, and it re-reads the switch every minute so a change reaches a page that is already open. A failed re-read also shows the switch as unknown, instead of keeping an earlier answer that may no longer be true. The app now always states the automatic-matching posture on these surfaces, including when matching is on, while the status is still loading, when the switch is on but the order matcher's own separate switch is off (in which case the matcher cannot fill anything), and when the whole protocol is paused (in which case no lender can accept the request either). The wording claims only what the app has read: it never promises that a lender's accept will go through, and it no longer suggests keepers can fill a posted request, which they cannot. The two design documents for atomic and matched refinance carry a dated amendment recording the new matcher-only completion route and that the switch no longer blocks a lender's direct accept. The operator runbook now states what the switch does and does not stop, and that the protocol pause is the way to halt every refinance completion during an incident. The connected-app test suite now runs with the switch at its default (off) and proves the lender-accept refinance still completes. The internal deploy lists carry the new matcher route, and the curated redeploy script adds it on a Diamond deployed before this change. That script does not refresh the offer-matching code, so on a Diamond only partly refreshed with it the switch still stops matched refinances at the matcher's admission check, but not a second time when the refinance completes; the script now says so, and a fresh full deployment is the complete rollout. The refinance's fail-closed block on a sanctions-frozen borrower stays in the step that pays them, where the protocol's sanctions guardrail requires it, and a new test proves it still blocks such a borrower on the lender-accept route during a sanctions-oracle outage. Closes #2349.
<!-- assembled-fragment: 2349-refinance-switch-gates-automation-only.md sha256=86ac2d10bc53dc696f85acb3abbcbdec96897b380512fa8cfdc76a2def790913 -->
