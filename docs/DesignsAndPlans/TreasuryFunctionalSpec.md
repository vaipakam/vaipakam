# Treasury Subsystem — Functional Specification (Auditor Copy)

**Status:** As-built (T-600), branch `feat/t600-treasury-founder-comp`.
**Audience:** Security auditors, the contracts engineer, governance.
**Companion docs:**
- [`TreasuryAndFounderDistribution.md`](TreasuryAndFounderDistribution.md) — design rationale + the rejected per-fee auto-route + the legal analysis (§2, §6, §12).
- [`TreasuryExplainer.md`](TreasuryExplainer.md) — the same subsystem in plain language for users.
- [`../FunctionalSpecs/TokenomicsTechSpec.md`](../FunctionalSpecs/TokenomicsTechSpec.md) §3 / §3a — VPFI allocation + people-pool semantics.

This document is the precise functional surface of the treasury
subsystem. Where it conflicts with prose in `TreasuryAndFounderDistribution.md`
§1–§11 (an evolving design proposal), **this document governs** — it
reflects shipped code.

---

## 1. Scope

The treasury subsystem covers four concerns:

1. **Fee accumulation** — protocol fees land in the Diamond, tracked per-asset.
2. **Conversion** — accumulated fee assets are converted into a governance-set target allocation of ETH / wrapped-BTC / VPFI.
3. **Founder / contributor payroll** — continuous salary streams paid from the treasury.
4. **Genesis vesting** — cliff + linear vesting wallets for token grants.

Facets / contracts: `TreasuryFacet`, `ConfigFacet` (knobs), `PayrollFacet`,
`VaipakamVestingWallet`. Shared storage in `LibVaipakam`.

---

## 2. Fee accumulation (pre-existing)

Fees from interest yield, loan-initiation, liquidation handling, late
fees etc. accrue through `LibFacet.recordTreasuryAccrual(asset, amount)`
into `s.treasuryBalances[asset]`. This is unchanged by T-600 and is the
*only* writer of fee inflows.

**Diamond-as-treasury mode.** `s.treasury` is configurable. When
`s.treasury == address(this)` (the Diamond is its own treasury) fee
tokens physically rest in the Diamond and `treasuryBalances` tracks
them. When `s.treasury` is an external EOA/multisig, fees are forwarded
out and `treasuryBalances` is not populated. **The convert function and
the payroll streams require Diamond-as-treasury mode** — they act only
on funds inside the Diamond.

The T-051 chokepoint counter (`protocolTrackedEscrowBalance`) keeps
protocol-tracked balances distinct from unsolicited dust; the convert
function reads `treasuryBalances` (clean), never raw `balanceOf`.

---

## 3. `TreasuryFacet.convertTreasuryAsset`

```solidity
function convertTreasuryAsset(
    address tokenIn,
    LibSwap.AdapterCall[] calldata ethCalls,
    LibSwap.AdapterCall[] calldata wbtcCalls,
    LibSwap.AdapterCall[] calldata vpfiCalls,
    uint256 minOutEth, uint256 minOutWbtc, uint256 minOutVpfi
) external nonReentrant whenNotPaused onlyRole(ADMIN_ROLE);
```

Converts the entire accumulated treasury balance of one input asset
into the target allocation. One `tokenIn` per call — a keeper loops
off-chain; each call is atomic and independently auditable.

**Control flow (in order):**

1. `s.treasury == address(this)` else revert `TreasuryNotDiamond`.
2. `tokenIn != address(0)` else revert `InvalidAddress`.
3. `balance = s.treasuryBalances[tokenIn]`; `balance != 0` else revert `ZeroAmount`.
4. Eligibility gate (`_eligibleForConversion`) else revert `ConversionNotEligible` — see §3.1.
5. Resolve targets: `weth = s.wethContract`, `wbtc = s.treasuryWbtcAsset`, `vpfi = s.vpfiToken`. `weth` and `vpfi` non-zero else revert `TreasuryConvertTargetUnset`. `wbtc == address(0)` is permitted — the wBTC leg is skipped and folds into the VPFI remainder.
6. Split: `toEth = balance·ethBps/10000`, `toWbtc = balance·wbtcBps/10000` (0 if `wbtc` unset), `toVpfi = balance − toEth − toWbtc`. **VPFI is the remainder** — it absorbs integer-division rounding and any skipped wBTC leg.
7. **CEI**: `treasuryBalances[tokenIn] = 0` and `treasuryLastConversionAt = block.timestamp` are written *before* any external swap.
8. Settle each leg via `_convertLeg` (§3.2).
9. Emit `TreasuryConverted(tokenIn, balance, toEth, toWbtc, toVpfi)`.

