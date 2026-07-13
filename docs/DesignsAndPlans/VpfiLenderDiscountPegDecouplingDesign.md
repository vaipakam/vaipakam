# VPFI lender yield-fee discount — peg decoupling (E-1)

**Status:** design for a **decision + small contract change**. Card: #1203.
Umbrella: #1221. Related: #884 (peg-unset posture), #694 (legal frame),
[`UserValueEnhancementOpportunities.md`](UserValueEnhancementOpportunities.md) §3.1.

## Problem

TokenomicsTechSpec §6b: leaving the VPFI pricing peg unconfigured (the
documented conservative Phase-1 posture) disables **both** VPFI-denominated
discount paths, because `quoteYieldFee` shares the borrower LIF path's
VPFI conversion helper. Result: vault-held VPFI has no live fee utility at
launch — the tier system, TWA accumulator, and mirror caches all run, but
every settlement applies the ordinary fee.

## Why the coupling exists (and why it is only half-accidental)

The current lender-discount *delivery mechanism* is "deduct the discounted
yield-fee equivalent **in VPFI** from the lender vault to Treasury" (spec
§6 lender rules). Converting a lending-asset fee into a VPFI amount needs a
VPFI price — so under that delivery shape, the peg dependency is real, not
accidental. What IS decouplable is the discount **percentage** itself: a
tier-derived bps reduction needs no VPFI price at all.

## Design — dual-mode discount delivery

Mode selection is automatic from config state; no new governance action:

| Peg state | Lender discount delivery |
| --- | --- |
| **Unset** (Phase-1 launch posture) | **Direct-reduction mode:** yield fee charged in the lending asset at `feeBps × (10000 − effectiveDiscountBps) / 10000`. No VPFI moves. Treasury simply receives a smaller lending-asset fee. |
| **Set** (post-secondary-market decision) | **VPFI-payment mode** (current spec shape): fee equivalent deducted in VPFI from the lender vault, discount applied, VPFI routed to treasury → recycle bucket. |

Rules preserved in both modes: consent flag required; effective tier from
the canonical TWA (Base) or authenticated mirror cache; tier resolved at
the fee-application moment; tier-0 → no discount.

- The borrower LIF path is untouched: it *pays a fee in VPFI*, which
  inherently needs the peg; it stays peg-gated with the lending-asset
  fallback.
- Direct-reduction mode is the legally quietest utility shape possible:
  "hold VPFI → pay lower fees" — a price schedule, no token movement, no
  conversion, no promise.

## Contract changes

1. `quoteYieldFee` (and every lender-yield settlement site: repay,
   preclose, refinance, sale settlement, **and the periodic-interest /
   auto-liquidation servicing sites** — the spec's rule is "any
   lender-yield settlement moment", so interim periodic settlements get
   the same dual-mode treatment, not just the terminal ones; Codex
   round-7): if peg unconfigured → apply `effectiveDiscountBps` as a
   direct bps reduction; else current path.
2. Event: extend the yield-fee settlement event (or add one) with
   `discountMode` so analytics/indexer can distinguish modes.
3. No storage migration: reads existing tier state + existing config.

## Trade-off owner must accept

In direct-reduction mode the treasury forgoes fee revenue for holders
(up to 24%) without absorbing any VPFI. That is the cost of day-one
utility; it converts automatically into VPFI absorption the day the peg is
configured. Alternative (rejected): keep discounts fully off until the peg
is set — preserves revenue but leaves VPFI utility-less at launch, exactly
the problem.

## Tests

- Peg-unset deployment: each tier's settlement takes the reduced fee in the
  lending asset; consent-off and tier-0 take the full fee.
- Peg flip mid-loan: discount mode is chosen at the fee-application moment
  (settlement), consistent with the "current effective discount" rule.
- Mirror-cache path exercises both modes.

## Spec edit

TokenomicsTechSpec §6/§6b: state the dual-mode delivery and that the
peg-unset posture disables only VPFI-*denominated* payment, not the
discount itself.
