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