### 3.1 Eligibility gate

A conversion is eligible when **either** leg holds:
- **Time leg** — `block.timestamp − treasuryLastConversionAt ≥ maxIntervalDays·1 days`. A never-converted treasury (`treasuryLastConversionAt == 0`) trivially satisfies this — the first conversion is always allowed.
- **Value leg** — the numeraire value of `balance` ≥ `treasuryConvertUsdThreshold`. Best-effort: priced via `OracleFacet.tryGetAssetPrice` (never reverts); an unpriceable asset leaves only the time leg in force.

Purpose: stops dust-sized griefing conversions and treasury stagnation.

### 3.2 `_convertLeg` (private)

For each (tokenIn → tokenOut, amount) leg:
- `amount == 0` → no-op.
- `tokenIn == tokenOut` → **skip the swap**; credit `amount` straight back to `treasuryBalances[tokenOut]` (the slice already *is* the target — no self-swap).
- otherwise → `LibSwap.swapWithFailover(0, tokenIn, tokenOut, amount, minOut, address(this), calls)`. The `loanId` argument is the sentinel **`0`** — loan ids are 1-based, so `0` marks a treasury conversion in the swap-event stream. On soft-failure (`success == false`, every adapter exhausted) → revert `TreasuryConvertSwapFailed(tokenOut)`; because step 7 already zeroed the input balance, the whole-call revert rolls that back — **funds are never lost**. On success, credit `outAmount` to `treasuryBalances[tokenOut]`.

`recipient` is always `address(this)` — converted output stays inside
the Diamond, re-credited to `treasuryBalances`. Distribution out of the
treasury (buyback / staker boost / operating budget) is a *separate*
governance action, not part of this function.

### 3.3 Errors / events

Errors: `TreasuryNotDiamond`, `ZeroAmount`, `ConversionNotEligible`,
`TreasuryConvertTargetUnset`, `TreasuryConvertSwapFailed(tokenOut)`,
`InvalidAddress`. Event: `TreasuryConverted`.

---

## 4. Configuration knobs (`ConfigFacet`)

All `onlyRole(ADMIN_ROLE)` (Timelock post-handover). Stored on
`ProtocolConfig`; a stored `0` resolves to the library default via the
`cfg*` getters — so a fresh deploy keeps the documented defaults until
governance overrides.

| Knob | Setter | Default | Bound |
| --- | --- | --- | --- |
| ETH-leg BPS | `setTreasuryConvertTargets(ethBps, wbtcBps)` | 4000 (40%) | `eth + wbtc ≤ 10000` else `InvalidTreasuryConvertTargets` |
| wBTC-leg BPS | (same setter) | 3000 (30%) | — |
| VPFI-leg BPS | — (unstored remainder `10000 − eth − wbtc`) | 3000 (30%) | — |
| USD threshold | `setTreasuryConvertThresholds(usd, days)` | `10_000e18` | — |
| Max interval (days) | (same setter) | 30 | — |
| wBTC target asset | `setTreasuryWbtcAsset(address)` | unset | `address(0)` allowed → wBTC leg disabled |

View: `getTreasuryConvertConfig()` returns the effective
`(ethBps, wbtcBps, vpfiBps, usdThreshold, maxIntervalDays, lastConversionAt, wbtcAsset)`.
Events: `TreasuryConvertTargetsSet`, `TreasuryConvertThresholdsSet`,
`TreasuryWbtcAssetSet`.

---

## 5. `PayrollFacet` — founder / contributor salary streams

A salary stream pays a beneficiary a continuous per-second amount out of
treasury funds. It is the on-chain mechanism for **Layer 2** of the
founder-income model (§12 of `TreasuryAndFounderDistribution.md`).

### 5.1 Data model — `PayrollStream`

```
beneficiary, asset, ratePerSecond, funded, withdrawn,
accruedAtAnchor, lastRateChangeAt, paused, exists
```
`s.payrollStreams[id]`; `s.payrollStreamCount` is the 1-based id source
(id 0 is the "no stream" sentinel).

### 5.2 Accrual math

```
accrued      = accruedAtAnchor + (paused ? 0 : (now − lastRateChangeAt)·ratePerSecond)
withdrawable = min(accrued, funded) − withdrawn
```

`_settleAccrual` folds the live window into `accruedAtAnchor` and
re-stamps `lastRateChangeAt` — invoked before every rate change / pause
toggle so a change is **never retroactive**.

