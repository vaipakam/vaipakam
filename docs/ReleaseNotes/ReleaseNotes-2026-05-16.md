# Release Notes — 2026-05-16

Two threads in flight today, both addressing gaps the C.1 audit thread surfaced when it closed the previous evening: a documentation surface for the liquidation-fallback mechanics (which the consent-flow polish deliberately pulled out of the Risk Disclosures), and the first phase of a deeper rework that lets internal-match rescue stuck `FallbackPending` loans whose at-fallback liquidation failed transiently.

## Thread 1 — EC-005: liquidation-fallback mechanics in AUG + FAQ (PR #17)

When the Risk Disclosures was shrunk to its final 2-paragraph form (PR #14, 2026-05-15), the detailed mechanics of the four contract branches in `LibFallback.computeFallbackEntitlements` were intentionally pulled out of the consent surface. The legal-binding screen now captures worst-case outcomes + acknowledgement only — protocol mechanics belong in educational surfaces, not the consent flow.

EC-005 gives those mechanics a proper home. Three surfaces, one PR:

- **Advanced User Guide** — new top-level `## How Liquidation Actually Works` section in [`apps/www/src/content/userguide/Advanced.en.md`](../../apps/www/src/content/userguide/Advanced.en.md), placed between `## Loan Details` and `## Allowances`. Covers all four fallback branches with worked examples:
  - Oracle available + collateral ≥ amount due → equivalent-value split
  - Oracle available + collateral < amount due → all-collateral to lender
  - Oracle quorum UNAVAILABLE → all-collateral to lender (distinct event emitted)
  - Illiquid asset on either side → full collateral in-kind
- Plus two appended subsections: "Why in-kind, why not always cash?" and "Claim-time retry."
- **FAQ entry** — `id: "fallback-mechanics"` in [`apps/www/src/components/FAQ.tsx`](../../apps/www/src/components/FAQ.tsx). Tight 4-bullet summary keyed under `faq.entries.fallback-mechanics` in `en.json`.
- **Risk-Disclosures cross-link** — `RiskDisclosures.tsx` now renders a "Learn how liquidation actually works →" link below the 2-paragraph disclosure, pointing at `marketingUrl('/help/advanced#liquidation-mechanics.case-1')`. Users can opt-in to mechanics depth without being forced through it at consent time.

PR: [#17](https://github.com/vaipakam/vaipakam/pull/17). Closes [#16](https://github.com/vaipakam/vaipakam/issues/16). English-only; non-en locales fall back to `en` via the existing `fallbackLng` config — translations fold into EC-004's backlog ([#13](https://github.com/vaipakam/vaipakam/issues/13)).

## Thread 2 — EC-003 Phase 1: FallbackPending loans become a valid leg in internal-match (PR #18)

The investigation phase of EC-003 surfaced a deeper opportunity than the original "claim-time internal-match" ask: **many `FallbackPending` loans involve liquid collateral that failed at-fallback liquidation only transiently** — slippage briefly exceeded the 6% ceiling, a DEX reverted, the oracle was stale at that moment, MEV interference, sequencer hiccup. The asset stays priceable; only the at-fallback swap moment was bad. Leaving the lender holding in-kind collateral when an opposing-direction counterparty exists is leaving money on the table.

The B.2 internal-match path excluded `FallbackPending` legs by an early status check (`RiskFacet.sol:837-840`), and the keeper bot mirrored that filter. Both were conservative-by-design from when B.2 shipped, but reflect no economic reality.

Phase 1 widens the leg-eligibility from `{Active}` to `{Active, FallbackPending}`:

- **Status gate widening**. `triggerInternalMatchLiquidation` accepts `FallbackPending` legs for any of the 2 or 3 legs. Error rename `InternalMatchLoanNotActive` → `InternalMatchLoanNotMatchable` to reflect the widened semantic.
- **Oracle-priceable gate for FallbackPending legs** (new `InternalMatchAssetUnpriceable` error). The original LTV-floor check is irrelevant for FallbackPending legs — they're already past the threshold by definition. The right gate is "do we trust the oracle to price this swap?" Same gate `LibFallback.collateralEquivalent` already uses.
- **Rehydration of borrower's escrow**. FallbackPending collateral physically lives in the Diamond's own balance (was withdrawn from the borrower's escrow at the failed at-fallback moment). The new `_rehydrateFallbackEscrowIfNeeded` helper pushes it back so the existing `_settleLeg` machinery runs unchanged. Idempotent — sets `snap.active = false` after first call.
- **Post-settlement snapshot scaling**. New `_settleFallbackOrTransitionPostMatch` helper handles three routes:
  - Active + `principal == 0` → existing B.2 `Active → InternalMatched` transition.
  - FallbackPending + full match → clears claim records, transitions `FallbackPending → InternalMatched`. Treasury's at-fallback entitlement is forfeited (consistent with Active→InternalMatched — no treasury cut on internal-match rescue); borrower's residual collateral stays in their escrow.
  - FallbackPending + partial match → loan stays `FallbackPending`. Snapshot's reference fields (lender / treasury / borrower collateral + principal due) scale proportionally to the surviving collateral. Claim records re-pointed to the new collateral-unit residual. Future matches or claims pick up the reduced loan.
- **New lifecycle edge `FallbackPending → InternalMatched`** added to `LibLifecycle._isValid`'s allow-list. Symmetric to the `Active → InternalMatched` edge B.2 added.
- **Lifecycle predicate / error rename**. `_isLegal` → `_isValid` and `IllegalTransition` → `InvalidTransition`. "Legal" overloads in a DeFi context (regulatory baggage); "valid" is the conventional state-machine vocabulary. 6-occurrence rename inside `LibLifecycle.sol` only; no external consumers.

Tests:

- 5 new cases in `InternalMatchExecution.t.sol` covering FallbackPending + Active full-match, FallbackPending + FallbackPending full-match, partial match (stays FallbackPending), oracle-unpriceable revert, and snapshot-cleared post-rescue.
- 3 occurrences in `InternalMatchLiquidationGates.t.sol` updated for the error rename.
- New `setFallbackSnapshotRaw` mutator in `TestMutatorFacet` so fixtures scaffold FallbackPending state without driving the full at-fallback flow.
- `forge test --no-match-path "test/invariants/*"` → **1941 passed / 0 failed / 5 skipped** (94 suites).

PR: [#18](https://github.com/vaipakam/vaipakam/pull/18). Phase 1 ships standalone — the keeper bot can already use the widened gate manually; the full auto-dispatch UX win comes in Phases 2-3.

## What's next — EC-003 Phases 2-4

Each phase ships standalone so we can pause between for review / testnet bake.

- **Phase 2** — Asset-pair index `s.activeLoansByAssetPair[principalAsset][collateralAsset] = uint256[]` (push on `initiateLoan`, swap-and-pop on terminal-status transition; FallbackPending stays in the index). New `MetricsFacet.hasInternalMatchCandidate(loanId)` view backed by the index — O(K) lookup where K is loans in that exact asset-pair, not O(N) over all active loans. Foundation for Phase 3.
- **Phase 3** — Auto-dispatch in `triggerLiquidation` / `triggerDefault` / `claimAsLenderWithRetry`. Each entry-point calls `hasInternalMatchCandidate` first; on hit, settles via internal-match with the existing 1% matcher bonus paid to `msg.sender` of the dispatching call; on miss, falls through to the existing external-aggregator path. The user's claim-time insight is the load-bearing argument: at lender-claim time, the candidate pool has grown to include FallbackPending loans that appeared since the keeper's last scan — the claim-side branch isn't redundant with Phase 1's keeper-driven rescue, it's the safety net for the gap between keeper-tick and lender-claim.
- **Phase 4** — Keeper bot drops the Active-only filter in `internalMatcher.ts`; AUG section "How Liquidation Actually Works" gains a "Pre-claim internal-match rescue" subsection; FAQ entry extended; new audit-package addendum `InternalMatchFallbackRescueAudit-<date>.md`.

Plan file: `~/.claude/plans/breezy-jumping-fountain.md`.

## Commits + PRs

| Hash | Title |
| --- | --- |
| `7019344` | docs(EC-005): document liquidation-fallback mechanics in AUG + FAQ + Risk-Disclosures cross-link → PR #17 |
| `333c746` | feat(EC-003 Phase 1): FallbackPending loans become a valid leg in triggerInternalMatchLiquidation → PR #18 |

## Operational

- **No production behaviour change** from either PR independently. EC-005 is docs-only. EC-003 Phase 1 widens an entry-point gate but the keeper bot's existing detector (filtered to `Active` only) won't surface FallbackPending candidates until Phase 4 wires them in. The contract is ready; the off-chain dispatcher catches up in Phase 4.
- **Audit story** — Phase 1 adds one new lifecycle edge to the existing `LibLifecycle` allow-list, two new errors, two new helpers (`_assertOraclePriceable`, `_rehydrateFallbackEscrowIfNeeded`), and one new piece of post-settlement housekeeping. Storage shape unchanged. No migration risk. The `_isLegal → _isValid` rename is mechanical inside one file with no external consumers.
- **Cross-references**:
  - [`docs/internal/OffchainDataFetchAudit-2026-05-15.md`](../internal/OffchainDataFetchAudit-2026-05-15.md) — the C.1 audit doc whose closure narrative led to EC-003.
  - `~/.claude/plans/breezy-jumping-fountain.md` — the user-approved EC-003 implementation plan (all 4 phases).
