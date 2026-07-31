## Thread — alpha02 exposes every borrower early-repayment option (chooser + handover + offset)

The protocol has long offered a borrower six ways out of an active
ERC-20 loan before maturity — full repayment, partial repayment, direct
early close, handing the obligation to a replacement borrower (preclose
Option 2), offsetting into a new lender position (preclose Option 3),
and refinance — but the connected app exposed only a subset, and the
two preclose transfer paths not at all: a Basic-mode borrower saw a
single "Repay this loan" button, and even Advanced mode had no surface
for the obligation handover or the offset. This change closes that gap
in two halves.

First, discoverability: the borrower's loan page gains a "Ways to repay
or exit early" chooser card, rendered in both interface modes, that
names every path with its cost implication stated up front — the
path-specific interest-implication wording the functional spec requires
before any preclose signature (full-term versus day-by-day interest for
a close, accrued interest plus a lender rate top-up for a handover,
fresh lending capital plus the payoff for an offset). In Advanced mode
each row jumps to the matching tool; in Basic mode the advanced rows
share one explicit "switch to Advanced view" action, so the mode change
is always the user's own choice.

Second, the two missing flows now exist. The handover flow lists only
standing borrow requests the contract would actually accept (same
assets, an amount range covering the outstanding principal, at least
the loan's collateral, a term ending before the loan's due date, not
the borrower's own or a refinance-tagged request), quotes each
candidate's cost to the borrower, re-verifies everything live at
submit, and completes the transfer in one transaction. The offset flow
posts the linked lender offer with the loan's terms as editable
defaults, surfaces the two must-know disclosures before review (the
borrower position NFT is transfer-locked while the offer is open, and
the old loan's payoff is pulled automatically from the wallet when
someone accepts), and sizes a single token approval to cover both the
posting escrow and the worst-case completion pull. A live offset gets a
standing pending card — driven by the chain's own position lock, so an
offset made on another device still shows — with a completion-funding
watch, a restore-approval action, and a cooldown-gated cancel; the
repay-family surfaces warn (and the discretionary ones hold) while an
offset is open so the linked offer can't be silently stranded. Both
flows are covered by a new fork-tier spec that drives the handover to
an on-chain borrower change and the offset through post, lock, and
cancel.

Follow-up deferred: a fork-tier spec for the counterparty acceptance
that completes an offset atomically (needs a third funded wallet), and
a swap-to-repay (pay with collateral) surface, which remains contract-
only for now.
