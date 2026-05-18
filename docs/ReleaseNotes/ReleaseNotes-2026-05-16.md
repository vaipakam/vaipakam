# Release Notes — 2026-05-16

A full day across several threads. Most address gaps the C.1 audit thread surfaced when it closed the previous evening: a documentation surface for the liquidation-fallback mechanics (which the consent-flow polish deliberately pulled out of the Risk Disclosures), and a deeper rework that lets internal-match rescue stuck `FallbackPending` loans whose at-fallback liquidation failed transiently — that rework shipped end-to-end today as EC-003 Phases 1-4, plus the EC-007 partial-match fix its own audit surfaced. Separately, T-600 builds the treasury-management and founder-compensation contract layer.

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

## EC-003 Phases 2-4 — internal-match auto-dispatch (shipped)

Phases 2-4 all merged the same day, each standalone.

**Phase 2 — asset-pair index + candidate view (PR #19).** Adds a
per-(principal asset, collateral asset) index of matchable loans to
protocol storage — a loan is added at initiation and removed when it
reaches a terminal status; the Active ↔ FallbackPending transition
deliberately keeps a loan in the index, since FallbackPending loans stay
matchable. On top of the index sits a new read-only view that, given a
loan, scans the opposing-direction list and returns the first
counterparty loan that passes a status gate and an oracle-priceability
gate. Its cost is bounded by the number of loans in that exact asset
pair, not by every active loan — the property the Phase 3 auto-dispatch
depends on. The storage fields are appended, so there is no slot shift
and no migration risk.

**Phase 3 — auto-dispatch from every liquidation entry-point (PR #21).**
Wires that candidate view into all three liquidation entry-points —
HF-based liquidation, time-based default, and the claim-time
lender-claim path. Each now, before falling through to the external swap
aggregator, checks for an internal-match candidate; on a hit it settles
the loan against the opposing counterparty at oracle price (zero
aggregator slippage); on a miss it falls through unchanged. The
claim-time branch is not redundant with the keeper bot: the candidate
pool grows between a keeper tick and a lender's claim, so claim-time
dispatch is a genuine second rescue window. Phase 3 also added an
LTV-floor gate to the candidate view, so auto-dispatch can never
force-liquidate a *healthy* counterparty (FallbackPending candidates
skip the check — they are past the threshold by definition). One
review-caught detail: the 1% matcher incentive must reach the real
caller of the dispatching entry-point, but auto-dispatch reaches
settlement through an internal call where that caller's identity is
lost — so the caller address is now threaded explicitly through the
settlement path, and the incentive reaches the triggering keeper or
lender rather than stranding on the Diamond.

**Phase 4 — keeper bot + docs (PR #22).** The no-contract-change closing
phase: the keeper bot's loan-scan filter is widened from Active-only to
Active + FallbackPending so FallbackPending rescue candidates surface; a
"Pre-claim internal-match rescue" subsection is added to the Advanced
User Guide's liquidation section; the FAQ is extended; and a new
external-auditor addendum catalogues every invariant the EC-003 feature
introduced. Closes [#12](https://github.com/vaipakam/vaipakam/issues/12).

## EC-007 — partial-match FallbackPending residual claimability (PR #24)

The EC-003 Phase 4 audit addendum flagged that only the *full*-match
path had end-to-end coverage. Investigation found the partial-match path
was not merely uncovered but broken. EC-003 Phase 1 settled
FallbackPending legs by *rehydration* — pushing the loan's full
collateral back into the *borrower's* escrow so the existing settlement
machinery ran unchanged. That worked for a full match, but after a
*partial* match the unmatched residual was left sitting in the
borrower's escrow — while a lender claim withdraws from the *lender's*
escrow. A lender claiming the residual of a partially-matched
FallbackPending loan hit a revert.

EC-007 replaces rehydration with status-aware settlement: a
FallbackPending leg's collateral is now moved directly from the
Diamond's own custody, while an Active leg still withdraws from the
borrower escrow as before. FallbackPending collateral stays in the
Diamond for the whole FallbackPending span; on a partial match only the
matched portion leaves and the scaled residual stays put, resolvable by
a later match or claim. Review then surfaced two more issues fixed in
the same PR: a claim-time *full* internal match left the caller falling
through into a now-empty claim record and reverting "nothing to claim"
— which rolled back the successful match — fixed by returning early on a
fully-resolved match; and that early return initially sat *before* the
lender-NFT ownership check, briefly making a name-gated claim function
permissionless (any caller could trigger the match purely to skim the
matcher bonus) — fixed by hoisting the ownership and already-claimed
guards to the top of the claim path. No contract-signature, ABI, or
storage changes. Closes [#23](https://github.com/vaipakam/vaipakam/issues/23).

## Commits + PRs

| Hash | Title |
| --- | --- |
| `7019344` | docs(EC-005): document liquidation-fallback mechanics in AUG + FAQ + Risk-Disclosures cross-link → PR #17 |
| `333c746` | feat(EC-003 Phase 1): FallbackPending loans become a valid leg in triggerInternalMatchLiquidation → PR #18 |
| `eb82ddf` | feat(EC-003 Phase 2): asset-pair index + hasInternalMatchCandidate view → PR #19 |
| `7459b52` | feat(EC-003 Phase 3): auto-dispatch internal-match from every liquidation entry-point → PR #21 |
| `836cd80` | docs(EC-003 Phase 4): keeper-bot enable + AUG/FAQ + audit addendum → PR #22 |
| `1552527` | fix(EC-007): partial-match FallbackPending residual claimability → PR #24 |

## Operational

- **EC-003 + EC-007 — the full internal-match rescue funnel shipped today.** EC-005 is docs-only. EC-003 Phase 1 widened the entry-point gate; Phases 2-4 added the asset-pair index, auto-dispatch from every liquidation entry-point, and the keeper-bot + docs; EC-007 then fixed the partial-match claim revert that the Phase 4 audit surfaced. Net on-chain effect: HF-liquidation, time-default, and lender-claim now all attempt an internal match (oracle-priced, zero aggregator slippage) before falling through to the external swap, and FallbackPending loans are valid rescue legs throughout. Storage shape unchanged across all four phases + EC-007; no migration risk.
- **Audit story** — Phase 1 adds one new lifecycle edge to the existing `LibLifecycle` allow-list, two new errors, two new helpers (`_assertOraclePriceable`, `_rehydrateFallbackEscrowIfNeeded`), and one new piece of post-settlement housekeeping. Storage shape unchanged. No migration risk. The `_isLegal → _isValid` rename is mechanical inside one file with no external consumers.
- **Cross-references**:
  - [`docs/internal/OffchainDataFetchAudit-2026-05-15.md`](../internal/OffchainDataFetchAudit-2026-05-15.md) — the C.1 audit doc whose closure narrative led to EC-003.
  - `~/.claude/plans/breezy-jumping-fountain.md` — the user-approved EC-003 implementation plan (all 4 phases).

---

## T-600 — Treasury conversion + founder compensation

Branch `feat/t600-treasury-founder-comp`. Builds the contract layer for
`docs/DesignsAndPlans/TreasuryAndFounderDistribution.md` — turning the
treasury from a passive fee-accumulator into a managed treasury, and
giving the (solo, so-far-unpaid) founder a reliable, securities-sound
income path.

**What it adds, functionally:**

- **Treasury conversion** — an admin (later timelock / governance) can
  convert one accumulated fee asset into the protocol's reserve assets
  in a single call. The reserve set is a fully governance-configurable
  target-allocation list — an ordered set of `(asset, %)` entries that
  governance can add to, remove from, or re-weight via one atomic
  setter (always validated to sum to 100%). The swap routes through the
  existing liquidation aggregator infrastructure; output stays inside
  the protocol's own custody. An eligibility gate (a value threshold OR
  a max interval) stops both dust-sized conversions and treasury
  stagnation.
- **Founder salary stream** — a new payroll facet pays a founder (or any
  contributor) a continuous, per-second salary from the treasury. The
  rate is set by a governance budget decision and is revisable; the
  stream must be deliberately topped up each budget period and a
  withdrawal can never exceed what was funded. This makes it a *salary*
  — compensation for work — and structurally NOT an automatic cut of
  user fees (the pattern that carries securities risk and that the
  design doc explicitly rejected). A regression test asserts no code
  path links fee accrual to salary funding.
- **Vesting wallet** — a cliff + linear vesting wallet contract for
  genesis grants (founder, team hires, early contributors, the new
  ecosystem/marketing pool), one instance per grantee.

**Tokenomics doc reconciliation** — the allocation table gains a 2%
Ecosystem / Community / Marketing line (funded by trimming Exchange
Listings & Market Making 14% → 12%) as a pre-revenue launch-marketing
bridge; a new semantics section clarifies that the non-founder people
pools are reserved mint headroom that never reverts to the founder.

**Legal gating** — the contract code is built and test-covered now, but
the genesis funding actions (minting grants, starting a real salary
stream) remain gated on a securities-lawyer sign-off before TGE; the
founder-vesting deploy script bakes that gate in.

Full suite green: 1979 passed / 0 failed / 5 skipped (19 new T-600
test cases).
