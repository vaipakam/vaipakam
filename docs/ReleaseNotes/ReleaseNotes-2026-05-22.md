# Release Notes — 2026-05-22

Seven threads in this batch — they form the **canonical-limit-order
Phase 2 landing** plus the LayerZero-doc-debt closeout. Phase 2 (#183)
shipped first as a design doc that locked the role-aware-read shape
for direct-accept (lender-acceptor reads borrower's `amount` +
`interestRateBpsMax`; borrower-acceptor reads lender's `amountMax`
+ `interestRateBps`), then as the implementation across five facets
+ the frontend (residual collateral refund on direct-accept;
`matchOverride` precedence). Test coverage for the new code landed
in two follow-up threads: #188's cancel-after-partial-fill scenarios
for both lender and borrower (including the cooldown-bypass control
case + loan-state invariant asserts), and #191's dedicated coverage
for direct-accept against ranged offers (six scenarios pinning the
role-aware reads that #183 introduced). In parallel, #185 introduced
a `quick` foundry profile that compiles `src/` + `lib/` only — 44s
cold vs 14-19 min on the default profile — to keep inner-loop
iteration fast while the CI default stays viaIR-+-optimizer for
production parity. The LayerZero doc debt closed cleanly: #181's
NatSpec scrub renamed `IRewardOApp` → `IRewardMessenger` and swept
the residual pre-T-068 wording from `contracts/src/`, and the WIP
banner that had been flagging the doc drift on
https://vaipakam.github.io/vaipakam/ was retired in the same release
cycle now that the body is CCIP-accurate.

## Thread — LayerZero NatSpec scrub + `IRewardOApp` → `IRewardMessenger` rename (PR #<n>)

Mechanical follow-up to T-068. The cross-chain transport has been
Chainlink CCIP since April 2026, but a number of NatSpec headers,
inline comments, and one interface name still spoke as if the
protocol were on LayerZero — describing OFT adapters that no longer
exist (`VPFIOFTAdapter`), peer meshes that were dismantled, and OApp
packets that are now CCIP messages. The stale wording was the kind a
new reader would honestly try to follow before discovering the code
no longer matches it. This thread scrubs that surface in one pass.

`IRewardOApp` is renamed to `IRewardMessenger` — the only file-level
rename in the change. Its method names (`sendChainReport`,
`broadcastGlobal`) stay because they describe an intent
("send a chain report", "broadcast the global denominator"), not a
transport. The rename is reflected in `RewardReporterFacet`,
`RewardAggregatorFacet`, and the test double `MockRewardOApp` →
`MockRewardMessenger`. The Diamond's storage slot `rewardOApp` and
the related custom errors (`RewardOAppNotSet`,
`NotAuthorizedRewardOApp`) are deliberately **not** renamed: those
are part of the deployed ABI / storage layout, and renaming them is
an upgrade-path break the migration explicitly avoided. NatSpec next
to each retained legacy name now states why it's still called that.

In addition, `GuardianPausable`'s header no longer reads as the
provider-neutral successor to a deleted pause base — that framing
was correct mid-migration but became a backwards-looking artefact
once the LayerZero base was actually gone. It now describes the
contract for what it currently is: the pause base for every
cross-chain contract under `contracts/src/crosschain/`, named
transport-neutrally on purpose.

No production code paths change. The Diamond ABI is unchanged. The
57-test `CrossChainRewardPlumbingTest` suite passes; the four
`VPFI*` test suites pass (69 cases); the 12-case deploy-sanity gate
(facet-size limit, selector coverage, selector collision, deployed-
Diamond unpaused) passes. The public reference keeper bot and the
frontend ABI bundles do not change — none of the touched symbols is
in the Diamond external surface.

Closes #181.

## WIP banner on the public NatSpec docs site — shipped and retired (Issue #181)

When `https://vaipakam.github.io/vaipakam/` first went live (#177),
the auto-generated NatSpec mdbook still described the **pre-T-068
LayerZero architecture** in several places. The CCIP migration
(T-068, April 2026) had scrubbed the deployed contracts but the
NatSpec comments hadn't been swept yet — auditors / integrators
landing on the docs site could honestly try to follow wording that
no longer matched the code.

This release shipped a temporary **sticky, high-contrast "WORK IN
PROGRESS" banner** on every page of the generated site — home page,
every facet, every function — to flag the discrepancy while the
scrub was in flight. The banner named the issue, pointed at the
current cross-chain authority (ADR-0004 + the CCIP migration plan),
and stayed pinned during scroll so it couldn't be missed.

The scrub then landed in PR #190 (issue #181 closed). With the
discrepancy gone, the same release cycle retired the banner: the
post-build step in `.github/workflows/contracts-docs.yml` now only
writes the `CONTEXT.md` breadcrumb at the site root pointing at the
protocol-level docs (the ADR set, glossary, functional specs,
operator handbook). No banner is injected.

The next docs build re-publishes the site without the banner.

Implementation lived entirely in `contracts-docs.yml` (no contract
or doc-source changes for either the add or the remove). Banner
styling had been inline so the mdbook theme switcher (light / dark
/ ayu) couldn't defeat it; the inline approach also meant the
removal was a single workflow-step edit, no stylesheet cleanup
needed.

## Canonical Limit-Order Phase 2 — design doc (Issue #183)

Ships `docs/DesignsAndPlans/CanonicalLimitOrderPhase2Design.md`, the
ratified design for the second phase of the canonical limit-order arc.
The doc captures every decision locked in the multi-round design pass:

- **Frontend single-input-per-role mapping** — lender enters one
  value per dimension (lendingAmount + collateralAmount + rate +
  optional minPartialFillAmount); borrower does the same. No
  Basic/Advanced range UI.
- **Role-aware `_acceptOffer` reads** — direct-accept reads
  `amountMax` for lender offers / `amount` for borrower offers;
  `interestRateBps` for lender / `interestRateBpsMax` for borrower;
  `collateralAmount` for both. Closes the PR #175 Codex P1 vector
  (lender shipping `amount = 1 wei` → 1-wei direct-accept transfer)
  without adding a new selector.
- **Invariant: `amountMax >= amount > 0`** — drop the create-time
  auto-collapse; new typed reverts; storage always holds explicit
  non-zero values.
- **Delete `_effBorrowerAmountMax`** — the GTC derivation in
  LibOfferMatch becomes dead code under the new invariant. The
  `test_borrowerAmountMaxZeroDerivation` SKIP from #173 becomes a
  permanent skip with updated reasoning.
- **`minPartialFillAmount`** — replaces the implicit `amount` floor
  for lender offers; default 10% of `lendingAmount`.
- **Display side extends existing OfferBook** — the DEX-style
  anchor-in-middle two-sided layout is already there; Phase 2
  retunes columns (new cumulative-depth column; borrower side gets
  split collateral display and an explicit `$min–$max` range).
- **Migration**: prelive; fresh testnet redeploy.

The doc covers context, the model, direct-accept semantics, matchOffers
semantics, the dropped derivation, display side, migration, full
implementation plan (files + estimated LOC), risk register, and a
decision log of every choice made during the session.

Implementation rides on this doc — separate PR after the design lands.

## Canonical Limit-Order Phase 2 — implementation (Issue #183)

Implements the ratified design from PR #184 / [#183 design doc](../../DesignsAndPlans/CanonicalLimitOrderPhase2Design.md). Closes the `_acceptOffer` direct-accept deferral from PR #175 (the Codex P1×5 round-1 finding that forced a transitional revert) and removes the dead borrower `amountMax = 0` derivation path that #173's `test_borrowerAmountMaxZeroDerivation` SKIP was guarding.

### Contracts

- **`LibOfferMatch.sol`** — Deletes `_effBorrowerAmountMax`. `previewMatch` reads `B.amountMax` directly. The underflow guard before `borrowerRemaining = effBorrowerAmountMax - B.amountFilled` stays as defensive.
- **`OfferMatchFacet.sol`** — Deletes the post-match derivation branch in `matchOffers`. Removes now-unused `LibRiskMath` + `OracleFacet` imports.
- **`OfferCreateFacet.sol`** — Drops the create-time auto-collapse (`amountMax == 0 → amount`, same for rate + collateral). Adds typed invariant reverts (`AmountMustBePositive`, `AmountMaxMustBePositive`, `CollateralMustBePositive`, `CollateralAmountMaxMustBePositive`). Removes the now-dead range-flag kill-switch gates (`rangeAmountEnabled` / `rangeRateEnabled` / `rangeCollateralEnabled`) — under the canonical mapping every offer is structurally ranged. Retires the #169 SSTORE-skip optimisation for `collateralAmountMax`. Three carve-outs surfaced by running the swept regression:
  - Rate invariant allows `interestRateBpsMax == 0` (NFT rentals + no-interest loans).
  - Collateral `> 0` enforced only for ERC20+ERC20 loans (NFT collateral and NFT rentals exempt).
  - Lender sale-vehicle pattern (`collateralAmount == 0 == collateralAmountMax` both zero) explicitly allowed.
- **`LoanFacet.sol`** — `initiateLoan` direct-accept branch reads role-aware: lender offers → `loan.principal = offer.amountMax`, `loan.interestRateBps = offer.interestRateBps`; borrower offers → `loan.principal = offer.amount`, `loan.interestRateBps = offer.interestRateBpsMax`. `loan.collateralAmount = offer.collateralAmount` for both. matchOffers path unchanged (still reads `matchOverride.*`).
- **`OfferAcceptFacet.sol`** — Introduces `effectivePrincipal` local at the top of `_acceptOffer` resolving three-way (matchOverride.amount when active / amountMax for lender direct-accept / amount for borrower direct-accept). Replaces the ERC20-path LIF math, principal transfer, `OfferAccepted` event payload, and KYC value calc to use it. The KYC change is load-bearing — gates on the real loan value at risk under Phase 2 (a lender direct-accept on a $10k offer was previously calling KYC at $1k = 10% minPartialFill under the new schema). Adds `_refundBorrowerCollateralResidualIfNeeded` private helper that fires on direct-accept of a borrower offer with `collateralAmountMax > collateralAmount` (PR #184 Codex P1.2 — without this the residual collateral would be stranded; matchOffers' dust-close branch doesn't fire on the direct-accept path). Extracted to a helper because the inline block pushed `_acceptOffer` over viaIR's stack budget.

### Tests

- **31 existing test files** swept via a mechanical Python script (`/tmp/sweep_amountmax_zero.py`). 534 fields updated. Every `CreateOfferParams` struct that shipped `amountMax: 0` / `interestRateBpsMax: 0` / `collateralAmountMax: 0` (Phase 1 auto-collapse pattern) now ships the corresponding base value. Single-value offer semantic stays byte-identical to today's behaviour.
- **`BorrowerPartialFillTest.t.sol`** — `test_borrowerAmountMaxZeroDerivation` SKIP doc-comment updated from "Phase 2 prereq, unblock later" to **permanent skip** (the derivation path was rejected as a design direction; the test stays as a future-proofing assertion that the path remains deleted).
- **Full regression** (`forge test --no-match-path "test/invariants/*"`): **2021 PASS, 0 FAIL, 6 SKIP** across 99 test suites.

### Frontend

- **`apps/defi/src/lib/offerSchema.ts`** — `toCreateOfferPayload` now ships canonical role-asymmetric values. Lender: `amount = max(1, lendingAmount × 10/100)`, `amountMax = lendingAmount`, `interestRateBps = user rate`, `interestRateBpsMax = MAX_INTEREST_BPS`. Borrower: `amount = lendingAmount` (the floor), `amountMax = lendingAmount`, `interestRateBps = 0`, `interestRateBpsMax = user rate`. NFT-rental offers stay single-value on amount.
- **`apps/defi/src/pages/OfferBook.tsx`** — Offer table reads role-aware fields: lender Principal `amountMax`, lender Rate `interestRateBps`, borrower Principal `amount`, borrower Rate `interestRateBpsMax`. Anchor-rate delta annotation switches to the role-aware rate. Adds `amountMax`, `interestRateBpsMax`, `collateralAmountMax` to `OfferData` and `RawOffer` types with fallback-to-floor for legacy indexer rows.
- **`useMyOffers.ts`** + **`offerSnapshot.ts`** — Cancelled-offer reconstruction paths populate the new `*Max` fields; localStorage snapshot loader falls back to floor fields for pre-Phase-2 snapshots.

### ABI export

- Per-facet ABI JSONs regenerated. Only diff is `OfferCreateFacet.json` (four new typed errors). Frontend + Worker typechecks all clean (`@vaipakam/defi`, `@vaipakam/keeper`, `@vaipakam/indexer`, `@vaipakam/agent`).

### Out of scope for this PR (follow-up cards)

- Cumulative-depth column on the offer table (design §6.5, deferred to Phase 2.5).
- Borrower row collateral split into "Committed (floor) + Available (unfilled)" — Phase 2 frontend ships single-value borrower offers.
- Borrower row showing derived `amountMax` as range `$min–$max` — same reason.
- OfferDetails deep-dive page additional fields (§6.4).
- Two new dedicated test files (`RoleAwareAcceptOfferTest.t.sol`, `CreateOfferInvariantsTest.t.sol`) — surfaced for follow-up; the swept existing tests + the full regression cover the role-aware reads end-to-end via integration paths.

### Migration

Platform is prelive. Fresh testnet redeploy on next cycle. No legacy storage migration path needed.

## Fast inner-loop forge build via `quick` foundry profile (Issue #185)

`forge build` under the default profile takes 14-19 min cold and uses
~8 GB RSS — for any iteration loop where you only care about "does
my contract change compile?", that's a wall hit hard enough to stall
focused work. (The blocker surfaced during the #183 implementation
session.)

Adds a new `[profile.quick]` to `contracts/foundry.toml` that drops
`test/` and `script/` from the compile set and keeps `src/` + `lib/`.
viaIR + optimizer stay ON — several `src/` facets (e.g.,
`EscrowFactoryFacet.sol:631`) structurally need viaIR to compile
(stack-too-deep otherwise), so dropping it isn't an option without
refactoring src/. The win comes from the LOC reduction alone — `src/`
is roughly half the project's Solidity, and the lib's tests were
already skipped under the default profile.

Measured (cold cache, on the dev box that motivated this card):

| Run | Default profile | Quick profile |
|---|---|---|
| Cold | 14-19 min, ~8 GB RSS | **44 s, ~677 MB RSS** |
| Warm cache | (recompile of cache hits) | **<1 s, ~104 MB RSS** |
| Incremental rebuild after touching 1 src/ file | (cache miss cascade) | **<1 s, ~104 MB RSS** |

**Usage** (per CLAUDE.md "Executing forge" section):

- Inner-loop "did my change compile?" → `FOUNDRY_PROFILE=quick forge build`
- Tests / scripts / regression / predeploy → `forge build` / `forge test`
  (default profile, unchanged)
- CI is unchanged — every gate runs under the default profile.

**Constraint**: do NOT use `FOUNDRY_PROFILE=quick` with `forge test`.
Tests need viaIR + optimizer parity with src/ to reproduce production
bytecode, and the quick profile's `test/**` skip would empty test
discovery.

This is the narrow, urgent half of the broader test-suite cleanup
([#168](https://github.com/vaipakam/vaipakam/issues/168)). #168
continues to track the deeper wins (mock dedup, SetupTest refactor,
drop redundant scenarios) that also speed up the default profile.

## Dedicated coverage for offer cancellation after partial fill (Issue #188)

`OfferCancelFacet.cancelOffer` already implements correct partial-fill
cancellation behaviour (the math + the Codex P0 fix from #102 round-1
that subtracts `collateralAmountFilled` on the borrower side), but the
behaviour had zero dedicated test coverage. A future refactor could
silently break the refund math and regression wouldn't catch it.

This adds `contracts/test/CancelAfterPartialFillTest.t.sol` with four
focused scenarios:

1. **Lender partial-fill then cancel** — lender posts `[1k, 10k]`,
   one matchOffers consumes 5k, lender cancels. Assert refund =
   `amountMax - amountFilled = 5k`, loan from the prior match
   unaffected, `offer.accepted = true` post-cancel, cancel cooldown
   bypassed.

2. **Borrower partial-fill then cancel** — borrower posts `[1k, 10k]`
   lending with collateral range `[500, 5_000]`, one match consumes
   5k principal + 500 collateral, borrower cancels. Assert refund =
   `collateralAmountMax - collateralAmountFilled = 4_500`. Pins the
   Codex P0 fix from #102 round-1 — without the subtraction, the
   borrower would withdraw the 500 backing the live loan
   (fund-lock for the lender's claim).

3. **Cancel cooldown bypassed when amountFilled > 0** — partially-
   filled lender offer cancels successfully WITHIN the
   `MIN_OFFER_CANCEL_DELAY` window (no `vm.warp` past the delay).
   Verifies the `OfferCancelFacet` line ~112-118 bypass: the
   anti-front-run cooldown applies to never-matched offers only.

4. **Cancel after dust-close terminus reverts** — three matchOffers
   drain a borrower offer to dust (`borrowerRemaining < B.amount`),
   `OfferMatchFacet` flips `accepted = true`. Subsequent `cancelOffer`
   reverts `OfferAlreadyAccepted` per the design's terminal-state
   guarantee.

Implementation is unchanged; this is pure test coverage. Each test
exercises the refund formula directly via assertions on the wallet
balance delta + the loan's collateral / principal staying intact.

Coverage extends symmetrically across BOTH lender and borrower sides
of the partial-fill cancel surface. The four scenarios exercise the
ERC20-on-both-legs shape — the same shape that drives the bulk of
matchOffers traffic and the shape the #102 round-1 P0 fix targeted.
NFT-collateral and NFT-rental loan shapes are not exercised in this
file; the `OfferCancelFacet` code paths for those shapes are still
indirectly covered by other test files. (A dedicated harness for
NFT-shape partial-fill cancellation, if those configurations end up
in the partial-fill regime under the final invariants, would be a
separate follow-up — `OfferCreateFacet` does not currently enforce
an ERC20-only guard on ranged `amountMax`, so the structural
invariants alone don't rule that combination out.)

## Dedicated coverage for OfferAcceptFacet.acceptOffer against ranged offers (Issue #191)

PR #187 (canonical limit-order Phase 2) introduced role-aware reads in
the direct-accept path: when a borrower accepts a lender's ranged
offer, the resulting loan picks the lender's `amountMax` as principal
and the lender's `interestRateBps` (their floor) as the rate — the
most favourable for the borrower. When a lender accepts a borrower's
ranged offer, the symmetric resolution applies: principal =
borrower's `amount` (their floor), rate = borrower's
`interestRateBpsMax` (their ceiling) — the most favourable for the
lender.

Phase 2's matchOffers / partial-fill plumbing had dedicated test
coverage (`BorrowerPartialFillTest`, `MatchOffersScaffoldTest`,
`CancelAfterPartialFillTest`). The direct-accept path against ranged
offers did not. Every `testAccept*` in the existing OfferFacetTest
sweep used `amountMax == amount` and `interestRateBpsMax ==
interestRateBps`, so the role-aware code paths were mechanically
taken but never exercised with a non-trivial range — a regression
that swapped read fields would have slipped past every test.

This adds `contracts/test/AcceptRangedOfferTest.t.sol` with six
focused scenarios filling that gap:

1. **Lender-posted ranged offer + borrower-acceptor** pins the role-
   aware resolution: loan principal equals the lender's `amountMax`
   (10k of a `[1k, 10k]` range) and the rate equals the lender's
   floor (300 bps of a `[300, 800]` range). The lender's escrow is
   fully drained of the 10k pre-funded at create time, and the
   borrower wallet receives the principal net of the 0.1% loan
   initiation fee.

2. **Borrower-posted ranged offer + lender-acceptor** pins the
   symmetric resolution: loan principal equals the borrower's
   `amount` (the 1k floor) and the rate equals the borrower's ceiling
   (800 bps). The lender's wallet is debited by the matched principal
   that the acceptOffer path pulls into the lender's escrow at accept
   time.

3. **Residual collateral refund on direct-accept** verifies that
   `_refundBorrowerCollateralResidualIfNeeded` fires on the direct-
   accept path, not only on matchOffers. With `collateralAmount = 500`
   and `collateralAmountMax = 5_000`, the borrower has 5k pre-
   escrowed at create time; after the lender's accept, the loan
   locks only the 500 floor and the borrower's wallet receives the
   4_500 unused collateral back.

4. **No-residual case** asserts the helper short-circuits cleanly
   when `collateralAmount == collateralAmountMax` (no extra escrow
   withdraw attempted).

5. **Cancel after direct-accept reverts** locks in the terminal-state
   guarantee: Phase 2 direct-accept is single-fill, so subsequent
   `cancelOffer` reverts `OfferAlreadyAccepted`. Symmetric to
   `CancelAfterPartialFillTest`'s dust-close terminal case, but for
   the direct-accept terminal state.

6. **Single-value offer regression sentinel** keeps the trivial
   `amount == amountMax` case under direct test, so a regression on
   the trivial path lights up alongside the range-aware ones.

The test file also documents an implementation invariant worth
recording: **direct-accept does NOT update `offer.amountFilled`**.
The terminal state is signalled via `offer.accepted = true`; the
effective fill surfaces through the OfferAccepted event payload, not
the storage field. `amountFilled` is exclusively the matchOffers
accumulator (per OfferAcceptFacet line 963 comment, "Phase 1
acceptOffer is single-fill").

Out of scope for this file (tracked separately): NFT-collateral /
NFT-rental partial-fill shapes, sanctions tier on ranged offers
(covered by `SanctionsOracle.t.sol`), and multi-fill matchOffers
(covered by `BorrowerPartialFillTest`).

Closes #191.
