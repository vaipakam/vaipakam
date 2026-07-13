# Total-cost-of-loan simulator (E-6)

**Status:** frontend-only design. Card: #1208. Umbrella: #1221.

## Problem

A borrower's worst case stacks independently-specified charges (LIF,
full-term vs pro-rata interest, late fees, liquidation handling, liquidator
incentive, tier discount). Nobody can assemble the total from the spec; no
competitor presents it either.

## Design

Four scenario numbers at accept time (and on Loan Details) — HF-based
liquidation and time-based default are separate branches because HF
liquidation can occur pre-maturity and carries no late-fee/grace stack —
each expandable to an itemized breakdown:

| Scenario | Components |
| --- | --- |
| **Close on time** | LIF (0.1%, or VPFI path note) + interest per the loan's mode (full-term default vs pro-rata opt — labeled explicitly, per the #927 disclosure rule) + yield-fee note (lender-side, shown for completeness) |
| **Close late (grace end)** | base + grace-window interest continuation + late fees (1% first day + 0.5%/day, capped 5%; NFT-rental variant capped to buffer) |
| **Liquidated — HF-based (in-term)** | base only (no late fees, no grace interest — HF liquidation can happen before maturity) + 2% treasury handling + dynamic liquidator incentive (≤3%) + tier liquidation discount (per-tier bps), expressed as estimated collateral-value loss |
| **Defaulted — time-based (post-grace)** | the late-close stack + the liquidation charges above + fallback premium branch where applicable |

Rules:

- Every rate reads live config: `getProtocolConfigBundle()` /
  `getProtocolConstants()` — no hardcoded locale numbers (existing
  live-copy convention), and fee rates shown are the ones that will be
  **snapshotted at origination**.
- Interest mode is stated in words next to the number ("this loan charges
  full original-term interest even if repaid early").
- Liquidation scenario is clearly an *estimate* (price-dependent); shown
  only for liquid-collateral loans. Illiquid loans show the in-kind
  transfer outcome instead ("collateral transfers to lender in full").
- NFT rentals get the rental variant: prepay + 5% buffer, buffer-capped
  late fee, forfeiture split on default.
- The simulator is display-only; the authoritative preview remains the
  existing direct-accept preview / transaction preview surfaces.

## Placement

Accept review step (primary), Create Offer borrower tip (compact variant),
Loan Details (live recompute with elapsed time).

## Acceptance

Numbers reconcile with contract settlement to the wei in an Anvil e2e for
each scenario class (on-time, late, HF-liquidated in-term, time-based
defaulted, rental); COVERAGE.md row added per the verification directive.