### 5.3 Surface

| Function | Access | Notes |
| --- | --- | --- |
| `createPayrollStream(beneficiary, asset, rate) → id` | ADMIN_ROLE | `beneficiary`/`asset` non-zero. |
| `fundPayrollStream(streamId, amount)` | ADMIN_ROLE | Debits `treasuryBalances[asset]` into `funded`. Reverts `PayrollTreasuryInsufficient` if short, `PayrollTreasuryNotDiamond` if not Diamond-as-treasury. **The only `funded` writer.** |
| `setPayrollRate(streamId, newRate)` | ADMIN_ROLE | Settles accrual at the old rate first. |
| `setPayrollStreamPaused(streamId, bool)` | ADMIN_ROLE | Paused window does not accrue. |
| `withdrawSalary(streamId)` | beneficiary only | `nonReentrant`, CEI, Tier-1 sanctions-gated. No timelock delay — earned wages. |
| `getPayrollStream` / `getWithdrawableSalary` / `getPayrollStreamCount` | view | — |

### 5.4 The load-bearing invariant (audit focus)

**`withdrawable` is clamped to `funded`.** A stream pays out only what
governance has *deliberately* deposited via `fundPayrollStream`. There
is **no code path** — none — from a fee accrual or from
`convertTreasuryAsset` into `funded` / `ratePerSecond`. This is the
structural property that makes the salary *compensation for services*
rather than a securities-style automatic revenue share (see
`TreasuryAndFounderDistribution.md` §2A, §12.3). Regression test:
`test_treasuryAccrual_doesNotFundStream`.

Errors: `PayrollStreamNotFound`, `NotPayrollBeneficiary`,
`NothingToWithdraw`, `ZeroFundAmount`, `PayrollTreasuryInsufficient`,
`PayrollTreasuryNotDiamond`. Events: `PayrollStreamCreated`,
`PayrollStreamFunded`, `PayrollRateSet`, `SalaryWithdrawn`,
`PayrollStreamPauseSet`.

---

## 6. `VaipakamVestingWallet` — genesis vesting

A concrete cliff + linear vesting wallet (a thin wrapper making OZ's
`abstract VestingWalletCliff` deployable). One instance per grantee
(founder, developer/team hire, early contributor, the ecosystem pool).

`constructor(beneficiary, startTimestamp, durationSeconds, cliffSeconds)`.
Nothing releasable before `start + cliff`; linear thereafter.
`release(token)` is permissionless and always pays the beneficiary.
Non-upgradeable by design — no admin key can alter a schedule after
grant. Funded once by `TreasuryFacet.mintVPFI(walletAddress, amount)`.

---

## 7. Access control & phasing

- **Phase 1** — ADMIN_ROLE (the deployer/admin EOA) triggers convert + payroll-admin functions.
- **Phase 2** — those move behind the 48h `VaipakamTimelock`. `withdrawSalary` stays beneficiary-callable with no delay.
- **Phase 3** — governance-proposal-driven, optionally public post-delay execution.

---

## 8. Invariants for the auditor to confirm

1. `convertTreasuryAsset` is inert (`TreasuryNotDiamond`) unless `s.treasury == address(this)`.
2. After a conversion, `treasuryBalances[tokenIn]` is 0 and the three target balances sum (post-swap) to the converted value — VPFI absorbs rounding.
3. A swap soft-failure reverts the whole call; no partial state, no lost funds.
4. `withdrawSalary` can never pay more than `funded − withdrawn`; `withdrawn` is monotone.
5. No code path links `recordTreasuryAccrual` / `convertTreasuryAsset` → `fundPayrollStream` / `setPayrollRate`.
6. `setPayrollRate` / pause are non-retroactive (accrual settled at the prior rate).
7. New `ProtocolConfig` fields + `PayrollStream` mapping are storage-appended (prelive; layout is repacked under EC-006 before mainnet).

---

## 9. Out of scope / pre-TGE legal gate

The contract code is built and test-covered. The genesis *actions* —
`mintVPFI` into vesting wallets, `createPayrollStream` with a real
beneficiary/rate, the first real `fundPayrollStream` — are gated on a
securities-lawyer sign-off (`TreasuryAndFounderDistribution.md` §6).
`DeployFounderVesting.s.sol` enforces this: it deploys an *empty*
vesting wallet unless `CONFIRM_TGE_FUNDING=YES` is set.

Test coverage: `contracts/test/TreasuryConvertAndPayroll.t.sol`
(19 cases). Full suite green at implementation time:
1979 passed / 0 failed / 5 skipped.
