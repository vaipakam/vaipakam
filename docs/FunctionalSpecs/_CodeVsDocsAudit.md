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
| 2026-06-30 | `EarlyWithdrawalFacet.completeLoanSale` / `PrecloseFacet.completeOffset` (completion-path deferred proceeds) | `docs/DesignsAndPlans/SanctionsAndTermsGateMatrix.md` § Open gaps (f) tail | The #821 vault-lock + freeze closed the repay/default/liquidation close-outs, but the **completion** paths where a buyer is already committed (`completeLoanSale` / `completeOffset`) were not folded in: a seller/holder flagged after the sale was initiated could still brick the completion (stranding the committed buyer) rather than parking the flagged share locked. Same vault-lock treatment applies; deferred from #821's first pass to keep that PR scoped. Candidate fix: wrap their loan-party deposits in `LibSanctionedLock`. | pending triage — tracked as #831 |

## Resolved findings

| Date opened | Divergent symbol | Resolution | Closed by |
|-------------|------------------|------------|-----------|
| 2026-06-29 | `VaultFactoryFacet.getOrCreateUserVault` recipient-vault brick on `repayLoan` / `triggerDefault` / HF-liquidation | **Vault-lock + freeze.** A receive-side `getOrCreateUserVault` exemption (`sanctionedDepositExemptUser`, pinned exact-address, never mints a vault for a flagged wallet) lets these close-outs deposit the flagged recipient's share into their OWN existing vault instead of bricking, so the unflagged counterparty is made whole; `LibSanctionedLock` wraps each deposit + emits `SanctionedProceedsLocked`. The share is FROZEN: `claimAsLender`/`claimAsBorrower` now screen the stored vault owner, so a flagged party's vault assets don't move even to a clean current holder (protocol position sales migrate the stored party, so legitimate buyers are unaffected). Parallel-sale `recordOfferSaleProceeds` live-lender leg screened at fill. `cancelOffer` intentionally still reverts (creator's own escrow → freeze, not a counterparty path). Verified: `SanctionsOracle.t.sol::test_SanctionedLender_RepayLocksProceeds_ClaimFreezesUntilCleared` + 214 default/liquidation/repay/claim regression. | #821 |
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
