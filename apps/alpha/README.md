# Vaipakam Frontend

This package is a redesign sandbox for a task-first Vaipakam experience. It is not a replacement for `apps/defi` yet; it is the place to prove the new information architecture, review receipts, and Basic/Advanced mode behavior before wiring production contract flows.

## Product Direction

The product starts from user intent instead of protocol objects:

- Earn by lending tokens.
- Borrow against collateral.
- Rent NFT access.
- Manage open positions, claimables, locks, VPFI discounts, and rewards.
- Use Advanced only after the user wants custom markets, automation, protocol diagnostics, or risk simulation.

The core rule is progressive disclosure: show the smallest useful decision first, then reveal contract details at the point they affect user risk. Every signing flow should eventually share one review receipt pattern with these fields: what the user receives, what they lock, what they may owe, what can be lost, fees, and how the position ends.

## References

- `docs/DesignsAndPlans/BasicUserUXSimplification.md`
- `docs/TestScopes/BasicUserJourneyMap.md`
- `docs/FindingsAndFixes/Findings20260702-NaiveUserBrowserAudit.md`
- `docs/FunctionalSpecs/ProjectDetailsREADME.md`
- `docs/FunctionalSpecs/TokenomicsTechSpec.md`
- `docs/FunctionalSpecs/WebsiteReadme.md`
- `apps/defi` for existing wallet, chain, offer, claim, vault, and VPFI wiring.

## Implementation Path

1. Validate the product shell and route structure with stakeholders.
2. Convert static cards into shared task-flow components.
3. Bring in the existing `apps/defi` providers and hooks behind the product routes.
4. Add Basic journey Playwright coverage from `docs/TestScopes/BasicUserJourneyMap.md`.
5. Promote proven pieces back into the production app once they are usable with real wallet states.
