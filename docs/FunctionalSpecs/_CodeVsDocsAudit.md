# Code vs Docs Audit

`docs/FunctionalSpecs/` is the **code-INDEPENDENT specification** of what
the platform is **intended** to do — the test oracle. The contract code is
the thing *under test*, never the *source* of the spec. (See
`docs/FunctionalSpecs/README.md` for the full rules; the load-bearing one
is: the spec is sourced from documents, never transcribed from code.)

This file records places where observed code behaviour diverges from what
the spec says is intended. Each divergence is a **candidate bug** (the
code is wrong and the spec is right) OR **a stale doc** (the spec needs
to catch up with an intent-decision the project owner has since made) —
the two are never silently reconciled. Code-observed behaviour enters the
spec ONLY via an explicit intent-decision from the project owner, not by
copying what the code does.

## How to use this file

1. When review surfaces a contract behaviour that doesn't match
   `docs/FunctionalSpecs/<domain>.md`, append a row to **Open findings**
   below with: date, the divergent symbol (`Facet.function` or
   spec-section reference), one-line summary, and a status of `pending
   triage`.
2. Triage decides:
   - **Code is wrong** → file a bug-fix card on `@vaipakam-labs`,
     reference this entry from the card body. When fixed, move the
     finding to **Resolved findings** with the closing PR / commit.
   - **Spec is wrong** → owner provides an intent-decision in writing,
     the spec doc is updated, the finding moves to Resolved with the
     intent-decision note + the closing spec-update PR.
3. Open findings count is itself audit-relevant — a growing list signals
   drift; auditors will read this file.
4. **Keep row state current.** When a finding's linked issue / PR is
   verified and closed, move the row from **Open findings** to **Resolved
   findings** in that same cleanup pass (with the closing PR and, where
   useful, the verification command) — don't leave fixed launch-blockers
   sitting under Open, where readers mistake them for live.

## Open findings

| Date | Divergent symbol | Spec section | One-line summary | Status |
|------|------------------|--------------|------------------|--------|
| 2026-07-03 | `EarlyWithdrawalFacet.createLoanSaleOffer` (+ its mocked-only test coverage) vs WebsiteReadme "The lender can instead LIST the position for sale" | WebsiteReadme lender early-exit | The listing entry point cannot complete on-chain: `_submitSaleOffer` cross-facet-calls the `nonReentrant` `createOffer` under the diamond-shared guard (reverts `ReentrancyGuardReentrantCall`), and the collateral=0 vehicle trips `MaxLendingAboveCeiling`; every green test mocks the inner hop (`vm.mockCall`), and the Anvil P-T scenario is SKIPPED for exactly this. alpha02 withholds the listing form (`LOAN_SALE_LISTING_ENABLED = false`) and blocks accepting linked-loan offers until fixed. | tracked as #951 |
| 2026-07-03 | `VaipakamNFTFacet` (no mint-counter / existence view) vs WebsiteReadme "the Vaipakam NFT verifier must distinguish between a valid live NFT, a burned NFT, and a token ID that was never minted" | WebsiteReadme Key UX Requirements | `ownerOf` reverts identically for burned and never-minted ids and `nftStatuses` is deleted on burn, so no on-chain read distinguishes the two; alpha02's verifier (PR pending) states both possibilities honestly instead. Full three-way distinction needs a contract view (e.g. expose `s.nextTokenId`). | pending triage |
| 2026-07-02 | `apps/defi` Create Offer NFT-rental daily fee (`offerSchema.toCreateOfferPayload` non-ERC20 amount path) | WebsiteReadme "Key UX Requirements" (amounts in human token units) | The form hint says the daily rental fee is entered "in whole tokens", but the NFT-leg payload passes the typed number through UNSCALED — a user typing "10" lists a daily fee of 10 wei of the prepay asset, mispricing every rental created through the form. apps/alpha02 scales by the payment asset's decimals instead (PR #887); the two live apps now diverge and defi's behaviour looks like the bug. | pending triage |

## Resolved findings

