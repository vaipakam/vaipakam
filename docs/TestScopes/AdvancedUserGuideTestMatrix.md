# Advanced-User-Guide-driven Test Matrix

This is the single source of truth for the three new on-chain test
scripts that exercise every flow documented in
[`frontend/src/content/userguide/Advanced.en.md`](../../frontend/src/content/userguide/Advanced.en.md):

- `contracts/script/AnvilNewPositiveFlows.s.sol` — happy paths
- `contracts/script/AnvilNewPartialFlows.s.sol` — UI-testable midpoint states (chain stays at end-state for manual UI checks)
- `contracts/script/AnvilNegativeFlows.s.sol` — documented reverts / constraints

Every row maps a guide section → a scenario in each file. Where a
section is read-only or out of scope for Anvil, the cell is "n/a"
with a one-line reason. Status column is updated as scenarios land.

| Advanced Guide § | Positive | Partial midpoint | Negative | Status |
|---|---|---|---|---|
| **§ Dashboard > Your Vaipakam Vault** | (read-only state surface) | P-A: leave non-zero ERC-20 + ERC-721 + ERC-1155 holdings in user's escrow so the table renders all three asset types | n/a | partial-only |
| **§ Dashboard > Your Loans** | (read-only state surface) | P-B: leave 1 active + 1 repaid-claimable + 1 defaulted loan visible to the same user | n/a | partial-only |
| **§ Dashboard > VPFI on this chain** | (read-only state surface) | P-C: user holds VPFI in wallet + escrow so the "balance / staked / tier" badges are non-trivial | n/a | partial-only |
| **§ Dashboard > Fee-discount consent** | N10: opt-in via `setVPFIDiscountConsent(true)`, user takes a loan, settles, claims rebate | P-D: user has `vpfiDiscountConsent=true` + non-zero escrow VPFI but no active loan yet | NEG-1: try opting in while a loan is mid-cycle and verify discount applies only to NEW loans | wave-3b pending |
| **§ Dashboard > Your VPFI rewards** | (claims path covered under § Rewards below) | P-E: user has accrued staking + interaction rewards but hasn't claimed | n/a | partial-only |
| **§ Offer Book > Filters / Lender Offers / Borrower Offers** | (read-only — covered by SeedAnvilOffers + scenarios that create offers) | P-F: leave 5+ active lender offers and 5+ active borrower offers across multiple assets so the filter UI exercises | n/a | partial-only |
| **§ Offer Book > Your Active Offers** | (already covered in existing flows) | P-G: leave 1 fully-filled lender offer (closed), 1 partial-filled lender offer (open with `amountFilled > 0`), 1 cancelled offer | n/a | partial-only |
| **§ Create Offer > Offer Type (Lender/Borrower)** | covered by N1 (range lender offer) + N3 (lender offer) + N4 (borrower offer) | covered | NEG-2: `creatorFallbackConsent=false` reverts `FallbackConsentRequired`. NEG-3: `lendingAsset == collateralAsset` reverts `SelfCollateralizedOffer`. NEG-4: `durationDays == 0` reverts `InvalidOfferType`. NEG-5: `durationDays > maxOfferDurationDays` reverts `OfferDurationExceedsCap`. | wave-3a pending |
| **§ Create Offer > Lending Asset (ERC-20 / ERC-721 / ERC-1155)** | covered by SepoliaPositiveFlows scenarios 1, 9, 10, 11, 12, 13 | covered | NEG-6: NFT lending offer without `prepayAsset` set reverts `InvalidAssetType` | wave-3a pending |
| **§ Create Offer > NFT Details** | covered by Sepolia-12, Sepolia-13 | covered | NEG-7: NFT-rental offer where creator no longer owns the tokenId at acceptance reverts on `safeTransferFrom` | wave-3a pending |
| **§ Create Offer > Collateral** | covered | covered | NEG-8: borrower offer where `collateralAmount` ceiling is below `amountMax × liqThreshold / 1.5` reverts `MaxLendingAboveCeiling` (Range Orders gate). NEG-9: lender offer where `collateralAmount < minCollateralFloor` reverts `MinCollateralBelowFloor`. | wave-3a pending |
| **§ Create Offer > Risk Disclosures** | covered (consent toggle) | covered | NEG-10: acceptor passes `acceptorFallbackConsent=false` → reverts `FallbackConsentRequired` | wave-3a pending |
| **§ Create Offer > Advanced Options (`allowsPartialRepay`, range, periodic interest)** | N3 (partial repay), N1 (range), N2 (periodic interest, deferred) | covered | NEG-11: range offer when `partialFillEnabled=false` reverts `FunctionDisabled(3)`. NEG-12: periodic-interest offer when `periodicInterestEnabled=false` reverts `PeriodicInterestDisabled`. NEG-13: cadence shorter than `durationDays` reverts `CadenceNotAllowed`. NEG-14: cadence on illiquid leg reverts `CadenceNotAllowedForIlliquid`. | wave-3a pending |
| **§ Claim Center > Claimable Funds** | covered (every scenario claims via `_claimBoth`) | P-H: leave 1 lender-claimable + 1 borrower-claimable visible side-by-side | NEG-15: claim before loan terminates reverts `NotClaimable`. NEG-16: double-claim reverts `AlreadyClaimed`. | wave-3a pending |
| **§ Activity > Activity Feed** | (read-only — populated by every other scenario) | P-I: ensure activity entries from at least 4 distinct flow types (createOffer, acceptOffer, repayLoan, transferObligation) are visible | n/a | partial-only |
| **§ Buy VPFI > Buying VPFI / Step 1-3** | **OUT OF SCOPE for Anvil** — cross-chain LZ flow, needs LZ endpoint mocks. Document as separate fixture or fork-test. | n/a | n/a | deferred (LZ infra) |
| **§ Buy VPFI > Your VPFI Discount Status** | (read-only — depends on § Fee-discount consent) | P-J: user has VPFI staked at each tier boundary (Tier 0/1/2/3) so the badge colour-codes exercise | n/a | wave-3b pending |
| **§ Rewards > Claim Rewards** | N13 (NEW): user accrues staking rewards for ≥1 day, claims via `RewardReporterFacet` | P-K: user has unclaimed staking + interaction rewards visible | NEG-17: claim before rewards accrue reverts | wave-3b pending |
| **§ Rewards > Withdraw Staked VPFI** | N14 (NEW): user calls `withdrawVPFIFromEscrow(amount)` with sufficient unstaked balance | P-L: user has VPFI partially withdrawn (some still staked, some withdrawn) | NEG-18: withdraw more than staked reverts | wave-3b pending |
| **§ Loan Details > Actions > Repay** | covered (every scenario repays) | P-M: loan with accrued interest (mid-term, partway through duration) so the live "owed" calc is non-trivial | NEG-19: repay past `gracePeriod` reverts `RepaymentPastGracePeriod` | wave-3a pending |
| **§ Loan Details > Actions > Partial repay** | N3 (already passing) | P-N: loan with one partial-repay applied, principal reduced, still active | NEG-20: partial repay when `allowsPartialRepay=false` reverts `PartialRepayNotAllowed`. NEG-21: partial below `minPartialBps` reverts `InsufficientPartialAmount`. | wave-3a pending |
| **§ Loan Details > Actions > Add collateral** | Sepolia-4 (already passing) | P-O: loan with 2x collateral added mid-flight | NEG-22: add collateral on a defaulted loan reverts | wave-3a pending |
| **§ Loan Details > Parties** | (read-only — populated by every loan creation) | covered by P-B | n/a | n/a |
| **§ Allowances > Allowances** | (frontend-only ERC-20 management) | n/a | n/a | n/a (frontend) |
| **§ Alerts > Threshold Ladder + Delivery Channels** | (HF watcher Cloudflare side, not contract flow) | n/a — separate fixture | n/a | deferred (worker) |
| **§ NFT Verifier** | (pure oracle view, no state change) | n/a | n/a | n/a |
| **§ Keeper Settings > Approved Keepers** | N12 (NEW): user calls `setLoanKeeperEnabled(loanId, keeper, actionBits)`, keeper executes `triggerLiquidation` / `precloseDirect` on user's behalf | P-P: user has 1 keeper enabled with `KEEPER_ACTION_TRIGGER_LIQUIDATION` action bit set on an active loan | NEG-23: keeper without action bit calls protected fn → reverts `KeeperAccessRequired`. NEG-24: non-owner / non-keeper calls protected fn → reverts | wave-3c pending |
| **§ Public Analytics Dashboard** | (read-only frontend page, no state change) | n/a | n/a | n/a |
| **§ Refinance > Step 1 + 2** | N4 (already passing) | P-Q: borrower has posted a refinance offer but new lender hasn't accepted yet (offer is open + linked) | NEG-25: refinance with smaller offer.amountMax than original principal reverts `InvalidRefinanceOffer`. NEG-26: refinance when periodic-interest period overdue reverts `RefinanceRequiresPeriodSettle`. | wave-3a pending |
| **§ Preclose > Direct (Option 1)** | Sepolia-7 (already passing) | covered by P-M (mid-term loan) | NEG-27: preclose by non-borrower reverts `KeeperAccessRequired` | wave-3a pending |
| **§ Preclose > Transfer Obligation (Option 2)** | N5 (already passing) | P-R: existing loan + Ben's takeover offer posted but Alice hasn't called transferObligation yet | NEG-28: takeover offer with `collateralAmount < loan.collateralAmount` reverts `InsufficientCollateral`. NEG-29: takeover offer with `durationDays > remainingDays` reverts `InvalidOfferTerms`. | wave-3a pending |
| **§ Preclose > Offset (Option 3)** | N6 (in flight — `completeOffsetInternal` fix building) | P-S: Alice's offset offer posted, NFT locked, Charlie hasn't accepted yet | NEG-30: cancel the offset offer (release the borrower-NFT lock) and verify lock cleared | wave-2 in-flight |
| **§ Early Withdrawal (Lender)** | Sepolia-8 (already passing — sellLoanViaBuyOffer path) + N15 (NEW): the `createLoanSaleOffer + completeLoanSale` auto-link path (currently broken — same bug as completeOffset; fix mirrors `completeOffsetInternal`) | P-T: lender has posted a sale offer, link mapping `saleOfferToLoanId` populated, no buyer yet | NEG-31: sale offer where `interestRateBps` decreases reverts (lender-disadvantageous) | wave-2 / wave-3 |
| **§ Stuck-Token Recovery > Recovery flow** | N7 (already passing) | P-U: user's escrow holds a stray ERC-20 (not in `protocolTrackedEscrowBalance`), recovery untriggered | NEG-32: bad EIP-712 signature reverts. NEG-33: `declaredSource == user` reverts. NEG-34: replay with stale nonce reverts. NEG-35: deadline passed reverts. | wave-3a pending |
| **§ Stuck-Token Recovery > Sanctioned-source ban** | N8 (NEW): random sanctioned address sends tokens to user's escrow; user signs recovery; oracle returns true → `escrowBannedSource[user]` set, recovery does NOT execute, ban event emitted | P-V: user is in banned state (`escrowBannedSource[user] != address(0)`) and oracle still flags the source | NEG-36: lender escrow operations from a banned user revert SanctionedAddress (Tier-1) but `repayLoan` / claim still work (Tier-2) | wave-3a pending |
| **§ Stuck-Token Recovery > Disowning** | N9 (NEW): user calls `disown(token)` on tokens they don't want | P-W: user has called disown on one stray asset (event emitted) | NEG-37: disown on a token with zero balance — verify behaviour (event-only, no revert) | wave-3a pending |

