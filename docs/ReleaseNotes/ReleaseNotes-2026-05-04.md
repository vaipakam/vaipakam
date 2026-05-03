# Release Notes — 2026-05-04

Functional record of work delivered on 2026-05-04, written as
plain-English user-facing / operator-facing descriptions — no code.
Continues from
[`ReleaseNotes-2026-05-03.md`](./ReleaseNotes-2026-05-03.md).

Coverage at a glance: **Escrow protocol-tracked balance counter shipped
ahead of T-054**. The per-(user, token)
`protocolTrackedEscrowBalance` mapping landed today as the architectural
chokepoint refactor. Every protocol-side ERC-20 deposit / withdrawal
flows through `EscrowFactoryFacet.escrowDepositERC20` (or its cross-
payer / counter-only siblings), so the counter stays the symmetric
mirror of all protocol-mediated escrow movements. The Asset Viewer
now displays `min(balanceOf, protocolTrackedEscrowBalance)` so
unsolicited dust is structurally hidden from the UI. The future
stuck-token recovery flow (T-054) will cap recovery at
`max(0, balanceOf - tracked)` — the arithmetic itself becomes the
load-bearing safety property.

---

## What changed under the hood

### A new chokepoint for protocol-side ERC-20 deposits

`EscrowFactoryFacet.escrowDepositERC20(user, token, amount)` was
previously a thin forwarder that called the proxy's `depositERC20`.
Most production flows bypassed it, doing direct
`IERC20.safeTransferFrom(user, escrow, amount)` from facet code. That
asymmetry meant any per-(user, token) running counter would only see
withdrawals (which all flow through `escrowWithdrawERC20`) and never
deposits — the counter would underflow on the first legitimate
withdraw.

The refactor turns `escrowDepositERC20` into the single chokepoint:
it pulls `amount` directly from the user's wallet (via the Diamond's
existing allowance) into the user's escrow proxy, AND increments the
counter under `user, token`. Two siblings handle the cases the simple
chokepoint can't cover:

- **`escrowDepositERC20From(payer, user, token, amount)`** — cross-
  payer variant. Used by repay / preclose / refinance flows where the
  borrower pays into the lender's escrow. Pulls from `payer`'s
  allowance, credits `user`'s escrow, ticks the counter under `user`.
- **`recordEscrowDepositERC20(user, token, amount)`** — counter-only
  sibling. Used after Permit2 has already moved funds (the transfer
  happens via the signed permit; this just updates the counter so it
  doesn't drift).

Plus a public view: **`getProtocolTrackedEscrowBalance(user, token)`**
that consumers (Asset Viewer, the future recovery flow) read.

### Every production deposit migrated to the chokepoint

The refactor sweeps across:

- **OfferFacet** — `_pullCreatorAssetsClassic` (lender ERC-20 lending,
  borrower ERC-20 collateral on offer creation, NFT-rental prepay) and
  `_acceptOffer`'s borrower-side collateral / prepay paths. The
  Permit2 paths use the counter-only sibling after the Permit2 pull.
- **AddCollateralFacet** — top-up of an active loan's collateral.
- **VPFIDiscountFacet** — `depositVPFIToEscrow` and the Permit2
  variant. Both now route through the chokepoint so VPFI staking
  ticks the counter consistently with every other protocol asset.
- **RepayFacet** — borrower → lender's-escrow principal+interest at
  full repayment; NFT-rental settlement of the lender's rental share;
  fallback collateral re-deposit on cure.
- **PrecloseFacet** — borrower → lender's-escrow at precloseDirect;
  the offset-with-new-offer payment to the old lender; Alice's
  shortfall path on transferObligationViaOffer.
- **RefinanceFacet** — borrower → old-lender's-escrow at refinance.
- **EarlyWithdrawalFacet** — Diamond → new-lender's-escrow on
  position-buy completion (both classic + sale paths).
- **ClaimFacet** — the Diamond → escrow re-distribution at retry-
  succeeds and fallback-collateral split.
- **RiskFacet** — HF-liquidation Diamond → lender / borrower escrow
  proceed splits.
- **DefaultedFacet** — time-based default Diamond → lender / borrower
  escrow proceed splits; illiquid-collateral transfer-to-lender;
  rental prepay-to-lender on default.
- **LibFacet.depositFromPayerForLender** — internal helper used by
  position-buy flows.

That's ~20 production deposit sites now uniformly tracked.

### What was deliberately NOT changed in this PR

- **Staking checkpoint min-clamp.** The
  `LibStakingRewards.updateUser` / `LibVPFIDiscount.rollupUserDiscount`
  callers still pass the raw `balanceOf` of the user's escrow VPFI as
  the new staked balance. Switching them to
  `min(balanceOf, protocolTrackedEscrowBalance[user][vpfi])` would
  drop existing testnet stakers' effective stake to zero (legacy
  stakes have `tracked = 0` since the counter just shipped today).
  This is a separate migration that needs either a counter backfill
  script or a coordinated re-stake; deferred to a future PR.
