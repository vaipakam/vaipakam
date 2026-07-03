# Round-3 PoC & Invariant Tests — authored-not-executed drafts

These three Foundry test files were written during the 2026-07-02/03 pre-live
security audit (see `../Findings20260702-SmartContractSecurityAudit.md`, umbrella
issue #892) to prove/disprove the top findings and add protocol-level invariants.

**Status: authored, NOT compiled or executed.** Foundry was unavailable in the
audit environment (the network policy blocked the toolchain download), so these
were written by mirroring existing passing suites but never run. They are kept
here as **reference drafts** deliberately located OUTSIDE the compiled tree
(`docs/` is not part of the Foundry `src`/`test`/`script` build), so they cannot
break the `contracts-fast` / deploy-sanity CI gate.

## To use them

1. Copy the three `.t.sol` files into `contracts/test/audit/`.
2. Run: `nice -n -10 ionice -c 2 -n 0 forge test --match-path 'test/audit/*' -vvv`
   (from `contracts/`).
3. Fix compile errors as they surface — they are drafts. One known issue was
   already fixed (`partial` is a reserved Solidity keyword → renamed
   `allowPartial`); expect others (facet signatures, struct field names, helper
   names) that only a compiler run can catch.
4. If you place them under `contracts/test/audit/`, add `audit` to the
   `SUBDIRS=(...)` chunk list in `contracts/script/run-regression.sh` — its
   exhaustiveness guard errors on any non-invariant `*.t.sol` under an unlisted
   subdirectory, so the local full-regression gate would otherwise fail before
   the PoCs run. (Flagged by Codex on PR #976.)

### Known assertion issues to fix before trusting a green run (Codex, PR #976)

- **`Round3CrossFacetInvariants.t.sol` (refinance sequence, ~line 338):**
  `lender1Before` is sampled *after* loan1 is accepted, so the old lender's
  balance is already down by the 1000-ether principal. After refinance the
  lender receives principal + interest, so `lender1After - lender1Before ≈
  PRINCIPAL + coupon` — comparing that whole delta to only `_fullTermCoupon(...)`
  makes the test fail even when interest is correct. Subtract the returned
  principal from the delta, or sample before loan1 acceptance.
- **`Round3CrossFacetInvariants.t.sol` (~line 440):** the post-terminal
  `claimAsBorrower` is wrapped in a bare `catch` that accepts *any* revert, so a
  genuine ownership/accounting/transfer regression would still pass the
  invariant (false confidence). Catch the expected no-claim selector explicitly
  and fail on any other error.

## What each file covers

| File | Findings exercised |
| --- | --- |
| `Round3LoanLifecyclePoC.t.sol` | H1 (#893), H4 (#914), M1 (#896) + M7 (#915) control |
| `Round3RewardsCrossChainPoC.t.sol` | H3 (#895), M6 (#911) |
| `Round3CrossFacetInvariants.t.sol` | refinance→periodic-settle→exit→claim sequence; collateral conservation; no-Active-with-snapshot; VPFI custody solvency (M17/#968 area, commingling #920) |

Expected outcomes and the exact assertions are documented inline in each file's
header comment. Each test asserts the current (buggy) behaviour so a green run
demonstrates the bug and a red run means it's been fixed — read the per-test
comments for the direction.
