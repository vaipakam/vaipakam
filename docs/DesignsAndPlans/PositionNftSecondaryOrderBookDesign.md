# Native secondary order book for position NFTs (E-9)

**Status:** exploratory design; sequenced AFTER E-7 (#1209) + E-8 (#1210).
Card: #1211. Umbrella: #1221.

## Problem

Position NFTs are transferable and Claim Center is secondary-holder-aware,
but in-app there is no way to list/buy positions — users go to OpenSea,
where loan-specific pricing context (accrued interest, time to maturity,
HF) is invisible. This is the completing piece of the transfer-don't-break
exit story.

## Design (v1 = lender positions only)

**Reuse, don't rebuild:** the sale vehicle (post #951/#974, matchable per
E-8) IS the settlement engine. The "order book" is a dedicated book *view*
plus a bid side:

- **Listings (asks):** exactly the E-8 matchable sale vehicles — no new
  settlement path. The book view renders them with position context: par
  reference (E-7 formula: principal + net accrued), time to maturity,
  rate, collateral asset + live HF, borrower payment history flags.
- **Bids:** a buyer posts a standing bid bound to a specific position
  (`positionTokenId`, max price, expiry, funded from vault working
  capital — the lender-intent lock mechanism reused). Seller accepts →
  routes through the same sale-vehicle settlement. Collection-level or
  criteria bids (e.g. "any USDC position ≥8% APR, ≤90d left") are v2.
- **Borrower positions:** NOT listed in v1. Borrower-side transfer is the
  obligation-transfer flow (Preclose Option 2) with its lender-protection
  shortfall rules — a different machine; forcing it into a book UI
  invites term-confusion. Revisit after v1 data.

## Pricing display discipline

Par reference is informational; price is market-set. The view must show
yield-to-maturity at the listed price so buyers compare positions like
instruments — this, not the matching engine, is the actual product value
of a native book over OpenSea.

## Custody & validity

No escrow of the NFT: listings are live-loan-bound signatures (existing
sale-vehicle model), staleness-flagged per E-8. Bids escrow funds in the
vault lock class. Sanctions gates: both sides Tier-1 screened at
settlement (value transfer).

## Fractionalization — explicitly NOT designed

Tranching/fractional positions would require fraction-aware claims and
reward re-anchoring splits. Recorded here as the known future direction
E-8 pointed at; requires its own design + owner decision. Nothing in v1
may assume it.

## Fees

No fresh LIF (transfer, not origination). Ordinary yield-fee treatment
per E-7. An optional small book fee is an owner decision — recommendation:
zero in v1 (liquidity begets fee revenue later; don't tax the bootstrap).

## Tests / acceptance

Bid escrow lifecycle; accept-bid == accept-listing settlement parity;
YTM display math; stale listing/bid handling; Claim Center correctness for
a twice-traded position (buyer of a buyer).

## Spec edit

New ProjectDetailsREADME subsection under §9 ("secondary market for lender
positions"), superseding the "no in-app position trading" gap.
