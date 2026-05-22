# Release Notes — 2026-05-21

Thirteen threads in this batch — they form the **canonical-limit-
order Phase 1 wave** alongside a CI / docs consolidation pass. The
order-shape work shipped end-to-end (#163's ADR-0010 locking the
min/max field semantics, #164 adding the borrower-side collateral
range with clamp-up semantics, #102 lifting the borrower-side
single-fill rule so symmetric range-matching is real, #165 turning
the matching shape into a canonical limit-order UI on offer-create,
#173's matchOffers test scaffold + the seven scenario coverage that
locked the matching behaviour, and #172 fanning out the keeper to
match-aware borrowers). #124 surfaced offer-grouped loans on the
Dashboard so a user with multiple matches against the same offer
sees them as one position. In parallel, the CI / docs consolidation
arc continued — #158 folded CodeQL into `ci.yml` (the last
cross-workflow forge race resolved), #169 folded `Build docs` into
the same workflow, two follow-ups serialised the contracts jobs and
made `contracts-full` a conditional required check, #148 phase 5
closed the deferred Slither set, and a follow-up to #181 / #177
landed a high-contrast WIP banner on the public NatSpec docs site
to flag the LayerZero-content drift while #181's scrub was in
flight (the banner has since been retired — see the 2026-05-22
notes).

## Thread — Borrower partial-fill ends the Phase 1 single-fill rule (PR #<n>)

Closes #102. Lifts the borrower-side single-fill rule end-to-end so the
canonical limit-order semantic ADR-0010 locked in is honoured by the
contract, not just in the UI label.

Pre-#102, a borrower offer of "borrow $1k-$10k locking up to 2 ETH"
matched once at midpoint and immediately closed via
`B.accepted = true` — the unused range was destroyed. Post-#102, the
same offer is consumed progressively across multiple lender matches
until the remaining capacity falls below the borrower's per-match
minimum, at which point it auto-closes with the residual collateral
refunded to the borrower's wallet.

### Storage shape (no new fields — uses #164's append)

- `Offer.collateralAmountFilled` (slot 19, added by #164 for
  forward-compat) starts being WRITTEN per match. Pre-#102 it stayed
  at the storage default; post-#102 it accumulates symmetrically with
  the lender-side `amountFilled`.
- No new storage fields. No migration concerns.

### What changes (contract surface)

- `LibRiskMath.maxLendingForLtvCap(collateral, principal, collat, capBps)`
  — new helper, sibling of `minCollateralForLtvCap`. Takes the
  effective init-LTV cap explicitly. The GTC default's borrower
  `amountMax = 0 → derived` fallback (ADR-0010 §3) uses this helper.
- `LibOfferMatch.previewMatch` — uses `borrowerRemaining =
  effBorrowerAmountMax - B.amountFilled` symmetric to the lender side;
  applies the `0 ⇒ derived` fallback for borrower's `amountMax`
  using `maxLendingForLtvCap(collateralAmountMax, init-LTV cap)`.
- `OfferAcceptFacet._acceptOffer` — defers `offer.accepted = true`
  on the borrower side when (matchOffers-driven path + borrower offer
  + `partialFillEnabled` on). Single-match `acceptOffer`, lender
  offers, and partial-fill-off paths keep their immediate flip.