| Date opened | Divergent symbol | Resolution | Closed by |
|-------------|------------------|------------|-----------|
| 2026-06-30 | `EarlyWithdrawalFacet.completeLoanSale` / `PrecloseFacet.completeOffset` (completion-path deferred proceeds) | **Vault-lock the buyer's receive on `completeLoanSale`; `completeOffset` needed no change.** A BUYER (`newLender`) flagged AFTER committing the sale bricked `completeLoanSale` because the shortfall deposit (`depositFromPayerForLender` → `vaultDepositERC20From`) and the held migration both resolve the buyer's vault through the screened `getOrCreateUserVault`. Wrapped the two shortfall deposits in `LibSanctionedLock.begin`/`end` and the held migration in `depositLocked`, so the completion finishes and the buyer's share parks frozen behind the #821 freeze (the seller side already arms the move-out exemption from #597). `completeOffset` (`_completeOffsetImpl`) does NO completion-time vault deposit/withdraw — it only records claims + transitions; the deferred proceeds (borrower collateral, lender held) move at claim time, already handled by #821 (`_resetNftRenter`'s `vaultSetNFTUser` reads the vault directly and does not screen). Verified: `EarlyWithdrawalFacetTest.t.sol::test_completeLoanSale_FlaggedBuyer_CompletesNotBricked` + the EarlyWithdrawal/Preclose/Claim/Sanctions regression. | #831 |
| 2026-06-29 | `VaultFactoryFacet.getOrCreateUserVault` recipient-vault brick on `repayLoan` / `triggerDefault` / HF-liquidation | **Vault-lock + freeze.** A receive-side `getOrCreateUserVault` exemption (`sanctionedDepositExemptUser`, pinned exact-address, never mints a vault for a flagged wallet) lets these close-outs deposit the flagged recipient's share into their OWN existing vault instead of bricking, so the unflagged counterparty is made whole; `LibSanctionedLock` wraps each deposit + emits `SanctionedProceedsLocked`. The share is FROZEN by a **position-NFT transfer restriction** (`VaipakamNFTFacet.transferFrom`/`safeTransferFrom` reject a flagged `from`/`to`) plus the **live-claimant** (`msg.sender`/`nftOwner`) claim screens: a flagged wallet can't move a position in or out of itself AND can't claim while holding it. The claim paths intentionally do NOT screen the stored `loan.lender`/`loan.borrower` — for a non-consolidated (NFT-rental) loan the claim arms the exact-address move-out exemption so a LEGITIMATE pre-flag secondary-market buyer can still withdraw from a stale-flagged stored vault (the #594/#659 protection is preserved). Parallel-sale `recordOfferSaleProceeds` live-lender leg screened at fill. `cancelOffer` intentionally still reverts (creator's own escrow → freeze, not a counterparty path). Verified: `SanctionsOracle.t.sol::test_SanctionedLender_RepayLocksProceeds_ClaimFreezesUntilCleared`, `VaipakamNFTFacet.t.sol::test_SanctionedWallet_CannotTransferPositionNFT`, `CollateralConsolidation.t.sol::test_SanctionedStoredOwner_MoveStillSucceeds` + the default/liquidation/repay/claim/backstop regression. | #821 |
| 2026-06-29 | `apps/defi` `LegalGate.tsx` + `useTosAcceptance.ts` | The Terms gate now fails **CLOSED**: `useTosAcceptance` gates `hasAccepted` on a new `readOk` flag (true only after a successful read) and resets `currentVersion = 0` on a read error, so the unread/errored default can't be mistaken for the genuine gate-disabled state. `LegalGate` no longer renders `children` while `loading` (neutral loading state) or on `!readOk` (retry state) — it only passes through after a successful read shows accepted / genuinely-disabled. Verified: `pnpm --filter @vaipakam/defi exec vitest run test/components/LegalGate.test.tsx` (5 cases: holds closed on loading + on read error; opens on accepted/disabled; modal when enabled+not-accepted; no gate when disconnected). | #822 |
| 2026-06-29 | `RiskFacet.triggerLiquidationDiscounted` | Now screens the seized-collateral `recipient` arg (`_assertNotSanctioned(recipient)`) in addition to the caller, so a flagged recipient can't receive the bought collateral. Verified: `forge test --match-test test_triggerLiquidationDiscounted_RevertsWhenRecipientSanctioned`. | #816 (#815 group A) |
| 2026-06-29 | `DefaultedFacet.triggerDefault` / HF-liquidation (`attemptInternalMatchAutoDispatch`) | For a sanctioned matcher the objective internal match still executes (skipping it would let a flagged caller degrade settlement to the external/FallbackPending path), but the 1% incentive is zeroed and folded into the lenders' shares so no bonus reaches the flagged wallet. Verified: `forge test --match-test test_attemptAutoDispatch_sanctionedMatcher_settlesWithoutBonus`. | #817 (#815 group A) |
| 2026-06-29 | `NFTPrepayListingFacet` / `NFTPrepayDutchListingFacet` post+update | The manual fixed-price + Dutch `post*`/`update*` paths now call `_assertNotSanctioned` on the holder, matching the atomic/auto-list paths. Verified: `forge test --match-test revertsWhenHolderSanctioned`. | #818 (#815 group A) |
| 2026-06-29 | `PrecloseFacet.transferObligationViaOffer` / `EarlyWithdrawalFacet.createLoanSaleOffer` (initiation) | These keeper-authorizable **initiation** paths now screen the current position holder, not just `msg.sender`. (The **completion** paths `completeLoanSale` / `completeOffset`, where a buyer is committed, remain under the #821 deferred-proceeds finding.) Verified: `forge test --match-test "RevertsWhen*HolderSanctioned_viaKeeper"`. | #819 (#815 group A) |
| 2026-06-29 | `AddCollateralFacet.addCollateral` | Now screens the payer / current borrower-NFT holder (`_assertNotSanctioned(msg.sender)`), not just the stored `loan.borrower`. Verified: `forge test --match-test test_addCollateral_RevertsWhenTransferredHolderSanctioned`. | #820 (#815 group A) |
| 2026-06-13 | `VPFIDiscountFacet.withdrawVPFIFromVault` | VPFI vault withdrawal now checks free balance through the encumbrance ledger (`LibEncumbrance.freeBalance`, subtracting the caller's VPFI encumbrance) before releasing, so VPFI backing a live loan as ERC-20 collateral can't exit the vault without the HF-checked path — closing the staking-unwind drain. Verified: `forge test --match-contract VPFIDiscountFacetTest --match-test test_F1_withdrawVPFIFromVault -vv`. | PR #572 (#565, T-407-B v2); bug card #570; blocker-verify #794 |
| 2026-06-14 | `ClaimFacet._claimAsLenderImpl` (VPFI lender-proceeds reservation release) | The #585 lender-proceeds reservation now records and releases under the **actual** encumbered asset (`s.lenderProceedsEncumberedAsset[loanId]`), not `loan.principalAsset`, so the in-kind / illiquid VPFI-collateral default terminal reserves + frees the correct bucket. Verified: `forge test --match-contract Vpfi592LenderProceedsTest -vv`. | #592 (PR #596; verified + closed under #795) |
| 2026-05-22 | `ADR-0004` "every cross-chain contract carries `GuardianPausable`" (over-broad — `VpfiPoolRateGovernor` does not extend it) AND `ConfigureCcip._setGuardians` does not wire `VPFIMirrorToken` | **Both directions addressed.** ADR-0004 wording qualified to "every cross-chain contract with a runtime send / receive path" + enumerated the contracts that carry the pause base + named `VpfiPoolRateGovernor` as the intentional exception (rate-limit admin only, no runtime send/receive). `ConfigureCcip._setGuardians` extended to wire `VPFIMirrorToken` on mirror chains (the canonical `VPFIToken` is OFT-shaped and paused via its own AccessControl path, not the cross-chain guardian — left untouched). | #200 + #201 |

---

*Maintained by the project owner; review-surfaced findings appended by
reviewers (human or AI) with a one-line description.*
