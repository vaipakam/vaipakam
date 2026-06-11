## Thread — T-092 Phase 3: `extendLoanInPlace` executor + `KEEPER_ACTION_EXTEND` activated (#503)

Phase 3 of T-092 (#499). Phase 1 (#501, merged 2026-06-10) shipped the per-side `autoExtendBorrowerCaps` / `autoExtendLenderCaps` consent storage + the borrower-only / lender-only setters. This PR adds the executor that consumes those caps to extend a loan in place — no NFT churn, no new offer, no LIF.

### What's in this PR

**New selector — `AutoLifecycleFacet.extendLoanInPlace(uint256 loanId, uint16 newRateBps, uint256 newDurationDays)`:**

1. **Auth** — `LibAuth.requireKeeperFor(KEEPER_ACTION_EXTEND, loan, /* lenderSide */ false)`. The borrower-NFT owner may invoke directly (their own loan), or a pre-approved keeper with the EXTEND action bit + per-loan enablement.

2. **Tier-1 sanctions on all three parties** — the keeper (`msg.sender`), the current borrower-NFT owner, AND the current lender-NFT owner. A sanctioned borrower can't use a clean keeper to extend; a sanctioned lender can't receive interest payouts via a keeper-driven extend; a sanctioned keeper can't even reach the executor body.

3. **Status + asset-type + cadence pre-flight** — Active loans only. ERC20 principal only (NFT rental extension would need custody changes; out of scope). Loans with a non-None periodic interest cadence must `settlePeriodicInterest` first, mirroring the existing `RefinanceFacet` settle-first guard.

4. **Both-side consent + staleness fence** — both `autoExtendBorrowerCaps[loanId].enabled` and `autoExtendLenderCaps[loanId].enabled` must be true AND each side's `setter` must still be the current NFT owner of that side. The new NFT owner (after a transfer) must explicitly re-set their caps before a keeper can extend.

5. **Cap intersection** — the proposed `newRateBps` must satisfy `lender.minRateBps ≤ newRateBps ≤ min(lender.maxRateBps, borrower.maxRateBps)`. The lender's floor protects them from a 0% extension being forced; the borrower's ceiling protects them from an above-market rate. The proposed `newEndTime = block.timestamp + newDurationDays * 1 days` must be within `min(borrower.maxNewExpiry, lender.maxNewExpiry)`.

6. **Accrued-interest math + treasury / lender split** — interest accrued from `loan.startTime` to `block.timestamp` is computed via `LibEntitlement.proRataInterest`. 1% goes to the treasury (per `TREASURY_FEE_BPS`), 99% to the lender. The fund flow routes through the borrower-NFT owner's vault → diamond → treasury / lender vault, so the keeper-driven path doesn't require any allowance from the borrower's wallet.

7. **In-place loan mutation** — `loan.startTime` rolls forward to `block.timestamp`, `loan.interestRateBps` becomes `newRateBps`, `loan.durationDays` becomes `newDurationDays`. The position NFTs are NOT touched; both sides continue to hold the same loanId.

8. **`LoanExtended` event** — `(loanId, oldRateBps, newRateBps, oldStartTime, newStartTime, oldDurationDays, newDurationDays, accruedInterest)`. Indexers can flip a loan row's rate / duration / start without a follow-up `getLoanDetails` read.

9. **Keeper reward via `LibKeeperReward.payVpfiReward`** — gas-based housekeeping reward (no LIF to skim since no new loan is created). The sanctions soft-skip from #494 applies automatically — a sanctioned keeper would have already reverted at step 2, but if some future entry point reaches the reward path with a sanctioned address it gracefully skips the payout instead of reverting the whole tx.

**`KEEPER_ACTION_ALL` widened from `0x1F` to `0x3F`** — Phase 1 deliberately kept `KEEPER_ACTION_EXTEND = 0x20` out of the "grant everything" mask so old approvals weren't auto-upgraded. Now that the executor lands, granting `KEEPER_ACTION_ALL` explicitly includes EXTEND.

### What's NOT in this PR

The Phase 2 redesign (covered by #505 Phase 2a fund-routing + sanctions, #506 Phase 2b offer-accept-time cap enforcement) — the refinance path's cap enforcement architecture needs more work than Phase 2's first attempt scoped for. Phase 3 is independent: the extend executor's cap check IS at the right point because the loan is mutated in place, not via a multi-step offer/accept flow.

### Verification

- `forge build` clean.
- `AutoLifecycleFacetTest`: 9/9 green (includes new error-selector guardrail).
- `ProfileFacetTest`: 50/50 green (the `KEEPER_ACTION_ALL` widening updated the stale-mask test).
- Deploy-sanity 12/12 (FacetSizeLimit + SelectorCoverage + DeployDiamondIntegration).
- Frontend ABI re-export clean.

The full behavioural happy-path test (keeper-driven extend with real loan + funds movement + LoanExtended event payload assertions) is deferred to the integration test PR that lands alongside Phase 2's redesign — Phase 3's safety relies on the structural checks asserted via selector-coverage + the cap-setter validation tests already in place from Phase 1.

### Operator action

None — Phase 3 is contract-only. Once deployed:
- The dapp can surface "Auto-extend my loan" UI that calls `setAutoExtendBorrowerCaps` (and the lender's counterpart calls `setAutoExtendLenderCaps`).
- Users granting "ALL" keeper permissions now grant the EXTEND bit too — UI copy should reflect that.
- Keeper bots can begin watching for loans with both-side consent set + extend-window matches; the executor handles fund flow + the 1% treasury cut + the keeper reward automatically.
