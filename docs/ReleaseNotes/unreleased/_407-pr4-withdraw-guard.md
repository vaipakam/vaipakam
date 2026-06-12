# #407 PR 4 — vault encumbrance withdraw guard (T-407-B)

The fourth piece of the vault-encumbrance sub-ledger from issue #407 lands the
**enforcement** half of the design that PRs 1–3 prepared. Before this PR the
encumbrance aggregate (`encumbered[user][asset][tokenId]`) was a passive ledger:
loan-init wrote to it, loan-lifecycle terminals cleared it, view selectors on
`MetricsFacet` reported it — but the actual vault withdraw chokepoints did not
consult it. PR 4 reads the aggregate at the chokepoint and refuses any withdraw
whose amount would dip into an active lien.

What a normal user sees on a healthy path is **nothing**: every loan-lifecycle
terminal releases its lien before reaching the withdraw, so a normal repay /
preclose / refinance / default / liquidation flow passes through the guard
without change. What changes is the system's response to a drifted release
wire on a future facet: instead of silently letting the proxy drain past what
the lien protects, the diamond now reverts with a precise, operator-readable
error that pinpoints which `(user, asset, tokenId)` aggregate is binding and
how much of the requested amount overshot the free balance.

This PR also clarifies the lien's scope. The original PR 1 wired collateral
lien creation for **every** loan, but for NFT-rental loans the "collateral" is
actually the borrower's escrowed prepay+buffer pool — designed to flow out
continuously as the rental period elapses (daily rental deduction, partial
repay, lender claim). Locking that pool would block legitimate flows the
lender depends on. Lien creation is now gated to ERC20 loans only — the
pool-based rental's lender protection is handled by the structured rental
accounting (`heldForLender`, `protocolTrackedVaultBalance`, `bufferAmount`),
which the sub-ledger never improved upon.

Coverage extends across all three asset shapes — ERC-20, ERC-721, and ERC-1155
— with the ERC-721 path reading the encumbrance aggregate directly so a
withdraw of a non-existent tokenId still surfaces the original proxy error
(rather than a misleading `ownerOf` revert), and the ERC-1155 path keyed on
the per-tokenId balance. The release wires now live in every loan-lifecycle
terminal that exists today — `RepayFacet.repayLoan`, `PrecloseFacet.precloseDirect`,
`RefinanceFacet._refinanceLoanLogic`, `DefaultedFacet.triggerDefault`, and
`RiskFacet`'s atomic/split/discounted liquidation entries — each positioned
**before** any vault withdraw the flow executes, so the guard never blocks
the terminal's own settlement transfers.

A targeted test suite walks the guard's branches (boundary at exactly the
free balance, one wei past, multi-lien accumulation, release-then-drain) and
re-affirms that the existing `OnlyDiamondInternal` modifier still fires for
external EOA callers — the guard is layered on top of the access gate, not a
replacement. The full no-invariants regression (2571 tests) passes; an
unrelated pre-existing CCIP test (`test_DepositVPFI_TriggersBroadcastToMirror`)
continues to fail and is tracked separately.

The remaining T-407-C step (offer-principal-lock enforcement on the lender
side) and T-407-D (dapp-side display of the lien) are tracked separately and
will land in follow-up PRs.
