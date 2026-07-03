# Smart-Contract Adversarial Security Audit — 2026-07-02

Full adversarial and security audit of the on-chain Vaipakam protocol
(EIP-2535 Diamond, Solidity 0.8.29, viaIR), performed pre-live at the
project owner's request.

- **Scope:** all facets under `contracts/src/facets/`, shared storage /
  libraries under `contracts/src/libraries/`, the per-user vault
  (`VaipakamVaultImplementation.sol`), the Diamond router
  (`VaipakamDiamond.sol`), the cross-chain layer
  (`contracts/src/crosschain/`), the swap adapters
  (`contracts/src/adapters/`), the VPFI token / vesting contracts
  (`contracts/src/token/`), and the Seaport listing integration.
  ~80.5k LOC across 156 Solidity source files, 60+ facets, 50+ libraries.
- **Out of scope (trusted):** OpenZeppelin Contracts Upgradeable,
  Chainlink CCIP router / token pools / feed registry, the on-chain
  V3-clone factories, Balancer V2 Vault, Tellor / API3 / DIA oracles,
  Uniswap Permit2, the reference keeper bot, the frontend, and the
  deploy scripts — per `docs/AuditIntake.md`.
- **Method:** seven parallel domain audits, each an adversarial
  line-by-line read of its files with the shared trust model from
  `docs/AuditIntake.md` and `CLAUDE.md`. Findings below are the
  consolidated, deduplicated result.

Overall the codebase is heavily hardened and reflects many prior review
rounds. No **Critical** issues were found. The crown-jewel surfaces —
`diamondCut` authorization, UUPS upgrade gating, oracle
staleness/scaling, CCIP message authentication, VPFI mint authorization,
borrower-LIF custody, and the discount tier-gaming defenses — were
verified sound. The actionable findings are concentrated in the
ERC-4907 NFT-rental lifecycle, the interaction-reward sweep, and a few
accounting / operational edges.

## Severity summary

| # | Sev | Title | Primary location |
|---|-----|-------|------------------|
| H1 | High | `autoDeductDaily` collapses the renter's ERC-4907 paid window at 2× | `RepayPeriodicFacet.sol:214` |
| H2 | High | Lender-offer ERC-721 rental never escrows the NFT (lender can rug renter) | `OfferAcceptFacet.sol:1159` |
| H3 | High | Permissionless interaction-reward sweep destroys a clean borrower's earned rewards | `LibInteractionRewards.sol:627` / `InteractionRewardsFacet.sol:198` |
| M1 | Medium | `repayPartial` double-charges interest already settled by periodic auto-liquidation | `RepayFacet.sol:680` |
| M2 | Medium | `VAULT_ADMIN_ROLE` can drain every vault via the impl-upgrade lever (trust-claim overstated) | `VaultFactoryFacet.sol:319` |
| M3 | Medium | Protocol-broadcast-budget exhaustion freezes VPFI unstaking (griefable) | `ProtocolBroadcastFacet.sol:244` |
| M4 | Medium | Terminal `setUser(0,0)` can revert and brick `repayLoan` | `VaipakamVaultImplementation.sol:513` |
| L1 | Low | `OfferMutate` skips create-time HF/LTV floor checks (fails late) | `OfferMutateFacet.sol:455` |
| L2 | Low | NFT-rental full repay reverts `InsufficientPrepay` once accrued rent > prepay (forces default) | `RepayFacet.sol:428` |
| L3 | Low | ERC-1155 rentals use single-slot `setUser`, clobbering concurrent renters | `OfferAcceptFacet.sol:1194` |
| L4 | Low | Reward *broadcast* ingress lacks the source-chain check the tier path enforces | `VaipakamRewardMessenger.sol:675` |
| L5 | Low | Numeraire valuation truncates to integer units → sub-unit loans un-liquidatable, slippage floor zeroed | `RiskFacet.sol:1919` |
| L6 | Low | Missing `_disableInitializers()` in the vault implementation | `VaipakamVaultImplementation.sol` |
| L7 | Low | `OwnershipFacet.transferOwnership` — no zero-address / two-step guard, desyncs `DEFAULT_ADMIN_ROLE` | `OwnershipFacet.sol:24` |
| L8 | Low | Interaction-reward pool-exhaustion truncation silently burns the remainder | `InteractionRewardsFacet.sol:114` |
| L9 | Low | Committing a buyback with both top-up targets zero bricks the fill | `LibTreasuryBuyback.sol:599` |
| H4 | High | `useFullTermInterest` coupon guarantee evadable by draining principal via `repayPartial` | `RepayFacet.sol:680` |
| M5 | Medium | Diamond owner can drain every vault / rewrite claims via `diamondCut` (distinct from M2) | `DiamondCutFacet.sol:35` |
| M6 | Medium | Core VPFI staking/loan-init on Base freezes if any single cross-chain lane is down (broader than M3) | `VPFIDiscountAccumulatorFacet.sol:106` |
| M7 | Medium | `interestSettled` not netted in transfer/offset/refinance/default/liquidation (M1 class broader) | `PrecloseFacet.sol:617` |
| L10 | Low | Discount-liquidation seizure inflatable by manipulating the collateral's live liquidity tier | `RiskFacet.sol:1479` |
| L11 | Low | `broadcastGlobal`/`sendVersionBumped` all-or-nothing across lanes + docstring mismatch | `VaipakamRewardMessenger.sol:380` |
| L12 | Low | `claimInteractionRewards`/`sweep` lack the Tier-1 sanctions gate | `InteractionRewardsFacet.sol:96` |

