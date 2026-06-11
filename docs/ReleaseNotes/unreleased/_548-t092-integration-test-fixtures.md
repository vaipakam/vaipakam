## Thread — T-092 #548: reusable integration test fixture helpers

Foundation work for the upcoming #539 atomic accept-and-refinance integration test + future T-092 multi-actor scenarios. Extracted as its own PR to keep the #539 implementation diff focused on the contract change rather than test infrastructure.

### What's new

**Three internal helpers on `SetupTest`**, available to every test inheriting from it:

| Helper | Purpose |
|---|---|
| `_provisionFundedActor(name, token, walletAmount)` | Provision a new actor with `walletAmount` wei minted to their wallet + a max diamond approval on `token`. Returns the actor address. |
| `_fundActorVault(actor, token, amount)` | Direct-transfer + `recordVaultDepositERC20` pattern to fund an existing actor's vault. Mirrors the `_acceptBorrowerOffer` setup that RefinanceFacetTest uses for `newLender`. |
| `_provisionFundedActorWithVault(name, token, totalAmount)` | Convenience: actor with wallet AND vault funded (50/50 split) + standing diamond approval. The most common shape for atomic-flow tests. |
| `_grantStandingApprovalToDiamond(actor, token)` | Set a standing diamond approval on `token` for an existing actor (when the test reuses one of the standard fixture's actors but needs the approval set independently). |

### Why this matters

PR #542 (#539 first attempt) couldn't ship a happy-path integration test because the existing SetupTest fixture didn't carry the multi-actor allowance / vault dance needed. With these helpers any integration test can:

```solidity
function test_AtomicAcceptAndRefinance_HappyPath() public {
    uint256 oldLoanId = _buildActiveLoan();
    // ... borrower sets caps + creates refinance-tagged offer ...

    // One-line setup for the new lender:
    address newLender = _provisionFundedActorWithVault(
        "atomicNewLender", mockERC20, LOAN_PRINCIPAL * 2
    );

    vm.prank(newLender);
    OfferAcceptFacet(address(diamond)).acceptOffer(refinanceOfferId, true);

    // Assertions on both loans' status ...
}
```

### Smoke tests

Two new tests in `T092AutoLifecycleIntegrationTest` exercise the helpers:

- `test_T092Fixture_NewLenderProvisioning` — verifies wallet balance + vault proxy balance + max diamond approval after the 50/50 helper.
- `test_T092Fixture_GrantStandingApproval` — verifies the standalone approval helper works on a fresh actor.

### Verification

- forge build clean.
- T092AutoLifecycleIntegrationTest 19/19 green (was 17, +2 smoke tests).
- Deploy-sanity 12/12.
- RefinanceFacetTest 35/35 (no regression).

### Out of scope

- The full atomic-accept-and-refinance integration test that uses these helpers — that lands with #539 implementation.
- Multi-collateral-type test variants (ERC721 / ERC1155 collateral scenarios) — separate follow-up.