## Protocol flows NOT in the Advanced User Guide

The Advanced Guide deliberately omits bot/keeper-driven, MEV-defensive, admin-only, and cross-chain mechanics. These rows complete the test scope.

| Flow class | Positive | Partial midpoint | Negative | Source |
|---|---|---|---|---|
| **Range Orders matching (bot)** | N1 (already passing — match + partial fill + dust auto-close) | P-X: lender offer with `[1k, 5k]` posted but `amountFilled == 0` (no match yet), borrower offer compatible — bot's `previewMatch` should return `Ok` | NEG-R1: matchOffers when `partialFillEnabled=false` reverts `FunctionDisabled(3)`. NEG-R2: pair with no amount overlap reverts `AmountNoOverlap`. NEG-R3: pair with no rate overlap reverts `RateNoOverlap`. NEG-R4: borrower's collateral below midpoint required reverts `CollateralBelowRequired`. NEG-R5: synthetic HF below 1.5e18 reverts `MatchHFTooLow`. NEG-R6: asset mismatch reverts `AssetMismatch`. NEG-R7: duration mismatch reverts `DurationMismatch`. | RangeOffersDesign.md |
| **HF-based liquidation (permissionless)** | N16 (NEW): borrower's HF drops < 1e18 (collateral price tanks via mock oracle), keeper calls `RiskFacet.triggerLiquidation`, 0x mock swap fires, lender + matcher receive bonus | P-Y: loan with HF in 1.0–1.5 range (warning band) so HF watcher's threshold ladder fires alerts but liquidation NOT yet permitted | NEG-L1: triggerLiquidation when HF >= 1.0 reverts `HealthFactorAboveThreshold`. NEG-L2: triggerLiquidation on a Settled loan reverts `InvalidLoanStatus`. NEG-L3: triggerLiquidation when no swap adapter configured reverts `NoSwapAdapterAvailable`. | RiskFacet.sol + Phase 7a |
| **Time-based default + liquidation** | N17 (NEW): loan duration + grace period elapsed, keeper calls `DefaultedFacet.markDefaulted`, liquid collateral swapped (0x), illiquid transferred direct to lender | P-Z: loan with `block.timestamp > endTime + gracePeriod` but `markDefaulted` NOT yet called (transitional state where someone could still race repay-vs-default) | NEG-D1: markDefaulted before grace expired reverts `LoanNotDefaultable`. NEG-D2: double markDefaulted reverts `InvalidLoanStatus`. NEG-D3: illiquid both legs without `creatorFallbackConsent && acceptorFallbackConsent` should never have been allowed at offer-create — verify enforcement. | DefaultedFacet.sol |
| **Periodic Interest Payment (T-034)** | N2 (deferred): 400-day loan with annual cadence; lender or keeper calls `settlePeriodicInterest` when period elapsed; treasury share + lender share split | P-AA: long-duration loan past first cadence boundary but not yet settled (overdue interest pending) | NEG-PI1: settle before cadence interval elapses reverts `PeriodicInterestNotDue`. NEG-PI2: settle on a non-cadence loan (`cadence == None`) reverts. | PeriodicInterestPaymentDesign.md |
| **Per-asset pause (admin)** | N18 (NEW): admin calls `pauseAsset(USDC)`, then `pauseAsset(USDC)` second time is idempotent; `unpauseAsset(USDC)` reverses | P-AB: asset paused, existing loans active, but no new offers using the paused asset can be created | NEG-PB1 (already in cross-cutting): paused asset rejects `createOffer` and `acceptOffer` | AdminFacet |
| **Global pause (admin)** | N19 (NEW): admin calls `pause()`, all entry points revert, then `unpause()` | P-AC: paused diamond, every state-modifying call reverts | NEG-PB2 (already in cross-cutting): every state-modifying entry reverts `EnforcedPause` | AdminFacet |
| **Treasury fee accrual** | N20 (NEW): take a loan, repay with interest, verify `treasuryAccruedERC20[asset]` increased by treasuryShare; admin calls `withdrawTreasury` to extract | P-AD: treasury has accrued fees from multiple loans; `getTreasuryAccrued(asset)` returns non-zero | NEG-T1: non-treasurer calls `withdrawTreasury` reverts `AccessControl`. NEG-T2: withdraw more than accrued reverts. | TreasuryFacet |
| **Per-action keeper authorization (Phase 6)** | N12 in matrix above | P-P in matrix above | NEG-23, NEG-24 in matrix above | ProfileFacet.setLoanKeeperEnabled |
| **Match-fee 1% LIF kickback** | covered by N1 (matcher receives 1% of lender's LIF) | P-AE: completed match where matcher's wallet shows the 1% kickback in lending asset | NEG-MF1: matcher == address(0) edge case — verify routed to msg.sender or treasury (consult LibOfferMatch.matcherShareOf) | RangeOffersDesign §"1% match fee" |
| **Cancel cooldown (MEV defense)** | N21 (NEW): 0-fill cancel after `block.timestamp >= createdAt + 5 min` succeeds; partial-filled cancel succeeds immediately (no cooldown) | P-AF: open offer at `createdAt + 2 min` — within cooldown window; cancel attempt should revert | NEG-CC1, NEG-CC2 in cross-cutting | RangeOffersDesign §9.2 |
| **Borrower NFT lock during preclose-offset** | covered by P-S (offset offer posted) | covered | NEG-32 (cross-cutting): try to transfer the locked borrower NFT directly via `safeTransferFrom` reverts via `LibERC721._enforceLock` | PrecloseFacet §Option 3 |
| **Range-amount + range-rate auto-collapse** | (covered by N1 + N3 — auto-collapse keeps legacy single-value byte-identical) | n/a — no distinct UI state | NEG-RA1: `amountMax < amount` reverts `InvalidAmountRange`. NEG-RA2: `interestRateBpsMax < interestRateBps` reverts `InvalidRateRange`. NEG-RA3: `interestRateBpsMax > MAX_INTEREST_BPS` reverts `InterestRateAboveCeiling`. | RangeOffersDesign §2.1 |
| **Master flag dormancy** | N22 (NEW): with `partialFillEnabled = false`, every legacy single-value offer + acceptOffer flow works byte-identically (regression that flag dormancy is non-breaking) | n/a | NEG-MF1: any range offer reverts `FunctionDisabled(1/2/3)` while flag off | RangeOffersDesign §15 |
| **Phase 7a swap adapter failover** | N23 (NEW): liquidation when 0x is degraded → falls back to 1inch → succeeds | P-AG: triggerLiquidation flow ready (HF<1) but adapter chain has only 0x configured | NEG-S7a1: all adapters disabled reverts `NoSwapAdapterAvailable` | LibSwap.sol + Phase 7a |
| **Phase 7b secondary-oracle quorum** | N24 (NEW): primary Chainlink stale → quorum from API3 + DIA returns price → loan operations continue | P-AH: primary feed at staleness threshold boundary | NEG-S7b1: only 1 of 3 oracles available reverts `OracleQuorumNotReached` | Phase 7b.2 |
| **Cross-chain VPFI buy adapter mode** | OUT OF SCOPE — needs LZ multi-chain setup | n/a | covered by `VPFIBuyAdapterPaymentTokenTest.t.sol` unit tests | VPFIBuyAdapter.sol |
| **Reward OApp delivery** | OUT OF SCOPE — needs LZ multi-chain setup | n/a | covered by `RewardOAppDeliveryTest.t.sol` | VaipakamRewardOApp.sol |
| **DVN policy enforcement** | OUT OF SCOPE — admin script (ConfigureLZConfig) | n/a | covered by `LZConfig.t.sol` | ConfigureLZConfig.s.sol |
| **Storage chokepoint counter parity (T-051)** | implicit in every flow that ticks `protocolTrackedEscrowBalance` | n/a | NEG-CT1: directly transfer ERC-20 to a user's escrow proxy + try to use the counter-tracked path → underflow reverts (this is exactly the bug we found in SepoliaPositiveFlows scenarios 3/10/11; covered by Option A patch) | T-051 design |

## Every external entry-point coverage check

Run `grep -rn "external nonReentrant" contracts/src/facets/` — every entry must have at least one positive + one negative scenario in this matrix. As of 2026-05-04 the entry-point list is:

```
AddCollateralFacet.addCollateral
ClaimFacet.claimAsLender / claimAsBorrower
DefaultedFacet.markDefaulted
EarlyWithdrawalFacet.createLoanSaleOffer / completeLoanSale / sellLoanViaBuyOffer / cancelLoanSaleOffer
LoanFacet.initiateLoan
OfferFacet.createOffer / createOfferWithPermit / acceptOffer / acceptOfferWithPermit
OfferCancelFacet.cancelOffer
OfferMatchFacet.matchOffers
PartialWithdrawalFacet.partialWithdraw
PrecloseFacet.precloseDirect / offsetWithNewOffer / completeOffset / transferObligationViaOffer
RefinanceFacet.refinanceLoan
RepayFacet.repayLoan / repayPartial / autoDeductDaily
RiskFacet.triggerLiquidation
TreasuryFacet.mintVPFI / withdrawTreasury / rotateTreasury
VPFIDiscountFacet.depositVPFIToEscrow / withdrawVPFIFromEscrow / setVPFIDiscountConsent
```

Cross-reference each against the matrix rows above. Anything missing gets added with a new N## or P-## or NEG-## ID.

## Cross-cutting negative flows (not tied to a specific guide section)

| ID | Scenario | Guide context |
|---|---|---|
| NEG-S1 | Sanctions Tier-1 deny: sanctioned address calls `createOffer` → reverts `SanctionedAddress` | retail policy doc + every Tier-1 entry |
| NEG-S2 | Sanctions Tier-2 close-out: sanctioned address can still call `repayLoan` / `claimAsBorrower` | retail policy doc |
| NEG-K1 | KYC threshold: transaction value > `KYC_THRESHOLD_USD = 2000e18` and user has `KYCTier.Tier0` → reverts `KYCRequired` (when `kycEnforcementEnabled = true` — currently OFF on retail) | KYC tier ladder |
| NEG-CC1 | Cancel cooldown: cancel an unfilled offer when `partialFillEnabled=true` and `block.timestamp < createdAt + 5 min` → reverts `CancelCooldownActive` | cancel offer |
| NEG-CC2 | Cancel cooldown bypass: cancel a partial-filled offer (`amountFilled > 0`) immediately after the partial fill — should succeed | range orders design |
| NEG-PB1 | Asset paused: `pauseAsset(USDC)` → `createOffer(usdc-as-principal)` reverts `AssetPaused` | per-asset pause |
| NEG-PB2 | Diamond paused: `pause()` → every entry-point reverts `EnforcedPause` | global pause |
| NEG-PE1 | Permit2 bad signature: `acceptOfferWithPermit` with corrupted sig reverts | Permit2 |
| NEG-PE2 | Permit2 wrong asset: `acceptOfferWithPermit` where `permit.permitted.token != offer.collateralAsset` → reverts `InvalidAssetType` | Permit2 |

## File scaffolding

```
contracts/script/
├── AnvilNewPositiveFlows.s.sol     # N1, N3, N4, N5, N6, N7 + N8/N9/N10/N11/N12/N13/N14/N15 to add
├── AnvilNewPartialFlows.s.sol      # P-A through P-W (UI-testable midpoint states)
└── AnvilNegativeFlows.s.sol        # NEG-1..NEG-37 + NEG-S1..NEG-S2 + NEG-K1 + NEG-CC1..NEG-CC2 + NEG-PB1..NEG-PB2 + NEG-PE1..NEG-PE2
```

Each script reuses the same env-var topology (`PRIVATE_KEY`,
`ADMIN_PRIVATE_KEY`, `ADMIN_ADDRESS`, `LENDER_PRIVATE_KEY` /
`LENDER_ADDRESS`, `BORROWER_PRIVATE_KEY` / `BORROWER_ADDRESS`,
`NEW_LENDER_*`, `NEW_BORROWER_*`) and the same setup pattern
(`MockChainlinkRegistry` + `MockUniswapV3Factory` + `MockSanctionsList`
deployed inside the script for chain-self-containment).

## How to add a new scenario

1. Pick the row in this matrix it satisfies. Mark status pending → in-flight → done.
2. Write the scenario inside the relevant file as a `_scenarioXX_*()` private fn.
3. Add it to `run()`'s scenario sequence.
4. Run against fresh anvil:
   ```bash
   bash contracts/script/anvil-bootstrap.sh
   forge script contracts/script/AnvilNew*.s.sol --rpc-url http://localhost:8545 --broadcast --slow
   ```
5. If a contract fix is needed, land it with the test (don't merge a test that depends on broken contract code).
6. Update the **Status** column in this file.

## Out-of-scope rationale

- **Buy VPFI** flow needs LayerZero endpoint mocks + cross-chain message simulation. Anvil is a single-chain testbed; this belongs in a separate fork test or LZ-multi-chain harness.
- **Alerts** is a Cloudflare Worker concern (`ops/hf-watcher`); covered by worker integration tests, not the contract test suite.
- **NFT Verifier** is a pure oracle view (`OracleFacet.checkLiquidity`); already exercised indirectly by every NFT scenario.
- **Public Analytics Dashboard** is a frontend page reading on-chain metrics; no state change.
- **Allowances** is a frontend ERC-20 approval-management surface; the contract side is just `IERC20.approve` which has no Vaipakam-specific code path.
