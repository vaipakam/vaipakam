## Thread — Full-term vs pro-rata interest mode kept visible across borrower exits (PR #__)

Early repayment, preclose, refinance, or swap-to-repay may still owe full-term
interest depending on the offer's interest mode. That is intended behaviour for
full-term offers, but a borrower-expectation risk: many users assume early
repayment automatically reduces interest. #784 made the create / accept Risk
Disclosures reflect the offer's actual stored mode; this change carries that
signal through the rest of the borrower journey.

What changed:

- **New `InterestModeBadge`** — a small, reusable chip that reads an offer/loan's
  `useFullTermInterest` flag and shows `Full-term interest` (cautionary tone) or
  `Pro-rata interest` (benign tone), with a hover/focus tooltip explaining the
  consequence. It self-suppresses for non-ERC-20 principal, where the
  distinction isn't meaningful. The chip now appears on **Offer Book** rows
  (next to the rate), **Loan Details** (in the loan terms, for the life of the
  loan), and the **swap-to-repay** surface (a full close honours the loan's
  mode).
- **Mode-aware exit warnings** — `InterestImplicationWarning` gained an optional
  `fullTermInterest` input. The Direct-preclose and Refinance warnings now swap
  to pro-rata-specific copy when the loan charges pro-rata, instead of always
  asserting full-term. The refinance review's explicit old-lender-payout
  sentence is likewise mode-aware, so it no longer overstates the cost of
  refinancing a pro-rata loan. Kinds whose copy isn't full-term-specific
  (early-withdrawal, preclose transfer/offset) are unchanged. When the mode is
  unknown the warnings keep the full-term copy as the conservative default.

New component tests cover the full-term / pro-rata / partial-repay combinations
for both the badge (label + tooltip selection + the suppressed undefined case)
and the warning (mode-aware body/title swap for refinance and preclose-direct,
no-op for the other kinds).

Spec: `docs/FunctionalSpecs/WebsiteReadme.md` gains intent bullets for the
at-a-glance interest-mode indicator and the mode-aware exit warnings.

Closes #797.
