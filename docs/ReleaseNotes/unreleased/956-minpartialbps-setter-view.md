## Per-asset minimum partial-repayment floor is now configurable and readable (#956)

The protocol already enforced a per-asset minimum partial-repayment size — a partial repayment (or swap-to-repay) must be at least `minPartialBps` of the remaining principal — but there was no way to actually set that floor in production (only a test-only mutator wrote it) and no way to read it back on-chain. In practice it was therefore permanently zero: the floor existed in the code but never did anything.

This adds the missing surface (a #921 pre-audit follow-up):

- A **bounded admin setter** for the floor, gated to the admin role (governance after handover), the same gate its sibling per-asset/per-tier risk-config setters use. The value is range-checked (0 disables the floor; the maximum is 100%) and emits an event.
- A **read-only view** returning an asset's full risk parameters (max initial LTV, liquidation-bonus ceiling, reserve factor, and the min-partial floor), so integrators and the app can display and pre-flight the floor before a user submits a partial repayment.

No behaviour changes for existing loans; this only makes an already-enforced-but-dormant control usable. Kept as a dedicated setter rather than folded into the existing risk-params setter so that setter's signature and its callers stay unchanged.

Closes #956.