The table above lists the round-1/2 findings in detail. Rows H4/M5/M6/M7/
L10/L11/L12 are round-2 additions (see the "Round 2" section). **Rounds 4 and
5 (issues #934–#973) are summarized in the "Round 4" and "Round 5" sections
below.**

**Full five-round total: 7 High, 18 Medium, 26 Low = 51 findings — no
Critical.** All filed as individual GitHub issues (#893–#973) under umbrella
tracker #892. Informational items are listed at the end and in the umbrella.
Round 3 added no new severity findings beyond M8 (#919) / L13 (#920) — it was
verification (PoC + invariant tests, `contracts/test/audit/`) and economic
modeling (`Findings20260703-EconomicParameterModeling.md`).

---

## High

### H1 — `autoDeductDaily` collapses the renter's ERC-4907 paid window at 2×
- **Location:** `contracts/src/facets/RepayPeriodicFacet.sol:214-234`; stamped at accept in `OfferAcceptFacet.sol:1202`
- **Confidence:** Confirmed
- **Description:** At acceptance the renter's ERC-4907 expiry is set to an
  absolute `block.timestamp + durationDays * 1 days`. The permissionless
  daily deduction decrements `loan.durationDays` and re-stamps the renter
  as `newExpires = loan.startTime + loan.durationDays * ONE_DAY` — using
  the original `startTime` with the *reduced* `durationDays`. Each
  deduction therefore moves the renter's expiry one day *earlier* in
  absolute time while wall-clock time advances one day *later*.
- **Exploit / impact:** For a 10-day rental, at day *k* the expiry is
  `start + (10−k) days`; `userOf()` stays valid only while `k < 10−k`,
  i.e. until day 5. Past the midpoint every deduction sets an expiry in
  the past, so `userOf()` returns `address(0)` and the renter loses all
  usage rights — while the loan runs to day 10 and the lender collects
  the full 10 days of rent from the prepay pool. Occurs under the normal
  keeper cadence (no adversary needed); a malicious lender can force it
  by calling the permissionless function daily. Direct economic loss to
  every renter (the NFT usage right is the product sold).
- **Recommendation:** Re-stamp against a fixed anchor — keep the original
  absolute expiry immutable for the rental, or compute
  `newExpires = block.timestamp + loan.durationDays * ONE_DAY` so the
  renter always retains "remaining days." Add a test asserting
  `userExpires` is invariant across a full daily-deduction sweep.

### H2 — Lender-offer ERC-721 rental never escrows the NFT
- **Location:** `contracts/src/facets/OfferAcceptFacet.sol:1159-1206`;
  vault operator forward at `VaipakamVaultImplementation.sol:499-524`
- **Confidence:** Confirmed
- **Description:** For a `Lender`-type NFT-rental offer, acceptance pulls
  the borrower's prepay + buffer and calls `vaultSetNFTUser(lender, ...)`
  but never escrows the underlying ERC-721 — it stays in the lender's EOA
  and the lender's vault acts only as an approved operator. (The
  Borrower-offer branch, by contrast, `safeTransferFrom`s the NFT into a
  vault.)
- **Exploit / impact:** After the borrower prepays the full term + 5%
  buffer, the lender can at any moment (a) transfer/sell the NFT (most
  ERC-4907 impls clear `userOf` on transfer, evicting the renter),
  (b) call `setUser` directly on the ERC-4907 contract as owner to
  reassign the renter, or (c) `setApprovalForAll(vault, false)` to revoke
  the vault's authority. The renter loses the paid usage right with no
  on-chain slashing/refund, and the lender keeps collecting daily rent.
- **Recommendation:** Escrow the ERC-721 into the lender's vault for the
  term (mirror the Borrower-offer branch) so the protocol is the sole
  `setUser` authority; return it at terminal. If non-custodial rental is
  deliberate, surface it explicitly to renters and pair it with a
  buffer/collateral forfeiture penalty enforceable on detected eviction.

### H3 — Permissionless interaction-reward sweep destroys a clean borrower's earned rewards
- **Location:** `contracts/src/libraries/LibInteractionRewards.sol:627-659`
  (`sweepForfeitedByLoanId`), `:795-865` (`_processEntry`); entry point
  `contracts/src/facets/InteractionRewardsFacet.sol:198-228`
- **Confidence:** Confirmed
- **Description:** `sweepForfeitedInteractionRewards(loanId)` is
  permissionless. It drives `_processEntry(..., mutate: true)` on the
  entry at `s.loanBorrowerEntryId[loanId]`, which `closeLoan` leaves set
  even after a clean repayment (intentional, `:280-282`). `_processEntry`
  has no `forfeited` guard: for a clean, finalized, claimable entry it
  reaches `e.processed = true` and returns `(toUser = reward,
  toTreasury = 0)`. The sweep discards `toUser` and the facet early-
  returns on `treasuryDelta == 0` — but the `processed = true` write is
  already committed. The borrower's later `claimInteractionRewards()`
  then returns 0. The reward is neither paid to the user nor routed to
  treasury — it is destroyed (`interactionPoolPaidOut` is not even
  decremented).
- **Exploit / impact:** Borrower repays cleanly → reward days finalize
  (normal steady state) → any address calls
  `sweepForfeitedInteractionRewards(loanId)` (griefer front-running the
  claim, or anyone at any time) → borrower's entry flagged `processed` →
  their claim pays 0. Permanent, irrecoverable loss of earned rewards at
  only gas cost. Pure griefing (no attacker profit).
- **Recommendation:** Gate the sweep strictly to forfeited entries — skip
  unless `s.rewardEntries[id].forfeited == true`, or add an early
  `if (!e.forfeited) return (0,0);` (without the `processed` write) on
  the sweep path. Regression test: clean repay → finalize → third-party
  sweep → borrower claim must still pay in full.

---

## Medium

### M1 — `repayPartial` double-charges interest already settled by periodic auto-liquidation
- **Location:** `contracts/src/facets/RepayFacet.sol:680` (charge), `:754-770`
  (deliberate no-credit); interacts with
  `RepayPeriodicFacet.sol:636`; primitive `LibEntitlement.sol:70-78`
- **Confidence:** Plausible (needs a targeted regression test)
- **Description:** Two interest-tracking models coexist and are not
  reconciled in the partial-repay path.
  `RepayPeriodicFacet._autoLiquidatePeriodShortfall` pays a period's
  interest to the lender via collateral sale and records it as
  `loan.interestSettled += lenderProceeds` **without** advancing
  `interestAccrualStart`. `RepayFacet.repayPartial` charges
  `accrued = LibEntitlement.accruedInterestToTime(loan, now)` — a raw
  pro-rata accrual from `interestAccrualStart` that **does not subtract
  `loan.interestSettled`** — and pays the whole `accrued` to the lender.
  Full-close paths correctly net via `settlementInterestNet`;
  `repayPartial` is the only settlement entry that does not.
- **Exploit / impact:** A periodic-cadence loan whose period was
  auto-liquidated (`interestSettled > 0`), then partially repaid before
  maturity, pays that period's interest a second time. The stale credit
  is only recovered at final settlement and saturates at 0, so any excess
  is permanently lost to the borrower (lender over-paid). The same
  un-netted accrual is used in
  `PartialWithdrawalFacet._calculateCurrentBorrowBalance:330`,
  over-counting debt (conservative there — could block a legitimate
  withdrawal).
- **Recommendation:** Net `interestSettled` in the partial path as the
  full-close path does (charge `accrued − min(accrued, interestSettled)`
  and decrement), or advance `interestAccrualStart` inside
  `_autoLiquidatePeriodShortfall` when it credits `interestSettled`.

### M2 — `VAULT_ADMIN_ROLE` can drain every vault via the implementation-upgrade lever
- **Location:** `contracts/src/facets/VaultFactoryFacet.sol:319`
  (`upgradeVaultImplementation`), `:278` (`setMandatoryVaultUpgrade`),
  `:290` (`upgradeUserVault`); gate `VaipakamVaultImplementation.sol:724`
- **Confidence:** Confirmed
- **Description:** `upgradeVaultImplementation(newImplementation)`
  (`VAULT_ADMIN_ROLE`) sets the vault template to arbitrary bytecode with
  only a `code.length != 0` check — no storage-layout / UUPS-compat /
  init verification. `upgradeUserVault(user)` is **permissionless** and
  calls `proxy.upgradeToAndCall(template, "")`; because the call
  originates from the Diamond (`msg.sender == diamond == owner`), the
  vault's `onlyOwner` `_authorizeUpgrade` passes. With
  `setMandatoryVaultUpgrade` bricking un-upgraded vaults, the admin can
  migrate all vaults onto a backdoored implementation.
- **Exploit / impact:** A compromised or malicious `VAULT_ADMIN_ROLE`
  deploys `EvilVault` with a `sweep(token,to)` backdoor →
  `upgradeVaultImplementation(EvilVault)` → `upgradeUserVault(victim)`
  for every user → drains every vault. This directly contradicts the
  `docs/AuditIntake.md` trust claim that the admin "cannot move user
  vault funds" — the claim is true only for *direct* control; the upgrade
  path is complete *indirect* control.
- **Recommendation:** Inherent to a governance-upgradeable vault, so
  (a) document honestly — the guarantee is "cannot move funds without a
  publicly-observable, timelocked implementation upgrade"; and (b) harden
  the lever: gate `upgradeVaultImplementation` behind the risk-config
  timelock, emit the new-impl codehash, and prefer explicit per-user
  opt-in over the permissionless `upgradeUserVault` + mandatory-brick
  combination.

### M3 — Protocol-broadcast-budget exhaustion freezes VPFI unstaking (griefable)
- **Location:** `contracts/src/facets/ProtocolBroadcastFacet.sol:244-248`
  (fail-closed `ProtocolBudgetExhausted`);
  `LibVPFIDiscount.sol:205-234` (bubbles the revert when
  `rewardMessenger != 0`); consumers `VPFIDiscountFacet.sol:380`
  (`withdrawVPFIFromVault`), `:299`, `:712-735`
- **Confidence:** Confirmed
- **Description:** On the canonical chain, once `s.rewardMessenger` is
  set, every tier-changing `rollupUserDiscount` fans out a
  protocol-funded CCIP broadcast; `protocolBroadcastTierUpdate` is
  fail-closed and reverts `ProtocolBudgetExhausted` when
  `protocolBroadcastBudget < fee`, and `rollupUserDiscount` re-raises it.
  Because `withdrawVPFIFromVault` calls `rollupUserDiscount` *before*
  releasing staked VPFI, an exhausted budget makes users unable to
  unstake. Lender yield-fee and borrower-LIF settlement also call the
  non-silent rollup, so settlement can revert too.
- **Exploit / impact:** An attacker toggles across a tier threshold
  (deposit just over → withdraw just under → repeat); each toggle burns
  real CCIP fees from the protocol budget at only gas + a temporary VPFI
  move. Once drained, all staking withdrawals revert until an admin
  refills — and the refill can be immediately re-drained. Temporary but
  repeatable freeze of user-staked principal, with possible settlement
  DoS. Medium (admin can top up / unset the messenger; no permanent
  loss).
- **Recommendation:** Never let a cross-chain budget shortfall block a
  user's exit from their own staked principal: make the broadcast
  best-effort (soft-skip + emit) on the withdraw/deposit paths, or queue
  the tier push for retry, or at minimum rate-limit / dedupe broadcasts
  so cross-threshold toggling cannot outrun the budget. Consider charging
  the toggling user the incremental fee.

### M4 — Terminal `setUser(0,0)` can revert and brick `repayLoan`
- **Location:** `contracts/src/VaipakamVaultImplementation.sol:513-523`;
  called from `RepayFacet.sol:496-507`
- **Confidence:** Confirmed
- **Description:** In `VaipakamVaultImplementation.setUser` only the
  `supportsInterface` probe is wrapped in try/catch; the actual
  `IERC4907(nftContract).setUser(...)` forward at `:522` is a bare
  external call. In `repayLoan`'s NFT-rental branch the terminal renter
  reset is a `crossFacetCall(..., NFTRenterUpdateFailed.selector)` — a
  hard revert on failure. For the non-custodial Lender-offer path (H2),
  if the lender has moved the NFT or revoked operator approval, the
  forward reverts, reverting the whole `repayLoan`.
- **Exploit / impact:** A lender who rugs (or merely transfers) the NFT
  bricks the borrower's `repayLoan`, the route to reclaim unused prepay +
  buffer. Funds are trapped until grace forces the default path, where
  the buffer is swept to treasury as a penalty — so the innocent borrower
  loses the buffer. Weaponizable by a lender.
- **Recommendation:** Make the terminal renter-reset best-effort (wrap
  the forward in try/catch inside the vault, or call it non-critically
  with a discarded `ok`, as `autoDeductDaily`'s natural-close path
  already does). Terminal fund settlement must not be gated on a
  state-reset a counterparty can force to revert.

---

## Low

### L1 — `OfferMutate` skips create-time HF/LTV floor checks
- **Location:** `contracts/src/facets/OfferMutateFacet.sol:455`
  (`_assertAmountInvariants`), `:493` (`_assertCollateralInvariants`)
- **Confidence:** Confirmed
- **Description:** `OfferCreateFacet._createOfferSetup` enforces, for
  range-amount + both-liquid offers, `collateralAmount >=
  minCollateralForLending(amountMax)` (lender) and `amountMax <=
  maxLendingForCollateral(collateralAmountMax)` (borrower). The mutate
  surface re-checks only range-ordering, positivity, the filled-floor,
  and cadence — never those two system-derived bounds. A creator can
  mutate an offer into a state `createOffer` would reject.
- **Impact:** Bounded / fails-late. The binding HF/LTV gates re-run at
  settlement (`LibOfferMatch.previewMatch`, `LoanFacet` HF ≥ 1.5e18), and
  KYC is re-checked at accept, so no under-collateralized loan mints — the
  offer just becomes unmatchable and the creator strands their own
  capital until they cancel.
- **Recommendation:** Mirror the create-time floor/ceiling checks in the
  mutate invariants for fail-early parity.

### L2 — NFT-rental full repay reverts once accrued rent exceeds prepay
- **Location:** `contracts/src/facets/RepayFacet.sol:428-429`, `:486`
- **Confidence:** Confirmed (mechanics), Plausible (reachability)
- **Description:** In the ERC20-NFT branch, `totalDue = interest +
  lateFee` guarded by `if (totalDue > loan.prepayAmount) revert
  InsufficientPrepay();`. The 5% `bufferAmount` — which the refund line
  returns and which exists to absorb overage/late fees — is not included
  in the funds available to satisfy `totalDue`. For a matured rental,
  `interest` can equal or exceed `prepayAmount` (past-maturity
  `undeductedDays > durationDays`, or any positive late fee on a
  full-term rental).
- **Impact:** A borrower reaching grace without `autoDeductDaily` having
  drained the schedule cannot `repayLoan` (reverts `InsufficientPrepay`);
  the only resolution is default, forfeiting the buffer to treasury.
  Reachability is limited because permissionless `autoDeductDaily` drives
  `durationDays → 0` before/at maturity.
- **Recommendation:** Cap `interest` at the schedule
  (`undeductedDays = min(undeductedDays, remaining)`) or let `totalDue`
  draw against `prepayAmount + bufferAmount` (its purpose), reducing the
  refund accordingly.

### L3 — ERC-1155 rentals use single-slot `setUser`, clobbering concurrent renters
- **Location:** `contracts/src/facets/OfferAcceptFacet.sol:1194-1205`;
  `VaipakamVaultImplementation.sol:499-524` vs `:537-598`
- **Confidence:** Plausible
- **Description:** The accept path calls `vaultSetNFTUser` (single-slot
  `setUser`, which `delete`s the whole `_rentalEntries[nft][id]` list)
  for both ERC-721 and ERC-1155. The quantity-aware `setUser1155` /
  `vaultSetNFTUser1155` machinery is never reached from the loan
  lifecycle, so two rentals over the same ERC-1155 token clobber each
  other and any terminal reset wipes every renter entry.
- **Impact:** If the protocol ever allows an ERC-1155 to back two
  concurrent rentals, closing/defaulting one silently evicts the other's
  renter. No fund loss; rental-state corruption. Low (reachability
  depends on whether concurrent ERC-1155 rentals can co-exist).
- **Recommendation:** Route ERC-1155 rentals through
  `setUser1155`/`vaultSetNFTUser1155` end-to-end, or explicitly enforce
  single-renter ERC-1155 rentals and remove the unused `setUser1155`
  surface.

### L4 — Reward *broadcast* ingress lacks the source-chain check the tier path enforces
- **Location:** `contracts/src/crosschain/VaipakamRewardMessenger.sol:675-685`;
  `contracts/src/facets/RewardReporterFacet.sol:229-260`
- **Confidence:** Confirmed (asymmetry); Plausible (exploitability)
- **Description:** Tier-update messages carry `sourceChainId` and the
  mirror rejects `sourceChainId != s.baseChainId`
  (`MirrorTierReceiverFacet._assertSourceChain`). The `MSG_TYPE_BROADCAST`
  path does not carry or check the source chain — the facet gates only on
  `msg.sender == s.rewardMessenger`. The broadcast payload sets the
  `knownGlobal{Lender,Borrower}InterestNumeraire18` denominators for all
  reward claims on that mirror.
- **Impact:** Not attacker-reachable by default (broadcast is
  `onlyCanonical` on Base, and a mirror's reward peer is Base only).
  Exploitable only under a compound owner misconfiguration (a second
  diamond flipped canonical + wired as a reward peer), which could inject
  an attacker-chosen denominator (first-writer-wins). The tier path
  already defends against exactly this misconfig class.
- **Recommendation:** Thread `sourceChainId` into
  `onRewardBroadcastReceived` and assert `== s.baseChainId`, mirroring
  the tier path.

### L5 — Numeraire valuation truncates to integer units
- **Location:** `contracts/src/facets/RiskFacet.sol:1919-1935`
  (`_computeNumeraireValues`); same pattern
  `LibFallback.sol:23-45` (`expectedSwapOutput`)
- **Confidence:** Confirmed
- **Description:** `_computeNumeraireValues` computes
  `value = amount * price / 10**feedDecimals / 10**tokenDecimals`,
  yielding whole numeraire units (integer dollars), discarding sub-unit
  precision on each side — unlike the KYC path in the same file
  (`:811`, `:1194`) which multiplies by `1e18`. HF/LTV are ratios so the
  scale cancels for normal loans, but (a) a loan whose total borrow value
  rounds below 1 unit hits `borrowValueNumeraire == 0 → return
  type(uint256).max` (`RiskFacet.sol:466`) and becomes permanently
  HF-un-liquidatable, and `expectedSwapOutput` can round to 0, zeroing
  `minOutputAmount` (no slippage floor); (b) small loans see a boundary
  shift at HF = 1.0.
- **Impact:** Relevant to dust / long-tail-priced positions
  (per-unit value < ~$1). Correctness defect; inconsistent with the
  "USD scaled to 1e18" convention.
- **Recommendation:** Scale numeraire values to 1e18 (as the KYC path
  does) and add `require(expectedProceeds > 0)` before deriving
  `minOutputAmount`.

### L6 — Missing `_disableInitializers()` in the vault implementation
- **Location:** `contracts/src/VaipakamVaultImplementation.sol`
  (no constructor; `initialize` at `:127`)
- **Confidence:** Confirmed
- **Description:** The implementation never calls `_disableInitializers()`
  and has no constructor. The current template is safe (deployed and
  `initialize()`d atomically by `VaultFactoryFacet:189-190`), but
  `upgradeVaultImplementation:319` only checks `code.length` and does not
  initialize a new impl — any future upgrade target deployed without an
  out-of-band `initialize` is left uninitialized.
- **Impact:** An attacker `initialize(attacker, ...)`s the uninitialized
  upgrade-impl, becomes its owner, and can `upgradeToAndCall` to a
  `selfdestruct`-delegating contract, bricking every proxy on it (the
  classic OZ-flagged anti-pattern).
- **Recommendation:** Add `constructor() { _disableInitializers(); }`.

### L7 — `OwnershipFacet.transferOwnership` — no zero-address / two-step guard
- **Location:** `contracts/src/facets/OwnershipFacet.sol:24`
- **Confidence:** Confirmed
- **Description:** `transferOwnership` calls
  `LibDiamond.setContractOwner(_newOwner)` with no zero-address guard and
  no two-step accept (unlike `AccessControlFacet.transferAdmin`, which
  guards zero/self and atomically moves owner + all roles).
  `transferOwnership(address(0))` irrecoverably bricks `diamondCut` and
  every owner-gated setter; `transferOwnership(X)` moves only the
  LibDiamond owner, leaving `DEFAULT_ADMIN_ROLE` with the previous admin
  (split authority).
- **Impact:** Operator footgun → permanent loss of upgrade / governance,
  or a subtle privilege split.
- **Recommendation:** Reject `address(0)`, adopt a two-step pending-owner
  pattern, and/or document `transferAdmin` as the canonical handover.

### L8 — Interaction-reward pool-exhaustion truncation silently burns the remainder
- **Location:** `contracts/src/facets/InteractionRewardsFacet.sol:114-175`
- **Confidence:** Confirmed
- **Description:** `claimForUserEntries` marks entries `processed = true`
  and returns the full computed reward *before* the 69M pool-cap
  truncation (`grossSpend > remaining → scaledPending`). Near exhaustion
  the user is paid only `scaledPending` but all entries are already
  `processed`, so the truncated remainder is permanently unclaimable.
- **Impact:** Only at end-of-life pool exhaustion; no attacker leverage.
  Users claiming during the final drain get less than their fair share
  with no recourse.
- **Recommendation:** Apply the pool-cap clamp *before* marking entries
  processed (leave over-cap entries un-processed), or track a per-user
  carryover.

### L9 — Committing a buyback with both top-up targets zero bricks the fill
- **Location:** `contracts/src/libraries/LibTreasuryBuyback.sol:599-654`
  (`_routePriority`), reached from `postInteractionImpl:476`
- **Confidence:** Confirmed
- **Description:** With `cfgRewardEmissionsTopUpTarget == 0` and
  `cfgKeeperRewardTopUpTarget == 0` (Phase-1 default), delivered VPFI
  leaves `remaining > 0`, hitting `revert BuybackOverflowNotAllowed`. So
  committing a buyback intent before setting a non-zero target makes every
  Fusion fill revert and the reserved `baseBuybackReserved` is stuck
  until `expireBuybackIntent`.
- **Impact:** Admin-only footgun; funds recoverable via expiry.
- **Recommendation:** Require at least one non-zero top-up target at
  commit time, or route overflow to a defined sink.

---

## Informational

- **Signed-offer consume ledger keyed on domain-independent `hashStruct`**
  (`LibSignedOffer.sol:236`) — safe: chain binding lives in the
  signature; no cross-chain replay. Document the intentional
  domain-independence.
- **`cancelSignedOffer` / `invalidateSignedOfferNonce` are `whenNotPaused`**
  (`SignedOfferFacet.sol:152,164`) — symmetric with fills; consider
  allowing cancel mid-pause as defense-in-depth.
- **`precloseDirect` NFT branch omits `settleBorrowerLifProper`**
  (`PrecloseFacet.sol:359-454`) — harmless today (rentals carry
  `vpfiHeld == 0`) but a latent invariant gap; add the unconditional
  call or a documented assertion.
- **Mixed numeraire scaling conventions inside `RiskFacet`** (integer vs
  `1e18`) — latent maintenance hazard; standardize on `1e18`.
- **`swapWithSplit` legs carry `minOutputAmount = 0`** (aggregate floored)
  — safe today; consider a per-leg floor for raw (non-aggregator)
  adapters.
- **Read-only reentrancy window during the aggregator swap call** — views
  expose transient inconsistent HF/collateral; no in-protocol exploit;
  document or add a `nonReentrant`-view guard if external protocols read
  Vaipakam views atomically.
- **Diamond reward ingress handlers not `whenNotPaused`**
  (`RewardAggregatorFacet.sol:182`, `RewardReporterFacet.sol:229`) —
  scalar accounting only; consider adding for a single coherent pause
  lever.
- **`BuybackRemittanceReceiver` has no stray-token sweep** — self-inflicted
  lock only; consider an `onlyOwner sweepToken`.
- **`_ccipReceive` not `nonReentrant`** (`CcipMessenger.sol:334`) — not
  exploitable (router-gated, trusted handlers); add for uniformity.
- **`initializeAccessControl` not idempotent** (`AccessControlFacet.sol:29`)
  — owner-only; add a one-shot guard so a later call can't silently
  re-grant a deliberately-renounced role.
- **Diamond commingles VPFI across accounting buckets** (interaction pool,
  `vpfiHeld` custody, keeper/reward budgets, buyback) — deltas measured
  correctly, but no on-chain `balance ≥ Σ obligations` invariant; add a
  monitored view and document the funding requirement.
- **Doc drift:** `CLAUDE.md` still documents the removed `VpfiBuyAdapter` /
  `VpfiBuyReceiver` (excised in #687-A per `DeployCrosschain.s.sol:165-166`);
  the live buyback ingress is `BuybackRemittanceReceiver`. Update
  `CLAUDE.md` / `docs/AuditIntake.md`.

---

## Round 2 — second independent deep pass (2026-07-03)

A second, independent adversarial pass over all seven domains, each told
round-1's findings and directed to go deeper/different-angle. It added
one High, three Medium, and three Low, plus two scope-extensions of
existing findings and several informational items. Each round-2 domain
also produced a set of concretely deep-verified-safe negative results
(folded into the "Verified sound" section below).

### H4 — `useFullTermInterest` coupon guarantee evadable via `repayPartial`
- **Location:** `RepayFacet.sol:680` (interest calc), `:685` (`partialAmount == principal` allowed), `:732` (`principal -= partialAmount`); floor helper `LibEntitlement.sol:152-163`
- **Confidence:** Confirmed (mechanism); Plausible vs. intended semantics
- The full-term-interest floor is applied only in proper-close paths;
  `repayPartial` uses raw pro-rata `accruedInterestToTime` with no floor
  and no `useFullTermInterest` branch, and allows `partialAmount ==
  principal`. Draining principal to 0 (loan stays Active) collapses the
  final-settlement floor (`proRata(principal=0, …) = 0`) and the
  principal-scaled late fee. A borrower on a `useFullTermInterest = true`
  + `allowsPartialRepay = true` loan pays ~10/365 of the promised coupon
  → ~97% lender interest loss.
- **Fix:** charge full-term interest on the repaid slice in `repayPartial`
  when `useFullTermInterest`, or forbid `repayPartial` taking principal to
  0 on a full-term loan (require `repayLoan` for the terminal slice).

### M5 — Diamond owner can drain vaults / rewrite claims via `diamondCut`
- **Location:** `DiamondCutFacet.sol:35-42`; `LibDiamond.initializeDiamondCut` delegatecall; trust claim `docs/AuditIntake.md:79-82`
- **Confidence:** Confirmed
- Distinct authority/mechanism from M2 (this is `LibDiamond.contractOwner`
  via `diamondCut`, not `VAULT_ADMIN_ROLE`). The owner can `delegatecall`
  an arbitrary `_init` into diamond storage (write `lenderClaims` /
  `borrowerClaims` / treasury / roles) or cut a facet calling
  `withdrawERC20/721/1155` on any user's proxy (diamond is owner of every
  vault). Not pause-gated, no timelock. The AuditIntake invariant is false
  for this path too.
- **Fix:** correct the trust doc (upgradeability ⇒ owner can move funds),
  or place `contractOwner` / the `diamondCut` surface behind the
  governance timelock at launch.

### M6 — Core VPFI staking/loan-init on Base freezes if any cross-chain lane is down
- **Location:** `VPFIDiscountAccumulatorFacet.sol:106-118` → `ProtocolBroadcastFacet.sol:238-262` → `VaipakamRewardMessenger.sol:455-509` → `CcipMessenger.sol:294-321,389-399`
- **Confidence:** Confirmed
- Broader-blast-radius sibling of M3. `rollupUserDiscount` hard-reverts,
  and the tier broadcast loops over every destination calling
  `quoteMessageFee` → `IRouterClient.isChainSupported`. A single down /
  unsupported / mis-wired lane (or a paused messenger) reverts **every**
  tier-changing stake/unstake/loan-init on Base for all users. The pause
  lever aggravates it (`EnforcedPause` bubbles up).
- **Fix:** decouple the broadcast from the user critical path
  (`try/catch` + later poke, keeping fail-closed only for
  `ProtocolBudgetExhausted`), or skip individually-failing lanes.

### M7 — `interestSettled` not netted across non-proper-close exits (M1 broader)
- **Location:** `PrecloseFacet.sol:617` (transfer-obligation), `:1095` (offset); `RefinanceFacet.sol:323`; `DefaultedFacet.sol:398`; `RiskFacet.sol:770,1167,1508` (`currentBorrowBalance`)
- **Confidence:** Confirmed
- The M1 root cause is present on every ERC-20 settlement entry point
  except the two proper-close paths: preclose Options 2/3 and refinance
  double-charge periodic-settled interest to the lender; time-default and
  HF-liquidation over-state debt, shrinking the borrower's surplus.
- **Fix:** route all exits through a single `settlementInterestNet`-
  equivalent (subtract `min(interest, interestSettled)`).

### L10 — Discount-liquidation seizure inflatable by manipulating live liquidity tier
- **Location:** `RiskFacet.sol:1479-1550`; tier `OracleFacet.sol:1225-1231,1751-1789,1602-1622`
- **Confidence:** Plausible
- Thinner tier ⇒ wider discount ⇒ more collateral seized. The AMM
  manipulation guards *exclude* pools when tripped, which lowers the
  measured tier — the wrong fail-safe direction for this path. A liquidator
  nudges spot to drop tier 3→1 and seizes extra from borrower surplus.
  Mitigated: discount path off by default; keeper tier defaults to 1.
- **Fix:** snapshot the collateral's tier at loan-init for the discount, or
  floor the discount to the keeper-attested tier. Address before enabling
  `discountPathEnabled`.

### L11 — `broadcastGlobal`/`sendVersionBumped` all-or-nothing across lanes
- **Location:** `VaipakamRewardMessenger.sol:380-429,516-546`; docstring `RewardAggregatorFacet.sol:42-43,372-376`
- **Confidence:** Confirmed
- One unsupported lane reverts the whole fan-out, stalling reward
  denominator propagation to every mirror (claims stall, not lost). The
  docstring claims per-destination retry the code doesn't support.
- **Fix:** support per-destination broadcast / skip failing lanes; correct
  the docstring.

### L12 — `claimInteractionRewards`/`sweep` lack the Tier-1 sanctions gate
- **Location:** `InteractionRewardsFacet.sol:96` (paid `:178`), `:198`
- **Confidence:** Confirmed
- Every other VPFI-outflow path gates on `_assertNotSanctioned`; this facet
  has none, so a flagged wallet blocked from unstaking could still receive
  pool VPFI to its EOA once the sanctions oracle is wired.
- **Fix:** add `LibVaipakam._assertNotSanctioned(msg.sender)` (or document
  a deliberate Tier-2 make-whole exemption).

### Scope-extensions of existing findings (round 2)
- **H1 (#893) also occurs in `RepayFacet.repayPartial`'s NFT branch**
  (`RepayFacet.sol:887-906`) — scope the expiry-anchor fix to all three
  deduction sites, not just `autoDeductDaily`.
- **M4 (#899) also occurs on the mid-life `setUser` forward**
  (`VaipakamVaultImplementation.sol:521-523`, reached by
  `autoDeductDaily`/`repayPartial`) — a lender revoking operator approval
  bricks the deduction stream, not only the terminal reset. Wrap the
  mid-life forward in try/catch too.

### Additional informational (round 2)
- Dead duplicate `StuckERC20Recovered` event overload
  (`VaultFactoryFacet.sol:171` vs `:632`).
- Vault `__gap` off-by-one (`VaipakamVaultImplementation.sol:738` — should
  be 48, not 49, after two tail vars added). Not a live hazard.
- Dead `!partialFillEnabled` branch in `_executeMatch`
  (`OfferMatchFacet.sol:1011-1048`).
- Range-match rate landing point is matcher-selected within each party's
  signed band (by design; document the expectation).
- Interaction-reward wash/self-dealing is bounded only by the per-ETH cap
  parameter, which **fails open** (→ `uint256.max`) if the ETH feed is
  unavailable (`LibInteractionRewards.sol:1092`). Treat cap tuning as a
  launch-gating economic control; fall back to a fixed cap on feed failure.
- `VPFIMirrorToken.setTokenPool` (`crosschain/VPFIMirrorToken.sol:108-113`)
  lacks the `code.length > 0` sanity check its sibling setters apply.
- Broadcast-fee surplus refunded to the Diamond is not re-credited to
  `protocolBroadcastBudget` (`ProtocolBroadcastFacet.sol:249-262`); dust
  accounting drift.

---

## Round 4 — deploy/init, governance/timelock, DoS, under-covered facets (2026-07-03)

Ground the per-domain runtime audits never covered. 13 findings (2 High, 5
Medium, 6 Low); several reframe the earlier trust-model findings. Filed as
GitHub issues under umbrella #892.

- **#934 (H5)** — the 48h timelock is bypassable in one zero-delay tx by the
  DEFAULT_ADMIN Safe (`transferAdmin` re-seizes ownership + all 11 roles;
  `grantRole` hands a hot key `VAULT_ADMIN`), making the #897/#909 timelock
  mitigations voluntary, not enforced. `AccessControlFacet.sol:212-237`.
- **#944 (H6)** — the mandatory post-handover "zero-roles" exit gate
  (`DeployerZeroRolesTest`) never inspects the live chain (throwaway in-memory
  diamond + mock principals; `--fork-url` inert), so it passes unconditionally
  and cannot catch a leftover root-admin on a hot EOA.
- **#935 (M9)** — 48h-timelocked unpause freezes repay/liquidation/default,
  contradicting the documented no-timelock rationale.
- **#936 (M10)** — two contradictory handover scripts; CI validates the
  topology that isn't shipped; the legacy one leaves `UNPAUSER` on the deployer
  EOA.
- **#937 (M11)** — canonical `VPFIToken` has no guardian; emergency pause needs
  the 48h queue.
- **#945 (M12)** — the diamond auto-unpauses at end of `--phase contracts`,
  before oracle/sanctions/adapter config and while still owned by the hot Admin
  EOA.
- **#946 (M13)** — required `setSanctionsOracle` wiring is enforced nowhere in
  the deploy pipeline (no setter, no `phase_verify` check, no reminder).
- **#938 (L14)** timelock param hardening; **#939 (L15)** uncapped
  `claimInteractionRewards` entry loop; **#940 (L16)** dashboard omits
  FallbackPending loans (borrower may miss cure window); **#941 (L17)** dashboard
  drops `amount==0` NFT claims; **#942 (L18)** paginated active-loan enumeration
  can skip a loan under mutation; **#947 (L19)** deploy-time admin handover has
  no zero-address guard.

Round-4 verified sound: no attacker-bricks-victim DoS (swap-pop active lists,
try/catch-per-element, `MAX_FEE_LEGS`, 30-iteration ring buffer, capped
catch-up loops); facet-cut completeness, born-paused cut window, two-authority
handover, UUPS `_disableInitializers` across all templates, upgrade
`_init`-delegatecall (all committed scripts pass `address(0)`), CCIP gates,
retail sanctions/KYC/country wiring, AutoLifecycle both-side-consent triggers,
adapter-factory isolation, `VaipakamTimelock` extension correctness.

## Round 5 — flash-loan/rate-model, treasury yield, arithmetic, event coverage (2026-07-03)

The last un-audited surfaces (`keeper/`, `models/`, the Aave yield integration)
plus arithmetic-safety and event/state-change coverage. 13 findings (1 High, 5
Medium, 7 Low); corrected an earlier "verified clean" result.

- **#966 (H7)** — a permissionless VPFI-dust donation to a lender's vault
  underflow-reverts `tryApplyYieldFee`/`tryApplyBorrowerLif`
  (`prevTracked - vpfiRequired`, guarded only on `vaultBal`). Because these
  "silent fallbacks" are called by direct internal call (not try/catch), the
  revert blocks `repayLoan` → forced default → borrower collateral loss. Fix:
  saturating subtraction. `LibVPFIDiscount.sol:544,755`.
- **#962 (M14)** treasury Aave yield unrealizable (no harvest; dead event);
  **#963 (M15)** no shortfall write-off → Aave loss permanently deadlocks venue
  reconfiguration.
- **#967 (M16)** — all three HF-liquidation terminals emit no indexer-handled
  event (`LoanLiquidated` declared-but-never-emitted) → loans stuck `active`
  forever (May-2026 incident class; guardrail fooled by a stale allowlist).
- **#968 (M17)** — `claimAsLender` out of FallbackPending skips
  `forfeitBorrowerLif` + `closeLoan` → strands VPFI custody in the Diamond
  (violates the mainnet invariant; the edge the round-1/2 borrower-LIF "clean"
  check missed).
- **#969 (M18)** — interaction-reward entries never closed on
  preclose/refinance/prepay-sale/internal-match → full-term over-accrual and
  refinance double-accrual.
- **#961 (L20)** flash-loan liquidator profit guard subsidized by standing
  balance; **#964 (L21)** venue routing no exhaustive else-revert; **#965 (L22)**
  no balance-delta verify on Aave supply/withdraw; **#970 (L23)** NFT-rental
  term-exhaustion stuck-active; **#971 (L24)** early-withdrawal temp-loan no
  terminal event + stranded LIF; **#972 (L25)** `vpfiToken==0` branch
  guaranteed-revert bricks close-out; **#973 (L26)** `LibNotificationFee` missing
  discount restamp.

Round-5 verified sound: flash-loan callback authentication (Aave + Balancer,
triple-gated); `RiskPremiumRateModel` bounds/manipulation (δ-clamp fails
closed); **no user/vault/LIF/backstop funds exposed to Aave** (only fee surplus,
capped 70/80%); arithmetic (`LibSlippage` `mulDiv` intermediates, rounding
directions, interest accrual, keeper/reward units, Pyth exponent bounds);
`LibRevert` return-data-bomb (not exploitable — all `address(this)`); the
reentrancy guard; `LibMetricsHooks` swap-pop; `LibLifecycle` allow-list.

**Meta-fix that self-heals the stuck-active indexer class (M16/L23/L24):** add
`'active'` to the `LoanSettled` handler's `WHERE status IN (...)` clause.

---

## Verified sound (negative results)

Round 2 additionally deep-verified (concretely, by reading the code paths):
adapter output recipient/token pinning; feed decimals read (not assumed)
across Chainlink/Tellor/API3/DIA/peg; AMM Q96/tick math; partial-liquidation
bonus math; SwapToRepay relayer pinning; the discount-accumulator ring-buffer
(no aliasing, rounds down); the full borrower-LIF terminal-coverage census;
buyback/Fusion protections; VPFI mint gating; backstop authorization; CCIP
idempotency under manual re-execution; reward-mesh denominator lifecycle;
CCIP message construction/authorization; ERC-7201 storage-slot enumeration
(no collision); vault call-target resolution; Seaport Dutch/atomic/parallel-
sale/encumbrance/proceeds-routing/conduit-residue; Permit2 witness binding;
intent-lien double-spend prevention.

- **Diamond / access:** `diamondCut` is strictly owner-gated; UUPS
  `_authorizeUpgrade` is Diamond-only; vault→owner binding written once
  and never overwritten; ERC-7201 namespaced slots (no collisions); no
  facet gives admin direct control over `lenderClaims` / `borrowerClaims`
  / `fallbackSnapshot`; `allowanceTarget` cannot drain vault approvals
  (swaps approve exact amounts transiently from Diamond custody, not from
  vaults); role escalation blocked.
- **Offers / signatures:** EIP-712 domains recompute chainId + address
  per call; distinct domain names prevent cross-type replay; malleability
  / `signer==0` handled by OZ `SignatureChecker`; anti-phishing term
  binding (#662) neutralizes mutate TOCTOU; range-match surplus and
  boundary math sound; creator-only cancel/mutate; custody pulled at
  create.
- **Risk / oracle / swap:** oracle staleness (`answer>0`, `updatedAt`,
  freshness, `roundId==answeredInRound`, fail-closed) and L2 sequencer
  breaker correct; `minOutputAmount` oracle-derived everywhere; approval
  zero-before/exact-scope/zero-after on success and failure; allowance
  target immutable and split from the allowlisted swap target; symbol-
  spoof bounded to the deviation gate.
- **Loan lifecycle:** no collateral double-spend / snapshot leak;
  fallback split sums exactly to `collateralAmount`; strict state-machine
  allow-list; borrower-LIF custody settled/forfeited exactly once on
  every terminal; global reentrancy mutex over the whole Diamond; #411
  refinance value conservation correct.
- **Cross-chain:** `_ccipReceive` enforces router + source-selector +
  peer checks (fail-closed); mint idempotency delegated to the trusted
  CCIP pools; `GuardianPausable` freezes send + receive with owner-only
  unpause; `VpfiPoolRateGovernor` refuses to disable a lane and
  range-bounds values; reward dedup/finalization robust.
- **Tokenomics:** VPFI mint is minter-only + capped; discount tier-gaming
  defeated by post-mutation re-stamp + min-over-history clamp + TWA;
  borrower-LIF custody capped and single-settled; payroll / keeper-reward
  / backstop / notification-fee accounting sound; rounding favors the
  protocol.

---

## Remediation priority (pre-mainnet)

1. **H1, H3** — confirmed, cheap, permanent user-value loss; fix + test
   first.
2. **H2 + M4** — the non-custodial rental design and its `repayLoan`
   brick are coupled; decide custody model, then fix together.
3. **M1** — add the regression test, then net `interestSettled`.
4. **M2** — timelock the vault-upgrade lever and correct the
   `docs/AuditIntake.md` trust claim.
5. **M3** — decouple user unstaking from the CCIP broadcast budget.
6. **Lows / Informational** — batch as hardening; L5 (numeraire scaling)
   and L6/L7 (init / ownership guards) are the highest-value of the low
   tier.
