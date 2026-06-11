## Thread — T-092-A: refinance fund-source review and design clarification (#530)

#530 was originally framed as a vault-first wallet-fallback fund source for `RefinanceFacet.refinanceLoan`. Codex review on PR #538 caught a real correctness issue (round-1 P2): `protocolTrackedVaultBalance` is an aggregate counter that includes funds locked in active lender offers (which sit in the creator's own vault — `OfferCreateFacet._pullCreatorAssetsClassic`). A vault-first netting could double-spend committed funds, breaking downstream offer fills.

**Decision:** revert the vault-first path. Keep the existing wallet-pull flow as the canonical refinance payment source.

### Why this is OK

The user's original concern — "wallet pull requires a Metamask popup, how is it automatic?" — was already addressed by the standing approval pattern. At consent time, the borrower calls `IERC20.approve(diamond, …)` once. Every later `safeTransferFrom(borrower, …)` operates on the existing allowance — no popup at refinance time. The keeper-driven path works fully automatically.

Operational loan netting is preserved by the existing flow: `OfferAcceptFacet.sol:840` routes the new lender's principal to the borrower's WALLET on accept, and the refinance immediately pulls from the same wallet to pay the old loan. The new principal cycles in then out within a single tx — that's the same net outcome a vault-first design would have produced, just routed through the wallet allowance pathway.

### Test addition

A new positive-flow test `test_T092A_RefinanceWalletPath_StandingApprovalNoPopup` exercises the borrower-direct refinance happy path and asserts the wallet drains by approximately the payoff amount — documenting that operational netting is preserved via the wallet cycle. The two vault-first scenarios drafted earlier in this PR were removed alongside the contract revert.

### True vault-first netting requires a deeper change

A proper vault-first refinance netting would require invariant-preserving locked-balance tracking: a counter (or per-flow reservation) that distinguishes "free" vault funds from "committed to an active lender offer" funds. That's a meaningful architectural change touching `OfferCreate / OfferAccept / OfferCancel` and is out of scope for this PR. The wallet path is correct + audit-clean today.

### Verification

- forge build clean.
- RefinanceFacetTest 35/35 (was 34, +1 new wallet-path positive scenario).
- Deploy-sanity 12/12.
- ABI re-export unchanged (no contract surface changes after revert).

### What to do if vault-first netting becomes a requirement later

File a follow-up card for **locked-balance tracking** as the prerequisite. Once the protocol has a clean separation between free + committed vault funds, vault-first refinance netting becomes a small surgical change.
