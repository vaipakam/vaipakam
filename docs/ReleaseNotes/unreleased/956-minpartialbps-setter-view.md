## Per-asset minimum partial-repayment floor is now configurable and readable (#956)

The protocol already enforced a per-asset minimum partial-repayment size — a partial repayment (or swap-to-repay) must be at least `minPartialBps` of the remaining principal — but there was no way to actually set that floor in production (only a test-only mutator wrote it) and no way to read it back on-chain. In practice it was therefore permanently zero: the floor existed in the code but never did anything.

This adds the missing surface (a #921 pre-audit follow-up):

- A **bounded admin setter** for the floor, gated to the admin role (governance after handover), the same gate its sibling per-asset/per-tier risk-config setters use. The value is range-checked (`0` disables the floor; the maximum is just under 100% — a full-100% floor is rejected because it would make every partial repayment for that asset impossible, since a partial can never retire the entire remaining principal) and emits an event. The floor applies only to **ERC-20** loans; NFT-rental partials (whose "amount" is a day count, not a token amount) are unaffected by it.
- A **read-only view** returning an asset's full risk parameters (max initial LTV, liquidation-bonus ceiling, reserve factor, and the min-partial floor), so integrators and the app can display and pre-flight the floor before a user submits a partial repayment.

**Rollout impact — read carefully:** leaving the floor at its default (`0`, which is where every asset starts) preserves today's behaviour exactly. But the enforced floor is read **live** on every partial repayment, so **configuring a nonzero floor takes effect immediately for all active loans of that asset**, not just loans opened afterward — an in-flight loan whose next partial would fall below the new floor will start being rejected (the borrower must submit a larger partial, or a full repayment). Operators should account for that when setting a floor on an asset with open positions. Kept as a dedicated setter rather than folded into the existing risk-params setter so that setter's signature and its callers stay unchanged.

Closes #956.
