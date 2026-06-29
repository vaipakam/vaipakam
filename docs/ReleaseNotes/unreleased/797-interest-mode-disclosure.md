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
  loan), and **both swap-to-repay** surfaces — the atomic panel and the
  best-price intent panel (a full close honours the loan's mode).
- **Mode-aware Direct-preclose warning** — `InterestImplicationWarning` gained an
  optional `fullTermInterest` input. The Direct-preclose warning swaps to
  pro-rata-specific copy when an ERC-20 loan charges pro-rata, instead of always
  asserting full-term. Gated to ERC-20 principal: NFT-rental preclose always
  settles the full rental, so it keeps the full-term-style copy.
- **Refinance stays full-term (deliberately not mode-aware)** — the on-chain
  `RefinanceFacet` computes the old-loan payoff via `LibEntitlement.fullTermInterest`
  unconditionally, so the refinance screen always discloses full-term interest
  and never switches to pro-rata copy — the pre-sign disclosure must match what
  the transaction actually pulls. The stale "rate shortfall" wording was also
  dropped from the refinance copy: that path no longer pulls a shortfall
  (`shortfall = 0`).
- **Repay-in-Full confirmation** — the confirm copy now picks the most accurate
  wording: an overdue (in-grace) loan settles through-today interest plus a late
  fee (which can exceed full-term), a full-term ERC-20 loan settles the full-term
  interest (not just accrued), and other cases keep the generic line.
- **Treasury-fee wording** — the preclose interest warnings no longer hard-code a
  99% / 1% lender/treasury split (the treasury fee is governance-configurable);
  they now refer to "the configured protocol treasury fee".

New component tests cover the full-term / pro-rata / partial-repay combinations
for the badge (label + tooltip selection + the suppressed undefined case) and the
warning (the Direct-preclose mode-aware swap, refinance staying full-term, and
no-op for the other kinds).

Spec: `docs/FunctionalSpecs/WebsiteReadme.md` gains intent bullets for the
at-a-glance interest-mode indicator, the mode-aware Direct-preclose warning, the
always-full-term refinance exception, and the mode-aware repay confirmation.

Closes #797.
