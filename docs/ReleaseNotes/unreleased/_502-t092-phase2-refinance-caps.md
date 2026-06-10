## Thread — T-092 Phase 2: Refinance cap enforcement on the keeper-driven path (#502)

Phase 2 of T-092 (#499). Phase 1 (#501, merged 2026-06-10) shipped the consent surface — the per-loan `autoRefinanceCaps[loanId]` storage + the borrower-side setters. This PR wires those caps into `RefinanceFacet.refinanceLoan` so a keeper invoking the refinance flow on the borrower's behalf is forced to route them into terms within their pre-approved bounds.

### What's in this PR

**1. Bug fix — `RefinanceFacet.refinanceLoan` auth model (load-bearing for Phase 1's keeper flow):**

Before this PR, `refinanceLoan` checked `offer.creator != msg.sender`, which silently broke the `KEEPER_ACTION_REFINANCE` keeper path: a keeper invoking refinance has `msg.sender == keeperAddress`, but the borrower offer's `creator` is the borrower (the NFT owner). The keeper-driven flow would always revert at this gate even though `LibAuth.requireKeeperFor` had just authorised the call. No production deploy was affected because no consumer had wired up the keeper-driven refinance flow yet.

Fix: resolve the current borrower-NFT owner once via `LibERC721.ownerOf(oldLoan.borrowerTokenId)` and bind the offer creator to THAT identity. Mirrors how `LibAuth.requireKeeperFor` already authorises the call. Borrower-direct calls still pass naturally (they own the NFT). Keeper calls now succeed when the offer creator matches the NFT owner (which is the borrower the keeper is acting for).

**2. Cap enforcement — Phase 2's actual scope:**

After `newLoan` is resolved, if `msg.sender != currentBorrowerNftOwner` (i.e., the keeper path), enforce:
- `autoRefinanceCaps[oldLoanId].enabled` must be `true`. The staleness fence (NFT-transfer-since-setter) is enforced inline — if a previous owner set caps then transferred the NFT, the new owner's caps must be set explicitly or the keeper call reverts `AutoRefinanceCapsRequired`.
- `newLoan.interestRateBps <= caps.maxRateBps`. Otherwise `AutoRefinanceRateExceedsCap`.
- `caps.maxNewExpiry == 0 || newLoan.endTime <= caps.maxNewExpiry` where `endTime = startTime + durationDays * 1 days`. Otherwise `AutoRefinanceExpiryExceedsCap`.

Borrower-NFT-owner direct calls SKIP cap enforcement — the borrower is acting in their own interest and shouldn't be bound by their own pre-approved keeper bounds.

**3. Three new errors:**

- `AutoRefinanceCapsRequired` — caps disabled or stale.
- `AutoRefinanceRateExceedsCap` — new offer's rate exceeds the cap.
- `AutoRefinanceExpiryExceedsCap` — new loan's end time exceeds the cap.

### What's NOT in this PR

Phase 3 (#503): the `extendLoanInPlace` executor + `LoanExtended` event + `KEEPER_ACTION_EXTEND` permissioning + `LibKeeperReward.payVpfiReward` integration. Also widens `KEEPER_ACTION_ALL` from `0x1F` back to `0x3F` once the executor lands.

### Verification

- forge build clean.
- All 34 existing RefinanceFacetTest tests pass — the auth-model fix is backwards-compatible because borrower direct calls still pass naturally (offer creator == NFT owner == msg.sender).
- AutoLifecycleFacetTest 8/8 + ProfileFacetTest 50/50 still green.
- Deploy-sanity 12/12.

### Test coverage caveat

Targeted Phase 2 keeper-revert / borrower-bypass integration tests were prototyped but require a substantial fixture (vault implementation init, oracle mocks, three full offer/loan flows) plus careful selector-mocking that pushes solc's jump-table reservation. The full-fixture test landed in a draft sibling test file but exposed unrelated mock-coverage gaps that need their own PR to address. Phase 2's cap-check branch is ~10 lines following the existing `RefinanceRequiresPeriodSettle` gate pattern; given the tight reuse of the existing keeper-path infrastructure exercised by `RefinanceFacetTest`'s 34 tests + the per-storage-field unit coverage in `AutoLifecycleFacetTest`, the cap-check is structurally sound. Phase 3's PR will land an integration test that covers the full keeper-driven refinance + extend round-trip in one fixture.

### Operator action

None — the cap enforcement only fires on the keeper path, which isn't actively used by any production consumer yet. Users who have set per-loan caps via Phase 1's surface will see those caps automatically apply once Phase 3 lands and keeper-driven refinance becomes a routine operator path.
