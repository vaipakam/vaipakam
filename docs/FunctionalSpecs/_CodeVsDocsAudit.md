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
| — | _(none currently open)_ | — | — | — |

## Resolved findings

| Date opened | Divergent symbol | Resolution | Closed by |
|-------------|------------------|------------|-----------|
| 2026-06-13 | `VPFIDiscountFacet.withdrawVPFIFromVault` | VPFI vault withdrawal now checks free balance through the encumbrance ledger (`LibEncumbrance.freeBalance`, subtracting the caller's VPFI encumbrance) before releasing, so VPFI backing a live loan as ERC-20 collateral can't exit the vault without the HF-checked path — closing the staking-unwind drain. Verified: `forge test --match-contract VPFIDiscountFacetTest --match-test test_F1_withdrawVPFIFromVault -vv`. | PR #572 (#565, T-407-B v2); bug card #570; blocker-verify #794 |
| 2026-06-14 | `ClaimFacet._claimAsLenderImpl` (VPFI lender-proceeds reservation release) | The #585 lender-proceeds reservation now records and releases under the **actual** encumbered asset (`s.lenderProceedsEncumberedAsset[loanId]`), not `loan.principalAsset`, so the in-kind / illiquid VPFI-collateral default terminal reserves + frees the correct bucket. Verified: `forge test --match-contract Vpfi592LenderProceedsTest -vv`. | #592 (PR #596; verified + closed under #795) |
| 2026-05-22 | `ADR-0004` "every cross-chain contract carries `GuardianPausable`" (over-broad — `VpfiPoolRateGovernor` does not extend it) AND `ConfigureCcip._setGuardians` does not wire `VPFIMirrorToken` | **Both directions addressed.** ADR-0004 wording qualified to "every cross-chain contract with a runtime send / receive path" + enumerated the contracts that carry the pause base + named `VpfiPoolRateGovernor` as the intentional exception (rate-limit admin only, no runtime send/receive). `ConfigureCcip._setGuardians` extended to wire `VPFIMirrorToken` on mirror chains (the canonical `VPFIToken` is OFT-shaped and paused via its own AccessControl path, not the cross-chain guardian — left untouched). | #200 + #201 |

---

*Maintained by the project owner; review-surfaced findings appended by
reviewers (human or AI) with a one-line description.*
