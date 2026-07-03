## Contract-level hardening: sanctions on reward claims + no-zombie partial repay (#921)

The alpha02 review (#887) surfaced a class of protections the app enforced only in the UI — which protects users of *our* client but not keeper bots, third-party frontends, or direct callers. This lands the first two as on-chain guarantees, so every integrator gets the same protection.

**Interaction-reward claims now screen for sanctions.** `claimInteractionRewards` pays VPFI directly to the caller, but — unlike every other payout path — it was missing the sanctions screen. A flagged wallet using any non-app client could claim rewards freely. It now carries the standard Tier-1 sanctions gate: a flagged caller reverts, exactly as the "payouts blocked while flagged" policy always intended. (The sibling forfeited-sweep, which routes to treasury rather than the caller, stays ungated by design.)

**A partial repayment can no longer strand a loan.** `repayPartial` accepted an amount equal to the entire remaining principal, subtracted it, and left the loan open at zero principal — a "zombie" whose settlement, collateral release, and position-NFT burns were stranded behind a separate full-repay call. Retiring the whole principal now reverts and points the borrower at the full-repay path (which runs all the close-out steps atomically), matching the equivalent guard already present on the swap-to-repay path. Genuine partials — anything strictly below the remaining principal — are unaffected.

Both are behaviour-preserving for every legitimate flow; they only close the two race/edge windows the UI was papering over.

Remaining #921 items (contract-level sanctions-gate audit, a public offer-state view, the `minPartialBps` setter/view, fee-snapshot-at-init, and an indexer `/claimables` filter) are tracked as separate follow-ups.

Part of #921.
