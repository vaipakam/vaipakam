### alpha02: whole-site UI/UX review — findings logged + reusable evidence sweep

A full-surface UI/UX review of the alpha02 site was run against the
deployed testnet (every page, desktop and mobile, Basic and Advanced
modes, with a connected test wallet). Fifty prioritized findings —
from trust-damaging state bugs (a repaid loan still showing an amount
owed and a default warning) through mobile layout crushes, dead-end
empty states, and a slow-connection blank-screen cold load — are
logged with IDs in
`docs/FindingsAndFixes/Findings20260711-Alpha02UiUxReview.md`
for later fix batches. No behaviour changed in this PR.

The review also leaves behind a committed, read-only evidence sweep
(`live-ux-sweep.mjs`) that captures screenshots, console, network,
and browser-storage/performance diagnostics for every route in one
run, so future UX audits and before/after checks are reproducible
instead of hand-driven.