- **Recovery flow itself.** The recovery flow (T-054) is unchanged
  by this PR. The counter is the architectural pre-requisite that
  recovery will eventually consume; recovery's `max(0, balanceOf -
  tracked)` cap and `disown` event-only function ship in T-054 PR-3.

### Test infrastructure changes

`HelperTest.sol`'s two `EscrowFactoryFacet` selector lists
(`getEscrowFactoryFacetSelectors` / `getEscrowFactoryFacetSelectorsExtended`)
each grew by 3 entries (`escrowDepositERC20From`,
`recordEscrowDepositERC20`, `getProtocolTrackedEscrowBalance`).

Tests that previously seeded escrow balances via direct
`ERC20.transfer(escrow, …)` / `deal(token, escrow, …)` /
`ERC20Mock.mint(escrow, …)` — bypassing the protocol path — were
updated to follow each direct seed with a
`recordEscrowDepositERC20(user, token, amount)` call so the counter
agrees with the on-chain balance and the subsequent
`escrowWithdrawERC20` doesn't underflow. Affected files:
RefinanceFacetTest, ClaimFacetTest, LoanFacetTest, RepayFacetTest,
EarlyWithdrawalFacetTest, VPFIDiscountFacetTest (auto-applied across
8 patterns).

`testEscrowDepositERC20` was rewritten under the new semantics: the
chokepoint pulls from the user's allowance to the Diamond, not from
the Diamond's own balance. Two new sibling tests landed:
`testEscrowDepositERC20From` (cross-payer) and
`testRecordEscrowDepositERC20` (counter-only).

Four failure-mode tests that mocked
`EscrowFactoryFacet.getOrCreateUserEscrow` to revert
(`testRefinanceLoanGetLenderEscrowFails`,
`testPrecloseDirectGetLenderEscrowFails`,
`testTransferObligationGetEscrowFails`,
`testRepayLoanCrossFacetCallFailed`) now mock
`EscrowFactoryFacet.escrowDepositERC20From` instead — the escrow
resolution that was previously a separate cross-facet call now lives
inside the chokepoint, so the mock target shifted accordingly.
The tests still exercise the same failure-propagation guarantee:
when the protocol's escrow plumbing fails, the calling flow must
bubble the revert up.

### Frontend

The Asset Viewer page now reads `min(balanceOf, tracked)` per token.
For each protocol-managed token configured in the active chain's
deployment record, the page issues two parallel reads —
`IERC20.balanceOf(escrow)` and
`EscrowFactoryFacet.getProtocolTrackedEscrowBalance(user, token)` —
and displays the lesser of the two. Unsolicited dust that arrives
via direct `IERC20.transfer` is structurally hidden from the UI.

### Testnet display cutover (one-time, documented)

Existing testnet deploys have stakes / collateral that were deposited
before the counter shipped. Those deposits never ticked the counter
(it didn't exist), so for those users `tracked = 0` while
`balanceOf > 0`. Under the new display rule, those balances render
as `0` until the user re-deposits via the new chokepoint.

Acceptable for testnet — we communicate this once to existing testers
("re-deposit your VPFI / collateral once after the upgrade to refresh
the display"). On a fresh mainnet deploy this case never occurs
because the counter starts ticking from day 1.

For the future T-054 recovery flow, this cutover matters more: a
recovery cap of `max(0, balanceOf - tracked)` on a legacy
unrecorded-balance escrow would treat ALL the legacy balance as
unsolicited and allow recovery to drain it. The recovery flow MUST
NOT ship until the counter is bootstrapped for legacy balances —
either via a migration script that walks active loans / stakes /
claims, or via a coordinated re-deposit cycle. Captured in
`docs/DesignsAndPlans/EscrowStuckRecoveryDesign.md`'s open-questions
section as a deploy-day prerequisite for T-054.

---

## Verification

- New tests: `testEscrowDepositERC20From`, `testRecordEscrowDepositERC20`
  — both green. Existing `testEscrowDepositERC20` rewritten under new
  semantics — green.
- Full no-invariants regression: **1596 passing / 0 failed / 5 skipped**
  (up from 1594 yesterday; net +2 from the new chokepoint tests).
- `forge build` clean.
- Frontend `tsc -b --noEmit` clean.
- ABIs re-exported to the frontend + keeper-bot.

---

## What's next

The counter is the architectural pre-requisite for the stuck-token
recovery flow (T-054). With this landed, the next steps in the T-054
sequence are:

- **PR-2**: switch the staking checkpoint to read
  `min(balanceOf, tracked)`. Requires counter backfill for legacy
  testnet stakes; design that migration first.
- **PR-3**: ship `recoverStuckERC20` + `disown` + EIP-712 verifier.
  Recovery cap `max(0, balanceOf - tracked)` is now correct because
  the counter is comprehensive.
- **PR-4**: frontend `/recover` page + Advanced User Guide deep-link
  + escrow-address redaction (the redaction part already shipped on
  2026-05-03).
- **PR-5**: post-deploy analytics labeling per
  `docs/ops/AnalyticsLabelRegistration.md`.

The escrow-address redaction + Asset Viewer + receiver-hook hardening
that shipped on 2026-05-03 + the counter chokepoint that shipped today
together complete the "user-facing escrow surface is locked down,
and protocol-managed balance is structurally tracked" milestone.
The recovery flow itself is the only remaining piece of the security-
audit thread.
