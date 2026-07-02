# Vaipakam Frontend

This package contains the task-first Vaipakam connected-app experience. It presents production-oriented flows for lending, borrowing, NFT rentals, portfolio management, claims, vault balances, VPFI utility, activity, settings, and data rights.

## Product Direction

Vaipakam is organized around user actions:

- Earn by lending tokens.
- Borrow against collateral.
- Rent temporary NFT access.
- Manage open positions, claimables, locks, VPFI discounts, and rewards.
- Use Advanced tools for custom markets, automation, protocol diagnostics, and risk simulation.

Every signing flow should share one review receipt pattern with these fields: what the user receives, what they lock, what they may owe, what can be lost, fees, and how the position ends.

## References

- `docs/DesignsAndPlans/BasicUserUXSimplification.md`
- `docs/TestScopes/BasicUserJourneyMap.md`
- `docs/FindingsAndFixes/Findings20260702-NaiveUserBrowserAudit.md`
- `docs/FunctionalSpecs/ProjectDetailsREADME.md`
- `docs/FunctionalSpecs/TokenomicsTechSpec.md`
- `docs/FunctionalSpecs/WebsiteReadme.md`
- `apps/defi` for existing wallet, chain, offer, claim, vault, and VPFI wiring.

## Integration Path

1. Wire the existing `apps/defi` providers and hooks behind these routes.
2. Add journey coverage for lending, borrowing, NFT rentals, claims, and data rights.
3. Keep production contract actions behind receipt review, wallet state checks, and network gating.