- `OfferMatchFacet.matchOffers` — symmetric borrower-side post-match
  accounting:
  - Increments `B.amountFilled` + `B.collateralAmountFilled` per
    match.
  - Auto-closes on dust (`remaining < B.amount`); refunds residual
    collateral; emits `OfferClosed(borrowerOfferId, Dust)`.
  - The per-match collateral refund hook (added in #164) is now
    gated on `!partialFillEnabled` — under partial-fill the
    borrower's pre-escrowed collateral stays in custody until
    dust-close.
- `OfferCreateFacet._emitOfferCreatedDetails` — applies the
  `0 ⇒ derived` collapse for borrower's `amountMax` so the event
  payload always carries the LOGICAL ceiling (ADR-0010 §3 mandate).
- `DeployDiamond.s.sol` — fresh deploys now flip the four GTC master
  flags ON post-init (`rangeAmountEnabled`, `rangeRateEnabled`,
  `rangeCollateralEnabled`, `partialFillEnabled`). Contract storage
  defaults stay `false` (audit-safe convention); the deploy script
  is the canonical enablement step. Operators that want a
  conservative bake on a brand-new chain can comment those four
  lines out and call the setters manually after a review window.

### Kill-switch decision — Option A (single flag, both sides)

`partialFillEnabled` now governs both sides symmetrically. There's no
scenario where one side's partial-fill should be enabled independent
of the other — splitting into per-role flags would have added
governance surface without operational benefit. (Confirmed in the
#102 design discussion against `borrowerPartialFillEnabled` as
Option B.)

### LIF pro-ration — non-issue

Each match against a single borrower offer mints a separate `Loan`
with its own `loanId` and its own `borrowerLifRebate[loanId].vpfiHeld`
slot. The per-loan accounting structure already handles N loans per
offer naturally — no cross-match LIF bookkeeping needed.

### Cancel-cooldown — already symmetric

`OfferCancelFacet.cancelOffer`'s cancel-cooldown
(`partialFillEnabled && amountFilled == 0 && createdAt + delay >
block.timestamp`) was already applied to both sides; it just becomes
load-bearing on the borrower side now that the matcher actually
reaches into borrower amounts more than once.

### Verification

- `forge build` clean (warnings only)
- `forge test --no-match-path "test/invariants/*"` → 2012 / 0 / 5
  (legacy paths preserved bit-for-bit)
- ABI re-export — no selector changes (per-function-body changes
  only); only `packages/contracts/src/abis/_source.json` stamp moves.
- Multi-package typechecks clean (apps/defi + indexer + keeper)

### Dedicated test coverage — separate follow-up

There is no existing test infrastructure for `OfferMatchFacet.matchOffers`
or `LibOfferMatch.previewMatch` (the five `InternalMatch*.t.sol` files
cover the internal-liquidation match, a different feature). The
legacy regression validates that `partialFillEnabled = false` keeps
existing behaviour exactly. The new partial-fill ON path is **not
exercised by the current suite**. Filed as
[#173](https://github.com/vaipakam/vaipakam/issues/173) — dedicated
test infrastructure for matchOffers + previewMatch + borrower
partial-fill paths.

### Downstream

- [#165](https://github.com/vaipakam/vaipakam/issues/165) — frontend
  GTC UI is unblocked; no "single-match" warning needed for borrower
  offers anymore.
- [#172](https://github.com/vaipakam/vaipakam/issues/172) —
  `apps/keeper` matcher pass updated to seek borrower partial-fill
  opportunities; `vaipakam-keeper-bot` public reference repo follows
  the same pattern.

## Thread — Offer-grouped loans view on the Dashboard (PR #<n>)

Closes #124. When a single offer fans out into multiple loans (range
orders, partial fills), the Dashboard previously showed those as N
orphaned rows in the flat "My Loans" table. A lender who posted one
offer for $100k accepting borrowers in 5-25% LTV slices would see
their offer turn into 4-7 child loans — and have no visible link
back to the originating offer.

This PR adds an **Offer-grouped section** above the flat loans table
that surfaces only when there's at least one fan-out (≥2 children
from one offer). Each fan-out renders as a card with:

- Cross-link to `/offers/:offerId` so the user can see the original
  offer terms alongside what got filled.
- **Total filled amount** (SUM across children, in the principal
  asset's native units — no cross-asset normalisation since the
  hook doesn't have prices).
- **Weighted-average interest rate** by filled amount —
  `Σ(rate × amount) / Σ(amount)`. The card spec's "My take" block
  called this out specifically: plain `mean(rates)` is misleading
  when child loans have different fill sizes. A $1k fill at 10% APR
  plus a $99k fill at 5% APR is not a 7.5% effective rate — it's
  5.05%. The hook computes the right number; the test file pins
  the example to lock the math.
- **Minimum HF** across **active** children (terminal loans don't
  carry liquidation risk anymore so they're excluded). The card
  spec emphasised MIN not mean because showing an average HF would
  lull the user into false safety — the worst child governs the
  group's risk.
- **Collateral per-asset bucket** — one row per collateral type. An
  offer accepting multiple collateral assets gets one collateral
  row per asset rather than a dollar-sum the hook can't compute.
- **Status counts** (active / repaid / defaulted / settled / etc.)
  alongside the total child count.
- **Expand toggle** revealing each child loan as a compact inline
  row with the standard "View" CTA.

Single-child offers (the common case) deliberately stay in the flat
table only — rendering them in both the group section and the flat
table would duplicate the row.

What this PR does NOT include (acknowledged in the hook's doc
block, slot reserved for the data-source follow-up):

- **Interest accrued so far** per group — needs per-loan
  `getLoanDetails` data that LoanSummary doesn't currently carry.
- **Fees collected** (yield-fee + LIF) per group — same.
- **Fill percentage** (Σ filled / `offer.amountMax`) — needs the
  parent offer's `amountMax` from offer storage, fetched via a
  follow-up `useOffersByIds` hook.

A pure-function vitest suite in `useOfferGroupedLoans.test.ts`
pins the load-bearing aggregations (weighted-avg rate, MIN HF,
per-asset collateral bucket, per-status counts, sort order). The
test won't run in CI today — `pnpm -r test` is intentionally
off the required-check workflow pending Issue #85's
test-setup-failure resolution — but documents the contract for
when the test infrastructure comes back.

Pure frontend change: no contract change, no facet rename, no
deployments-sync. Sets up #126 (batch ops on offer-grouped loans)
which needs the grouped-view primitive as its UI starting point.

## Thread — Close the deferred Slither set: write-after-write, dead-code, assembly, missing-zero-check (PR #<n>)

Final phase of issue #148's Code Scanning queue triage. Phase 2 (PR
#150) closed the 6 surviving HIGHs. Phase 3 (bulk gh-api) dismissed
381 alerts across 6 rule classes. Phase 4 (PR #155) added 3 in-source
suppressions on the highest-value security signals (Pyth gates +
Chainlink Feed Registry) and bulk-dismissed 119 more alerts across 8
lower-risk rule classes. Phase 5 — this PR — handles the 42 alerts
intentionally deferred from Phase 4 because they needed real per-site
review.

The deferred set split four ways. The two `write-after-write` alerts
on `RepayFacet.autoDeductDaily` both flag the same `ok` local being
re-assigned across three best-effort cross-facet cleanup calls
(escrow renter reset + two NFT-status updates). The reuse is
intentional — every cleanup is non-critical (the inline comments mark
them so), independent of the others, and the loan still transitions
to Repaid at the end of the block regardless of cleanup outcome.
Added two `// slither-disable-next-line write-after-write` directives
before the second and third assignments, with a paragraph-long
rationale block above the first call explaining why the shared `ok`
is right and what would trigger replacing it with per-call locals.

The five `dead-code` findings were genuinely orphaned helper
functions left behind by earlier refactors. Each gets DELETED here,
not suppressed:

- `PartialWithdrawalFacet._simulateHF` + `_simulateLTV` — replaced by
  the unified `_loadValuationContext` + per-iteration inline loop
  body. Source comment at line 161 ("Previously each iteration called
  `_simulateHF` + `_simulateLTV`...") confirmed the refactor history.
- `VaipakamNFTFacet._isClosedStatus` — every call site was inlined to
  compare the status enum directly. The test file still references it
  in comments (since-stale doc), but the tests themselves go through
  the public `tokenURI` surface and continue to pass.
- `RiskFacet._getZeroExProxy` + `_getAllowanceTarget` — leftovers from
  the pre-Phase-7a 0x-direct liquidation path that was replaced by
  the 4-DEX adapter pattern (`AggregatorAdapterBase` + per-aggregator
  adapters). Live paths now read `zeroExProxy` / `allowanceTarget`
  via `LibVaipakam.storageSlot()` at each call site.

The 14 `assembly` findings and 21 `missing-zero-check` findings both
get bulk-dismissed via `gh api PATCH state=dismissed` with rule-class
rationale (the comments fit GitHub's 280-character `dismissed_comment`
limit). Every assembly site is a canonical EVM-low-level pattern —
Diamond storage-slot lookups (`LibVaipakam.storageSlot`,
`LibAccessControl._storage`, `GuardianPausable._getGuardianStorage`),
the Diamond fallback router (`VaipakamDiamond.fallback`), and bytes-
data returndatasize manipulation (`LibRevert.bubbleOnFailure`,
`LibERC721._checkOnERC721Received`, `VpfiBuyReceiver._decodeFailReason`).
Every missing-zero-check site is on a function gated by
`onlyDiamondInternal` — only sibling Diamond facets call them, never
user input, and the addresses passed (`loan.borrower`, `loan.lender`,
`recipient` from `loan.recipient`, etc.) are storage-sourced and
validated at write time. Defense-in-depth zero-checks would duplicate
the upstream guards.

After this PR lands the Code Scanning queue drops from ~42 open
Slither alerts to **0**. The two CodeQL alerts that remain (medium-
severity JavaScript findings) are tracked separately as #148's tail
work. Closes #148.

## Thread — Fold CodeQL into ci.yml (closes #158)

Continuation of PR #157's compute-saving theme. PR #157 folded
`gas-snapshot.yml` + `slither.yml` into `ci.yml` and added a
fail-fast gate so `contracts-fast` `needs: workspaces`. The card #158
filed at that time tracked the same fold for CodeQL — and this PR
does it.

`.github/workflows/codeql.yml` is **deleted**. Its `analyze` job
moves into `ci.yml` as a new `analyze-jstypescript` job (matrix
flattened to the single `javascript-typescript` language; same
`security-extended` query pack, same `paths-ignore` config, same
SARIF upload to the Security → Code scanning surface). The job runs
on every PR — matching the pre-fold `codeql.yml` behaviour which had
no path filter. CodeQL walks JS/TS repo-wide (root tsconfig, root
scripts, `.github/codeql/` configs), so gating on the workspaces
path-filter would have introduced a regression Codex caught on round-1.

`contracts-fast` now `needs: [detect-changes, workspaces,
analyze-jstypescript]` for sequencing — analyze-jstypescript must
finish before contracts-fast starts so they don't race for runner
minutes — but the `if:` condition only short-circuits on a
`workspaces` failure, NOT on an analyze-jstypescript failure. Reason:
`workspaces` is a Protect-main required check, so its red blocks
merge directly even when contracts-fast auto-skips. analyze-
jstypescript is NOT required — if we used it to gate contracts-fast,
a CodeQL failure would auto-skip contracts-fast and branch
protection would treat the skipped required check as SUCCESS,
making the PR mergeable with no forge build run. That's the safety-
vs-compute trade-off Codex round-2 caught (P1 finding on this PR).
The `!cancelled()` prefix on the `if:` lets contracts-fast still run
when the gate jobs are skipped (contracts-only PR — the path-filter
excludes workspaces).

CodeQL's weekly cron survives the move. The original `codeql.yml`
carried a `schedule: '17 6 * * 1'` (Mondays 06:17 UTC) safety scan;
that schedule is now on `ci.yml` itself, and `detect-changes` was
taught to treat `schedule` (and `workflow_dispatch`) events as
"everything changed" so the full graph runs weekly against main. The
recurring cost — ~25 min of CI on Mondays for the full pipeline — is
a deliberate trade for the audit safety net (catches CodeQL-pack
drift, submodule pin drift, and dep-bump-triggered failures between
commit-driven runs).

Top-of-file `ci.yml` permissions extended to add `security-events:
write` (for CodeQL's SARIF upload, same right Slither already needs)
and `actions: read` (required by `github/codeql-action/analyze`).

After this PR merges the Actions tab no longer has a separate
`CodeQL` workflow — its run appears as a job inside `ci`. The
Protect main ruleset doesn't reference CodeQL by name (only
`contracts-fast`, `workspaces`, `detect-changes` are required), so
no ruleset update is needed.

## Thread — ADR-0010: Canonical limit-order semantics for Offer min/max fields (PR #<n>)

Closes #163. Records the decision around how the frontend maps user
intent into the contract's min/max range fields on the `Offer` struct
— what an implementer would otherwise have to reverse-engineer from
the contract code and the existing range-orders design doc.

### What this PR ships

- **`docs/adr/0010-canonical-rate-semantics.md`** — new ADR documenting:
  - The role-asymmetric mapping table (lender = ceiling, borrower =
    floor for their headline numbers; the other side of each pair is
    either pre-escrowed by the role that holds the asset or derived at
    match-time from the counterparty's offer).
  - LTV and HF are derived guidance only, never user input. Frontend
    renders color-coded risk indicators inline.
  - The borrower's `amountMax = 0` symmetry — single-value with
    match-time derivation from `collateralAmountMax × loanInitMaxLtvBps`,
    mirroring the lender-side collateral pattern that #164 already
    established. SSTORE skipped per the #169 optimisation pattern.
  - `loanInitMaxLtvBps` stays **live-at-match** (Option A from session
    discussion) rather than snapshotted on the Offer struct.
    Documented as asymmetric with `liquidationLtvBpsAtInit` (which IS
    snapshotted on `Loan`), with the rationale that init max LTV is
    an admission criterion that the AutonomousLtvAndOracleFallback
    Phase 5 design wants responsive, whereas the liquidation
    threshold is a lifetime risk envelope that must be immutable per
    loan.
  - The 1-wei placeholder on lender's `amount` — artifact of the
    contract's `params.amount > 0` invariant. Documented for auditor
    clarity; future cleanup gated on the storage repack audit (#20).
  - **Borrower partial-fill (#102) is the load-bearing dependency**
    for the frontend GTC implementation (#165). The mapping table
    only honours user intent in the contract if borrower offers can
    be incrementally consumed across multiple lender matches; #102
    lifts the Phase 1 single-fill rule. #165 cannot ship the GTC UI
    honestly until #102 lands.

- **`docs/DesignsAndPlans/RangeOffersDesign.md` §17** — design-doc
  companion section that an implementer reading the range-orders
  spec encounters first. Cross-references the ADR for the full
  rationale; surfaces the mapping table + the load-bearing
  invariants in the same document family as §16's borrower-side
  collateral range coverage.

- **`docs/adr/README.md`** — ADR index updated to include ADR-0010.

### Why this is documentation-only

The contract's storage layout doesn't change. The match math doesn't
change. No code is touched by this PR. The artefact is the **decision
lock** — once merged, every downstream implementation (#102 contract
work; #165 frontend GTC UI; future SDK / indexer migrations) references
ADR-0010 as the source of truth for what each field means at the user
layer.

### Why now (not later)

The user-facing semantic is currently implicit. PRs #167 (#164) and
#170 (#169) both made design choices (pre-escrow shapes, SSTORE-skip
patterns, indexer-friendly event payloads) that depend on a clear
mapping between user intent and contract storage. Locking that mapping
in an ADR now means #102 and #165 don't re-litigate it during
implementation. Without this artefact, the next implementer would
reverse-engineer the same decisions from `OfferCreateFacet` / `LibOfferMatch`
/ `OfferCancelFacet` reading patterns, which is exactly the
git-archaeology cost ADRs exist to eliminate (per `docs/adr/README.md`'s
"Why these exist" section).

### What this PR does NOT do

- Does not implement borrower partial-fill — that's #102, the
  load-bearing contract dependency this ADR makes explicit.
- Does not ship any frontend changes — that's #165, depending on #102.
- Does not introduce any contract storage migration. ADR-0010
  specifically rejects (Alternative A1) the option of snapshotting
  `loanInitMaxLtvBps` on the Offer struct.
- Does not relax the `amount > 0` contract invariant or remove the
  1-wei placeholder — deferred to the storage repack audit (#20).

### Round-1 Codex corrections (folded in before merge)

Codex round-1 surfaced three P2s in the first draft of ADR-0010 — all
real, all corrected in the same PR:

1. **Double-LTV-cap in the borrower `amountMax` derivation** —
   `maxLendingForCollateral` already incorporates an LTV cap
   internally; the original pseudocode multiplied by
   `loanInitMaxLtvBps / BASIS_POINTS` again. Corrected to reference a
   new `LibRiskMath.maxLendingForLtvCap(cap)` helper (a sibling of
   the existing `minCollateralForLtvCap`) that #102 will add — single
   cap applied inside the helper.
2. **Tier-capped vs. init-only LTV** — `LibRiskMath.maxLendingForCollateral`
   uses tier LIQUIDATION LTV (post-creation safety threshold), not the
   init-LTV cap admission consults (`min(loanInitMaxLtvBps, tierCap)`).
   Reusing it would advertise borrower capacity above what admission
   allows. ADR now specifies the new `maxLendingForLtvCap` helper +
   the cap derivation pattern that mirrors `previewMatch`'s existing
   synthetic-init-gate block.
3. **Worked example dust-close math** — the example incorrectly said
   the borrower's offer "stays open" then "closes via dust-close"
   after the same fill. Corrected: at first fill, remaining `1_625 >
   floor 500` → STAYS OPEN; a hypothetical second fill that drains
   remaining below `500` would trigger dust-close per the symmetric
   extension of the lender-side pattern.

## Thread — Borrower-side collateral range on offers (PR #<n>)

Closes #164. Range Orders Phase 1 (PR #46) added lender-side ranges on
the lending **amount** and **interest rate**, and threaded those through
the matching core (`previewMatch` / `matchOffers`). The third axis — the
**borrower-side collateral** — stayed single-value. So a borrower who
wanted to express *"I'll lock between 1.0 ETH and 2.5 ETH against this
borrow, match me to whatever loan fits in that range"* had no way to do
it on-chain. This release adds the missing axis.

### What changes

**Offer storage** grows two append-only fields (slots 18, 19 of the
`Offer` struct):

- `collateralAmountMax` — borrower's upper bound on what they'll lock.
  Zero at create-time auto-collapses to `collateralAmount`, so every
  legacy single-value caller behaves byte-for-byte the same as before.
- `collateralAmountFilled` — cumulative collateral consumed across all
  matches against this offer. Borrower-side partial fills are NOT
  enabled in Phase 1 (mirrors `amountFilled`), so this field stays 0
  across all Phase 1 borrower matches. Wired in now so #102 (borrower
  partial-fill) can start writing without another storage migration.

**Match semantics — single-value preserved, clamp-up only on real
ranges.** Per Codex round-1 P1, the two cases are branched explicitly:

- **Single-value / legacy borrower offer** (`collateralAmountMax ==
  collateralAmount`, OR `collateralAmountMax == 0` for a pre-#164
  storage row): pre-#164 semantic exactly. Locked collateral equals
  the lender's pro-rated requirement; OfferMatchFacet refunds the
  overage. Borrower UX expectation ("I posted X and the protocol
  locks what's actually needed up to X") is preserved bit-for-bit.

- **Real ranged borrower offer** (`collateralAmountMax >
  collateralAmount`): clamp the locked amount UP to the borrower's
  min so a borrower who committed AT LEAST X gets at least X locked
  (better HF cushion, lender happy). Mirrors how amount overlap
  works today (`lo = max(L.amount, B.amount)` — both sides' minimums
  constrain the floor together). Match fails only when the clamped
  value exceeds the borrower's remaining ceiling.

Round-1 review also surfaced a fund-lock regression on the cancel path
(borrower had escrowed `collateralAmountMax` but
`OfferCancelFacet.cancelOffer` was still withdrawing
`collateralAmount` — the `max - min` tail would have been trapped on
cancellation of a ranged offer). Fixed in round-2 so the cancel-side
refund mirrors the create-side pre-escrow. Same legacy-fallback
(`collateralAmountMax == 0 ⇒ collateralAmount`) applies to the
OfferMatchFacet excess-refund hook as well, so a hypothetical
post-deploy upgrade onto live storage with pre-#164 offers can't trap
their collateral on the first match.

**Lender side stays single-value** on collateral. The lender's
`collateralAmount` slot is their derived requirement (at `amountMax`,
pro-rated to the matched amount); a max wouldn't add operational
meaning. `createOffer` rejects a lender offer with
`collateralAmountMax > collateralAmount` via
`LenderCollateralRangeNotAllowed`, independent of the master flag.

**Borrower asset pre-escrow** now pulls `collateralAmountMax` (the
upper bound) at create-time instead of `collateralAmount`. The
existing OfferMatchFacet excess-refund hook returns the unused tail to
the borrower's wallet at match-time — same pattern the lender-side
amount range already uses for partial-fill leftovers. On a legacy
single-value borrower offer (auto-collapsed `collateralAmountMax ==
collateralAmount`), the pulled amount and the refund both land at the
same numbers as the pre-#164 implementation, byte-for-byte.

**Master kill-switch** — `rangeCollateralEnabled` on `ProtocolConfig`
defaults `false` on a fresh deploy. While off, `createOffer` enforces
the legacy single-value collateral shape (rejecting `collateralAmountMax
> collateralAmount` with the typed `FunctionDisabled(4)` so the
frontend validator can surface a precise "feature disabled" hint
distinct from the amount/rate flags). Governance flips it via
`ConfigFacet.setRangeCollateralEnabled(true)` after the testnet bake.

### Why now — sequencing for #102

[#102](https://github.com/vaipakam/vaipakam/issues/102) (borrower
partial-fill) lifts the Phase 1 single-fill rule and lets one borrower
offer back multiple loans. That work needs `collateralAmountFilled` to
exist as load-bearing storage from match #2 onwards. Landing the field
+ the storage layout NOW — even while no Phase 1 code reads it — keeps
#102 a pure behaviour change rather than a behaviour + storage change.
Same reason `amountFilled` shipped with Phase 1 even though Phase 1's
single-fill rule meant no one wrote to it on the borrower side either.

### What's intentionally NOT in this PR

| Slot | Why deferred |
|---|---|
| Borrower partial-fill enablement | #102 — lifts the single-fill rule and starts writing `collateralAmountFilled` |
| Frontend `CreateOffer` collateral-range input | #165 — basic/advanced mode parity (queued after #164) needs the same UI surface for all three fields together |
| Match-flow integration test for the clamp-up path | No existing test covers `previewMatch` / `matchOffers` directly; that's a parallel infra gap. This PR ships unit-level createOffer-side coverage; the match-time clamp is exercised end-to-end via the existing OfferFacet integration coverage once the kill-switch is on testnet. |

### Mainnet-deploy gate

The master flag stays `false` on testnet through the bake. When
governance flips `setRangeCollateralEnabled(true)`, the new mechanic
becomes reachable; until then every offer behaves exactly like the
pre-#164 contract.

## Thread — Canonical limit-order UI on the offer-create form (Phase 1 of #165) (PR #<n>)

Closes the implementation half of [#165](https://github.com/vaipakam/vaipakam/issues/165), Phase 1: pure frontend. The contract already supports the canonical limit-order semantic via #102's borrower partial-fill + #164's collateral range + Phase 1's amount/rate range. This PR makes the offer-create UI on `apps/defi` actually USE that semantic.

### What changes

The form on `CreateOffer.tsx` now presents role-asymmetric headline numbers per [ADR-0010 §17.1](https://github.com/vaipakam/vaipakam/blob/main/docs/adr/0010-canonical-rate-semantics.md). One input per field; the user enters the bound that matters from their side; `toCreateOfferPayload` routes it into the contract's `amount` / `amountMax` / `collateralAmount` / `collateralAmountMax` / `interestRateBps` / `interestRateBpsMax` floor/ceiling fields per the mapping table.

| Side | Field | What the user sees | What the contract gets |
|---|---|---|---|
| Lender | Amount | "Lend up to (tokens)" | `amount = 1 wei`, `amountMax = X` (pre-escrowed) |
| Lender | Rate | "At minimum interest rate (APR %)" | `interestRateBps = P×100`, `interestRateBpsMax = 10_000` (= MAX_INTEREST_BPS) |
| Lender | Collateral | "Require at least (collateral)" | `collateralAmount = Z` (single-value per #164 lender invariant) |
| Borrower | Amount | "Borrow at least (tokens)" | `amount = Y`, `amountMax = 0` (contract derives from collateral × init-LTV cap) |
| Borrower | Rate | "At maximum interest rate (APR %)" | `interestRateBps = 0`, `interestRateBpsMax = Q×100` |
| Borrower | Collateral | "Lock up to (collateral)" | `collateralAmount = 0`, `collateralAmountMax = W` (pre-escrowed) |

### What's removed / hidden

The Advanced-mode dual min/max input row (the previous way users expressed a range — separate "Min" and "Max" inputs visible only in Advanced mode and only when governance had flipped the relevant master flag) is **forced hidden**. The form-state fields `amountMax` / `interestRateMax` / `collateralAmountMax` remain in `OfferFormState` for backwards-compat with any deep-linked URL that still carries them, but `toCreateOfferPayload` ignores them under the canonical-GTC mapping.

### What's added

- `offerSchema.ts`'s `toCreateOfferPayload` now implements role-asymmetric translation. Single-source-of-truth for the mapping; consumers (frontend form submit, future SDK clients) get the same translation by going through this function.
- `MAX_INTEREST_BPS = 10_000` mirrored from `LibVaipakam.MAX_INTEREST_BPS`. Documented inline.
- 12 new i18n keys (6 per role across 10 locales) for the role-asymmetric labels. Style follows each locale's existing `amountMin` / `amountMax` precedent.

### What stays in `OfferFormState` (for now)

`amountMax` / `interestRateMax` / `collateralAmountMax` remain as form-state fields. Three reasons:

1. **Deep-linked URLs from before this PR** carry them in their state shape; removing the type fields would cause runtime errors when those URLs deserialize.
2. **Phase 2 of #165 (a follow-up)** will add live LTV/HF risk indicators (green/yellow/orange/red zones per ADR-0010 §17.2). Those indicators MAY want an "override mode" where advanced users explicitly enter a tighter cap. Keeping the fields in state for now leaves the door open.
3. **No payload impact** — the GTC mapping in `toCreateOfferPayload` reads only the single user-entered values; the `*Max` form-state fields are dead in the new mapping.

If Phase 2 lands without using them, they can be removed cleanly in a follow-up.

### Phase 2 of #165 (separate follow-up PR)

What's NOT in this PR — explicitly deferred to a Phase 2 follow-up so this MVP can land:
- Live LTV / HF risk indicator (the green/yellow/orange/red zone display)
- Basic-mode toggle re-purpose (currently still gates the Advanced sliders that are now hidden; should become a risk-display-verbosity toggle)
- Per-field placeholder + hint copy refresh to match the new role-asymmetric meaning
- Cross-link in `apps/defi/src/pages/OfferBook.tsx` if the book view's column labels imply the old min/max semantic

### Verification

- ✅ `pnpm --filter @vaipakam/defi exec tsc -b --noEmit` clean
- ✅ 10/10 locale JSON files valid; 6/6 new keys per locale
- Manual: lender / borrower toggle on `CreateOffer.tsx` swaps the field labels live; payload submit translates the user's single-value input through the new role-asymmetric mapping
- Contract-side: ADR-0010 mapping is what the deployed contracts already honor (via PRs #167 / #170 / #174)

### Round-1 Codex correction — payload reverts to single-value

Codex round-1 on PR #175 caught five P1s + one P2 that collectively revealed: the ADR-0010 §17.1 split-floor/ceiling mapping was written assuming `OfferMatchFacet.matchOffers` is the canonical match flow, but the contract still exposes `OfferAcceptFacet.acceptOffer` for direct single-match accepts. The direct-accept path reads `offer.amount`, `offer.interestRateBps`, and `offer.collateralAmount` literally — not via the matchOverride derivation. Shipping the ADR split-mapping would have let:

- a borrower direct-accept a lender offer with `amount = 1 wei` and walk away with a 1-wei loan;
- a lender direct-accept a borrower offer with `interestRateBps = 0` at 0 % APR;
- a lender direct-accept a borrower offer with `collateralAmount = 0` without pulling any collateral.

All real underpayment / fund-loss vectors caught pre-merge.

**Phase 1 corrected scope** (what this PR ships): role-asymmetric LABELS over **single-value** payloads. The user's headline number lands in the floor field (`amount` / `interestRateBps` / `collateralAmount`); the `*Max` ceilings auto-collapse to zero. The contract reads `*Max == 0` as "treat as single-value at the floor", so both the direct-accept path AND `matchOffers` land at the same loan terms. The UX shift (lender thinks "Lend up to X", borrower thinks "Borrow at least Y") is purely labels — fully audit-safe.

**Phase 2 will revisit the full ADR-0010 §17.1 mapping** — either by gating legacy `acceptOffer` on a flag at the contract level (prevents the underpayment class structurally), or by adding explicit min/max range inputs for users that want true range orders. Both are contract-touching follow-ups out of #165 Phase 1's scope.

### Dependencies

- ✅ #102 (PR #174) — borrower partial-fill (the contract surface that #165 Phase 2 will plumb through)
- ✅ #163.A (PR #171) — ADR-0010 (the design lock; Phase 1 implements the LABELS half; Phase 2 implements the contract-mapping half)
- ✅ #164 (PR #167) — borrower collateral range
- ✅ #169 (PR #170) — single-cold-compile CI shape

Downstream: [#172](https://github.com/vaipakam/vaipakam/issues/172) — apps/keeper matcher updates to seek borrower partial-fill candidates (parallel-track PR).

## Thread — CI: fold Build docs into ci.yml; one forge cold compile per PR (PR #<n>)

Closes #169. Eliminates the parallel cold-forge-build problem on
contracts-touching PRs: today's `ci.yml` does ONE cold `forge build`
inside `contracts-fast`, but the separate `contracts-docs.yml` workflow
triggered on the same `pull_request` event and ran ANOTHER cold compile
(via `forge doc --build`) in parallel — two ~22 min compiles racing for
the same `actions/cache` key. GitHub Actions doesn't support
cross-workflow `needs:` dependencies, so the only fix was to fold the
docs build into the same workflow.

### What changes

**`ci.yml` gets a new `build-docs` job** downstream of `contracts-fast`
(`needs: [detect-changes, contracts-fast]`, gated on `contracts ==
'true' && contracts-fast.result == 'success'`). It restores the same
`actions/cache` artifacts `contracts-fast` populated, then runs `forge
doc --build` against warm contracts — no recompile, just the NatSpec →
mdbook rendering. Observed runs land at ~5-8 min vs the ~22 min cold-
compile job it replaces.

**`contracts-docs.yml` narrows to push-to-main + workflow_dispatch
only.** The PR trigger is gone; the file now owns ONLY the Pages-deploy
concern. The PR-preview artifact upload (`contracts-docs-pr-<N>`) moved
to `ci.yml`'s `build-docs` job — reviewers still download + inspect the
rendered docs the same way, just from a different workflow's artifact.

### The "one forge build per PR" chokepoint, explained

After this fold, the entire contracts CI graph runs from a single cold
compile, then a three-branch parallel-warm fan-out where every job
consumes the same warm `out/` cache (no recompilation):

```text
detect-changes (always, ~5 s)
   ├─→ workspaces (TS typecheck, ~1 m, no forge)        ← parallel-OK
   └─→ analyze-jstypescript (CodeQL, ~1.5 m, no forge)  ← parallel-OK
        ↓
   contracts-fast (THE forge build + deploy-sanity, ~20 m cold)
   needs: [detect-changes, workspaces, analyze-jstypescript]
   if: contracts changed
        ↓
   ┌──────────┬──────────┬──────────────────────────┐
   ↓          ↓          ↓
build-docs  slither    contracts-full   ← parallel branches; all three
(~5-8 m,   (~5 m,     (~30 s,             restore the same `actions/cache`
warm        warm       warm cache)        key populated by contracts-fast
cache)      cache)         ↓               and skip the compile entirely.
                       gas-snapshot
                       (~3 m,
                        warm cache)
                       needs: contracts-full
                       (serial sub-branch — gas check runs only on a
                        tests-pass state)
```

**Forge build runs exactly once per PR** — in `contracts-fast`. Every
other forge-USE invocation in the fan-out (`forge doc --build`,
slither's AST walk, `forge test`, `forge snapshot --check`) hits warm
artifacts and skips the compile. Peak parallel forge-USE: three jobs
at T=0 after contracts-fast, but the compiler is invoked **zero**
times in any of them (the cache restore is a strict pre-condition).

**Wall-clock**: `~20 m` (contracts-fast cold compile) + `~5-8 m`
(longest pole in the fan-out — build-docs). `contracts-full` + `gas-snapshot`
together finish at ~3.5 m, well before build-docs, so they don't
extend the critical path.

`contracts-fast` populates `actions/cache` (path: `contracts/out` +
`contracts/cache`) with the compiled state. Every downstream forge-USE
job (`contracts-full`, `slither`, `build-docs`, `gas-snapshot`) restores
the same cache key at checkout. When forge is invoked downstream
(`forge test`, `forge doc --build`, `forge snapshot`, `slither`), it
sees the source hash matches the cached compile and skips the build
entirely — only the test execution / static analysis / mdbook rendering
runs. That's why `contracts-full` on PR #167 finished in 28 seconds
post-warm-cache.

The fold guarantees: ONE cold compile per PR, period. No racing
parallel forge invocations. Path-gated subsets (docs-only / TS-only /
contracts-only) cascade-skip via `needs:` chains, so a PR that doesn't
touch contracts costs zero forge compute.

### Compute savings

A contracts-touching PR previously paid for two parallel cold compiles
(`contracts-fast` ~23 min + `contracts-docs.yml`'s build ~22 min, both
running simultaneously). After this fold, the PR pays for one
(`contracts-fast` ~20 min) plus a warm-cache `forge doc --build` (~5-8
min downstream). **~50% reduction in cold-forge-compile minutes per
contracts-touching PR**, with wall-clock effectively unchanged
(~28-30 min total either way — the cold compile dominated already).

### Bonus optimisation — createOffer SSTORE-skip on single-value offers

PR #167's gas-snapshot job flagged five tests regressing 5.4-8.3%
(`testCreateOfferGetUserEscrowFails` +5.6%, etc.). Root cause: the
new `collateralAmountMax` storage slot SSTORE adds ~22.1 K cold-write
gas per `createOffer` (= 5.6% of 395 K, matching the observed slope).

The fix lands in this PR as a one-line conditional inside
`OfferCreateFacet._writeOfferCollateralFields`:

```solidity
// Only SSTORE when the offer is actually ranged. Single-value /
// legacy offers leave collateralAmountMax at storage default `0`.
// Every read site already has the `0 ⇒ collateralAmount` fallback
// (per Codex round-1 on #164) — so skipping the SSTORE is
// semantically identical to writing collateralAmount.
if (effCollateralAmountMax != params.collateralAmount) {
    offer.collateralAmountMax = effCollateralAmountMax;
}
```

Plus a paired update to:
- `_emitOfferCreatedDetails` — applies the same `0 ⇒ collateralAmount`
  collapse before emitting `OfferCreatedDetails`, so indexers see the
  LOGICAL upper bound (not the storage default). Without this the
  SSTORE-skip would leak through the event payload.
- `_createOfferSetup`'s borrower-side `MaxLendingAboveCeiling` check —
  computes the bound from `params.collateralAmountMax` directly
  (with the auto-collapse) rather than reading `offer.collateralAmountMax`,
  since storage may now be `0` post-skip.

Result: pre-#164 gas costs preserved bit-for-bit on every legacy
single-value `createOffer`. Only ranged-collateral offers pay the
22.1 K SSTORE — and on those, it's intrinsic to the new feature, not
overhead.

### Required-status-checks update

The `Protect main` ruleset's required-status-checks list needs the new
job name added + the old standalone removed:

- ADD `Build docs` (new ci.yml job)
- REMOVE `Contracts docs / Build docs` (the standalone workflow no
  longer runs on PRs; only on push-to-main, where required-checks
  don't apply anyway)

Update via the GitHub UI under Settings → Rules → `Protect main`. The
PR body / merge step will note when this happens.

## Thread — Apps/keeper matcher: lift the single-fill break + fan-out lender across borrowers (PR #<n>)

Closes [#172](https://github.com/vaipakam/vaipakam/issues/172). Tracks the contract change that landed in PR #174 (#102) on the keeper side: the matcher tick used to break the inner borrower-iteration loop on the first successful match — an implicit Phase 1 single-fill assumption that the comment said so explicitly. After #102 lifted that rule end-to-end on the contract, the keeper needs to fan-out instead.

### What this PR ships

A single edit to `apps/keeper/src/matcher.ts`'s `runOfferMatcherTickForChain`:

- The unconditional `break;` after a successful `submitMatch` is gone.
- The inner loop now `continue;`s by default — the same lender can match additional borrowers in the same tick (lender partial-fill fan-out), and the same borrower can match additional lenders in the same tick via the OUTER loop (borrower partial-fill fan-out).
- Early-exit ONLY when `preview.lenderRemainingPostMatch === 0n` (the lender is fully filled; nothing left to allocate).
- The `attempted` set already prevents re-trying the exact (L, B) pair within a tick, so no infinite loop.

### Why the small surface

The matcher was already mostly correct. It filtered out `accepted` offers during hydration (`hydrateOffers` line 198: `if (o && !o.accepted) out.push(o)`), and that filter just-works under #102 — partial-filled borrower offers have `accepted = false` until dust-close, so they stay in the candidate set automatically. The only remaining single-fill assumption was the post-submit `break`, which assumed the borrower offer was now terminal. Removing it lets the matcher fan-out.

### Behavior the matcher now exhibits

| Scenario | Pre-#172 | Post-#172 |
|---|---|---|
| Lender L matches borrower B1 ($X out of $Y range) | Breaks inner loop — L untouched, B1 NEVER tried again | Continues — L attempts B2, B3, ... in the same tick, fanning out remaining capacity |
| Same lender L matches multiple borrowers in one tick | One match max per tick per lender | Up to `MAX_SUBMITS_PER_TICK` matches per tick across the whole order book |
| Lender L is now fully filled after match | Implicit (the `break` happened to also catch this) | Explicit `if (lenderRemainingPostMatch === 0n) break;` |
| Borrower B matched once, has remaining capacity | NEVER matched again on this tick (single-fill assumption) | Available to be matched by the NEXT lender in the outer loop (different L, same B, new pairKey) |
| `partialFillEnabled` master flag off (contract reverts on attempted partial) | Same — `matchOffers` reverts; matcher logs once-per-chain, retries next tick | Same — graceful degradation, behaviour identical to pre-#172 when flag is off |

### What's NOT in this PR (filed as follow-ups if needed)

- **In-memory lender state tracking**: today the matcher rehydrates offers at tick START; mid-tick, a successful match changes lender's `amountFilled` on-chain but not in the local `OfferLite`. Subsequent `previewMatch` calls within the same tick read the LIVE on-chain state (correct). The local cache is stale but only as an optimization hint, not a correctness invariant. A future optimization could decrement local lender capacity to skip preview calls against now-exhausted lenders — but the contract's `previewMatch` already returns `AmountNoOverlap` for that case, so the optimization is cheap-to-skip.
- **Public reference keeper bot at `vaipakam/vaipakam-keeper-bot`** — separate sibling repo; needs the same single-line fix applied via the keeper-bot ABI sync flow. Tracked outside this PR (the public bot updates lag the production matcher by design).
- **Borrower-side dust-close handling**: when a borrower offer reaches dust-close (per #102), the contract auto-closes it and emits `OfferClosed`. The matcher's `hydrateOffers` filter (`accepted`) already excludes dust-closed offers on the NEXT tick. No matcher-side change needed.

### Round-1 Codex correction — wait for tx inclusion before continuing

Codex round-1 caught a P1 race: `submitMatch` used `writeContract` (which returns on BROADCAST), not waiting for inclusion. Without waiting, the loop continued to subsequent (L, B) pairs immediately; the next `previewMatch` read `latest` state which didn't include the broadcast tx's effects yet, so multiple matches got queued against the same lender's unconsumed capacity. The first match landed; the rest reverted when mined.

Fixed by mirroring the sibling pattern at `apps/keeper/src/dailyOracleSnapshot.ts:127`:

```ts
const hash = await ctx.wallet.writeContract({ ... });
const receipt = await ctx.client.waitForTransactionReceipt({ hash, timeout: 30_000 });
if (receipt.status !== 'success') return false;  // on-chain revert
```

Trade-off: tick wall-clock now includes block-time per match. Worst-case: `MAX_SUBMITS_PER_TICK (25) × block_time`. Acceptable; the next cron either overlaps via the Workers concurrency lock or starts fresh state. Far cheaper than burning gas on N-1 reverts every tick.

### Verification

- ✅ `pnpm --filter @vaipakam/keeper exec tsc -p . --noEmit` clean (both pre- and post-fix)
- Manual: with `partialFillEnabled` on (true on every fresh Vaipakam deploy post-#102), a single matcher tick now consumes multiple slices of a borrower offer across compatible lenders; observable via `[matcher] submits=N` log line (N ≥ 2 on a busy book). Each match awaits receipt before the next is broadcast.

### Dependencies

- ✅ #102 (PR #174) — borrower partial-fill on the contract side; this PR is the keeper-side follow-up
- ✅ #163.A (PR #171) — ADR-0010 design lock that makes the matcher's behavior coherent
- Parallel-track sibling: [#165 / PR #175](https://github.com/vaipakam/vaipakam/pull/175) — frontend GTC UI

🤖 Generated with [Claude Code](https://claude.com/claude-code)

## Seven-scenario coverage for borrower partial-fill matching (#173 follow-up)

The scaffolding PR (#178) closed the SetupTest cut drift and shipped
three smoke tests for `OfferMatchFacet.matchOffers` / `previewMatch`.
This PR adds the seven concrete scenarios the issue's body scopes,
landing as `contracts/test/BorrowerPartialFillTest.t.sol`.

### What's covered

- **Happy-path partial fill** — first match on a wide borrower range:
  `B.amountFilled` tracks the match, the clamp-up collateral pick
  resolves to `max(lender_required, B.collateralAmount)`, the
  borrower offer stays OPEN, and collateral STAYS in escrow custody
  across the match.
- **Multi-fill draining a borrower offer + dust-close** — three
  lenders consume a `[1_000, 10_000]` borrower in sequence; the
  third match's `borrowerRemaining < B.amount` triggers dust-close;
  `B.accepted` flips to true and the residual collateral
  (`collateralAmountMax - collateralAmountFilled`) refunds to the
  borrower's wallet in the same tx.
- **Single-fill fallback when the kill-switch is off** — flipping
  `partialFillEnabled` back off makes `matchOffers` revert
  `FunctionDisabled(3)` as the outer gate. The wallet-balance check
  confirms a reverted call moves no funds.
- **Borrower advanced-mode override** — `amountMax` ships as a
  literal (8_000), the storage holds it verbatim, and a 7_000-amount
  lender matches against it.
- **Borrower `amountMax = 0` derivation** — **documented skip**: the
  derivation in `LibOfferMatch._effBorrowerAmountMax` is forward-
  looking code for #165 Phase 2. Today's `createOffer` auto-collapses
  `params.amountMax = 0 → params.amount` before SSTORE, so storage
  never holds 0 and the derivation never fires through the public
  interface. The test skips with a clear reason; the assertion gets
  written for real when Phase 2 makes the path reachable.
- **MatchError revert paths** — two scenarios cover the typed
  reverts: `AmountNoOverlap` (lender amount sits outside the
  borrower's range) and `RateNoOverlap` (borrower's rate ceiling
  below the lender's rate floor). Both assert that `previewMatch`
  surfaces the structured `MatchError` AND that `matchOffers` maps
  it to the typed facet revert.

### Status

- 7 tests authored: **6 PASS + 1 documented SKIP**.
- Card #173 covers the test infrastructure end-to-end with this PR;
  the skip resolves when #165 Phase 2 lands and the borrower GTC
  storage flow keeps `amountMax = 0` rather than auto-collapsing.

## Test scaffolding for `OfferMatchFacet` (Issue #173 — scaffolding piece)

The Range Orders Phase 1 matching surface — `OfferMatchFacet.matchOffers`
and `OfferMatchFacet.previewMatch` — had no targeted test file at all.
Coverage of the matcher came only via the integration scenarios that
touch `acceptOffer` end-to-end. The borrower-partial-fill PR (#102 →
#174) made the gap more load-bearing by adding new code paths
(borrower-side `amountFilled` increment, `collateralAmountFilled`
increment, dust-close + accept-flip, conditional refund, borrower
`amountMax = 0 → derive` fallback) that today's regression confirms
preserve the legacy single-fill path but never exercises the
partial-fill ON path.

This change ships the test-infrastructure half of #173:

- **SetupTest** now cuts `OfferMatchFacet` into its test diamond — a
  one-line drift fix. The production deploy already cuts it
  (DeployDiamond §5e), but SetupTest's diamond did not, which silently
  prevented any inheriting test from reaching `matchOffers` /
  `previewMatch` through the diamond fallback. No existing test calls
  these selectors, so the cut is a strict superset — every
  pre-existing test sees the same diamond shape it always did, plus
  two newly-reachable selectors.

- **`MatchOffersScaffoldTest.t.sol`** is a small reachability check:
  `previewMatch` returns a structured `MatchResult`, `matchOffers`
  reverts with a typed facet error (not a generic
  "selector-not-found"), and the partial-fill master kill-switch
  reverts `FunctionDisabled(3)` when off. Inheriting tests get the
  range + partial-fill flags pre-enabled via setUp.

The seven detailed scenarios from #173's scope (happy-path partial
fill, multi-fill consuming one borrower offer, dust-close, single-fill
fallback, borrower `amountMax = 0` derivation, advanced-mode override,
the `MatchError` revert paths) ride on this scaffolding and land as
a follow-up PR under the same issue.

## Thread — Serialize CI forge builds: one cold build per PR (PR #<n>)

Folded the standalone `gas-snapshot.yml` and `slither.yml` workflows
into `ci.yml` as new jobs gated on `needs: contracts-fast`. Pre-change,
a contracts-touching PR could cold-build forge up to THREE times in
parallel — once in `ci.yml`'s `contracts-fast`, once in
`gas-snapshot.yml` (when it lost the cache race), and once inside the
`crytic/slither-action` Docker container (which has its own Foundry
install completely isolated from the host runner's foundry cache).
Post-change there is exactly **one cold forge build per PR**, and all
four contract-touching jobs (`contracts-fast`, `contracts-full`,
`gas-snapshot`, `slither`) restore the same content-keyed foundry
cache that `contracts-fast` warms.

The trade-off is acknowledged: the informational jobs (`gas-snapshot`
and `slither`) now arrive ~5-10 minutes later on cold-cache PRs
because they wait for `contracts-fast` to finish first instead of
racing it in parallel. **Wall-clock time to merge-ready is
UNCHANGED** — `contracts-fast` is the required gate either way; the
slower informational jobs just don't burn duplicate forge minutes on
top of it. This deliberate compute-over-latency trade-off is captured
as a feedback memory (`feedback_ci_compute_over_wall_clock`) so the
agent picks the same default next time.

Implementation notes. The gas-snapshot job is a literal lift-and-
shift of the standalone workflow's `gas-snapshot` job, with the
working-directory + cache-restore wired to match the rest of ci.yml.
The slither job replaces the `crytic/slither-action` Docker action
with a host-runner shape: `actions/setup-python@v5`, then
`pip install slither-analyzer==0.11.4` (same pin the docker action
carried for output stability), then `slither . --config-file
slither.config.json --sarif slither-results.sarif`, then
`github/codeql-action/upload-sarif` to populate the Security tab.
The `|| true` after the slither invocation matches the old
`fail-on: none` semantics — Slither is informational; the SARIF
upload is the load-bearing product, not the exit code.

`.github/allowed-actions.txt` updated to reflect the doc-side audit
trail: `actions/setup-python@*` added; `crytic/slither-action@*`
removed with an inline note about why and when. The maintainer will
need to update GitHub's runtime Settings → Actions → General policy
to match (the doc is the source of truth for what SHOULD be allowed;
the Settings UI is the runtime gate).

After this PR merges the two retired workflows are gone from the
Actions tab and the `Slither (informational)` / `Gas snapshot` runs
appear as jobs inside `ci` rather than as separate workflow runs.

A second optimisation is in this PR: `contracts-fast` now also
`needs: workspaces`, so a TypeScript-side failure short-circuits the
expensive forge build before it starts. Cold-PR wall-clock to merge-
ready grows by workspaces' 2-3 min (workspaces must finish first),
but the ~10 min of forge build that today runs alongside a failing
workspaces typecheck is saved entirely. CodeQL stays parallel for
now — its `Analyze (javascript-typescript)` lives in a separate
workflow file (`codeql.yml`) and GitHub Actions doesn't support
cross-workflow `needs:` dependencies. Folding CodeQL into `ci.yml`
is tracked as a follow-up card so the next reviewer sees the
deliberate scope choice.


## Thread — Make `contracts-full` a conditional required check (PR #<n>)

Tightens the merge gate. Pre-change, `contracts-full` (the full
2,012-test regression) ran informationally on every PR but did
not gate merge. The deliberate trade-off was acknowledged in
`ci.yml`'s top comment: a subtle regression that only the full
suite catches could land on main between PR merge and the next
`mainnet-gate.yml` run on a release tag. `mainnet-gate.yml` is the
load-bearing backstop, but the gap is real.

This PR closes that gap by adding `contracts-full (forge +
predeploy-check --full)` to the `Protect main` ruleset's
`required_status_checks` rule and renaming the job (drops the
`[informational]` suffix that's now stale). The check is
conditionally required via the path-filter skip pattern: its
existing `if: needs.detect-changes.outputs.contracts == 'true'`
guard skips it on docs-only PRs, and branch protection treats
`if:`-skipped checks as SUCCESS. So docs-only PRs continue to
merge fast; contracts-touching PRs must wait for the full
regression to complete on the FINAL commit before merge.

Trade-off, per the user's explicit preference in
`feedback_ci_compute_over_wall_clock`:

- Critical-path wall-clock on contracts-touching PRs grows by
  ~5-10 min — `contracts-fast` clears in ~10 min cold but
  `contracts-full` runs another ~5-10 min on the warm cache.
- Compute cost is UNCHANGED — `contracts-full` was already
  running, just not gating.
- Confidence in the final merge SHA goes from MEDIUM to HIGH.
  The full suite is guaranteed to have run on the exact commit
  being merged.

`mainnet-gate.yml`'s rationale block was updated to reflect the
new shape: the workflow now exists as the audit-trail symmetry
backstop for release tags rather than the only line of defence
for the full regression.

Maintainer action alongside merge: update GitHub Settings → Rules
→ Protect main → "Require status checks to pass" to include the
new `contracts-full (forge + predeploy-check --full)` entry. The
PR description carries the exact UI walkthrough.
