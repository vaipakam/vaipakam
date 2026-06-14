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

## Open findings

| Date | Divergent symbol | Spec section | One-line summary | Status |
|------|------------------|--------------|------------------|--------|
| 2026-06-13 | `VPFIDiscountFacet.withdrawVPFIFromVault` | ProjectDetailsREADME §"Phase 1 Additions → Allow Borrower to Withdraw Excess Collateral (Health Factor)" | VPFI staking-unwind drains vault VPFI guarded only by raw `balanceOf` — if that VPFI backs a live loan as ERC-20 collateral, it exits with no HF check and no revert, bypassing the collateral-protection invariant the risk-checked withdrawal path enforces. **Triaged 2026-06-13: code-wrong** (VPFI IS collateral-eligible — safe under P2P + lender discretion; reflexivity spiral is a pooled-protocol risk that doesn't apply here). Fix: route through `LibEncumbrance.freeBalance` (subtract the caller's VPFI encumbrance), scope VPFI-as-ERC-20-collateral. Bug card #570; fix lands with #565 (T-407-B v2). Detail in `docs/DesignsAndPlans/EncumbranceLifecycleMap.md` §6 F-1. | triaged: code-wrong → #570 |
| 2026-06-14 | `ClaimFacet._claimAsLenderImpl` (VPFI lender-proceeds reservation release) | ProjectDetailsREADME §928 current-NFT-holder claim authority + §612 settlement-follows-NFT | The #585 reservation reserved + released keyed on `loan.principalAsset`, but the claimable asset is authoritatively `lenderClaims[loanId].asset` — the COLLATERAL asset on an in-kind/illiquid default (VPFI is collateral-eligible). So a VPFI-collateral default left the deferred VPFI claim unreserved (and a principal-keyed release would free the wrong `encumbered` bucket), leaving the #592 unstake-drain open for that terminal. **Code-wrong.** Fix (`docs/DesignsAndPlans/LenderProceedsReservationV2.md` §4.1): reserve on the deposited asset + release on `claim.asset`. Lands with #592 (PR #596). | code-wrong → #592 |

## Resolved findings

| Date opened | Divergent symbol | Resolution | Closed by |
|-------------|------------------|------------|-----------|
| 2026-05-22 | `ADR-0004` "every cross-chain contract carries `GuardianPausable`" (over-broad — `VpfiPoolRateGovernor` does not extend it) AND `ConfigureCcip._setGuardians` does not wire `VPFIMirrorToken` | **Both directions addressed.** ADR-0004 wording qualified to "every cross-chain contract with a runtime send / receive path" + enumerated the contracts that carry the pause base + named `VpfiPoolRateGovernor` as the intentional exception (rate-limit admin only, no runtime send/receive). `ConfigureCcip._setGuardians` extended to wire `VPFIMirrorToken` on mirror chains (the canonical `VPFIToken` is OFT-shaped and paused via its own AccessControl path, not the cross-chain guardian — left untouched). | #200 + #201 |

---

*Maintained by the project owner; review-surfaced findings appended by
reviewers (human or AI) with a one-line description.*
