## Thread — Alpha01 naive-first frontend plan (PR E1, Issue #864)

Adds `docs/DesignsAndPlans/Alpha01NaiveFrontendPlan.md`, the architecture and
PR-plan document for the greenfield connected app at `alpha01.vaipakam.com`.
The plan commits to naive-first Basic mode (intent wizards, review receipts,
mobile-first shell, light/dark themes) with a later Advanced mode for
DEX-exposed users, while leaving `apps/defi` untouched until operator cutover.

The doc records codebase scout findings: reuse `@vaipakam/contracts`,
`@vaipakam/lib`, and `@vaipakam/ui`; introduce `packages/defi-client` and
`apps/alpha01` without importing from `apps/defi`. Phased PR stack (P0–P3) maps
to GitHub issues #865–#868 under epic #863.

Closes #864. Implementation PRs follow the merge order in the design doc.