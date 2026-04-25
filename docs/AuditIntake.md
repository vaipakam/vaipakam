# Vaipakam — Audit Intake

Handoff document for external audit. Summarises architecture, trust
assumptions, known deviations, and areas auditors should prioritise. Paired
with [`CLAUDE.md`](../CLAUDE.md) and [`README.md`](../README.md) — read both
before reviewing code.

---

## Scope

**In scope**

- All facets under [`contracts/src/facets/`](../contracts/src/facets/).
- Shared storage and constants: [`libraries/LibVaipakam.sol`](../contracts/src/libraries/LibVaipakam.sol).
- Per-user escrow: [`VaipakamEscrowImplementation.sol`](../contracts/src/VaipakamEscrowImplementation.sol).
- Diamond router: [`VaipakamDiamond.sol`](../contracts/src/VaipakamDiamond.sol).
- Fallback/cure path (recent change): `RiskFacet`, `DefaultedFacet`,
  `ClaimFacet`, `AddCollateralFacet`, `RepayFacet`.

**Out of scope**

- OpenZeppelin Contracts Upgradeable, Chainlink feed registry, the
  three V3-clone factories (UniswapV3 / PancakeSwap V3 / SushiSwap V3),
  Balancer V2 Vault, Tellor Oracle, API3 ServerV1, DIA Oracle V2,
  Uniswap Permit2 — treated as trusted external dependencies.
- Frontend (`frontend/`) and deployment scripts (`contracts/script/`) —
  reviewed informally, not part of the audit surface. The frontend's
  0x preflight check (Phase 7b.1) is a UX-layer guard only; the
  on-chain attack surface is the on-chain V3-clone OR-logic.

---

## Architecture at a glance

- **EIP-2535 Diamond**: `VaipakamDiamond` fallback dispatches by selector;
  every facet shares storage at `keccak256("vaipakam.storage")` via
  `LibVaipakam.storageSlot()`.
- **Cross-facet calls**: every internal hop is
  `address(this).call(abi.encodeWithSelector(...))` so it re-enters the
  Diamond fallback. `DiamondReentrancyGuard` protects the outer call;
  inner calls share the same guard slot.
- **Per-user escrow**: `EscrowFactoryFacet` deploys one ERC1967 proxy per
  user (UUPS, `VaipakamEscrowImplementation`). User assets live there —
  the Diamond only holds funds transiently during swaps/fallbacks.

---

## Trust assumptions

| Role | Address | Powers |
|------|---------|--------|
| Owner / admin | Multisig | Facet cuts, pause, treasury config, oracle config (Chainlink + Tellor + API3 + DIA + V3-clone factory addresses), swap-adapter chain config, KYC verifier role |
| Treasury | Multisig | Receives fee skim (`Yield Fee` on interest, 2% liquidation fallback) |
| KYC verifier | Role-gated address | `ProfileFacet.verifyKYC` — gates loans above `KYC_THRESHOLD_USD` |

Key assumption: **the admin multisig can halt the protocol via `pause()`
but cannot rewrite user claims or move user escrow funds.** Auditors
should verify that no facet function gives admin direct control over
`lenderClaims[...]`, `borrowerClaims[...]`, `fallbackSnapshot[...]`, or
per-user escrow proxies.

No timelock. Rationale (deliberate, documented): a failed-liquidation
lender position decays if collateral keeps falling, so a timelock on
admin actions would harm lenders in exactly the scenarios they most need
protection.

---

## Priority review areas

1. **Fallback-cure policy** (`LoanStatus.FallbackPending`).
   - Failed liquidation in `RiskFacet._fullCollateralTransferFallback` and
     `DefaultedFacet._fullCollateralTransferFallback` now sets
     `FallbackPending` (not `Defaulted`), recording the three-way split
     in `fallbackSnapshot[loanId]`.
   - Borrower may cure until the lender claims: `addCollateral` reactivates
     to `Active` when post-topup HF ≥ `MIN_HEALTH_FACTOR` (1.5e18);
     `repayLoan` full repay transitions to `Repaid` and returns
     Diamond-held collateral to borrower escrow.
   - `ClaimFacet.claimAsLender` runs the one-shot 0x retry and then
     terminally transitions `FallbackPending → Defaulted`.
   - `ClaimFacet.claimAsBorrower` is blocked during `FallbackPending` so
     the borrower cannot short-circuit cure by taking the split early.
   - Verify: no path leaves a loan `Active` / `Repaid` with a non-empty
     snapshot; no path double-spends collateral (cure returns held
     collateral *and* lender claims against it); snapshot is deleted in
     both cure paths and the lender-claim path.

2. **Per-user escrow isolation**.
   - Each user's ERC20/721/1155 holdings live in their own UUPS proxy.
     Confirm no cross-user reach: `escrowWithdrawERC20` must only be
     callable by the Diamond against the user's own escrow, and the
     implementation cannot be upgraded by anyone except the Diamond
     (UUPS `_authorizeUpgrade` gate).

3. **Liquidation swap path** (`RiskFacet.triggerLiquidation`,
   `DefaultedFacet.triggerDefault`).
   - 6% slippage ceiling enforced via `minOutputAmount` derived from
     oracle-implied price — confirm oracle prices are used for the gate,
     not caller-supplied values.
   - 0x allowance set to exact `collateralAmount`, revoked immediately
     after the call, regardless of success.
   - On swap failure, collateral is withdrawn to Diamond and split via
     `fallbackSnapshot`. Confirm the snapshot sums to `collateralAmount`
     (no rounding leaks).

4. **Oracle staleness** (`OracleFacet.getAssetPrice`,
   `_checkLiquidityWithConfig`).
   - Staleness gate: `answer > 0`, `updatedAt != 0`,
     `updatedAt >= now - 1 hours`, `roundId == answeredInRound`.
   - Fail-closed on any revert from the feed registry or aggregator.
   - 1-hour window is global; feeds with slower natural cadence (e.g.,
     some commodity feeds) may false-negative. Consider per-asset
     configurable staleness as a follow-up.

5. **Active-network-only liquidity** (`checkLiquidity` and
   `checkLiquidityOnActiveNetwork`).
   - README §1 / line 1076: liquidity is judged purely from the current
     active network. The prior Ethereum-mainnet reference layer (the
     `AssetBlockedUseMainnet` block-and-redirect path) has been retired.
     Both entry points now return Liquid/Illiquid based only on the
     active network's Chainlink registry and v3-style concentrated-liquidity AMM pool availability.
   - `checkLiquidity` and `checkLiquidityOnActiveNetwork` are now
     functionally identical; the split is retained purely for call-site
     clarity (authorization boundaries vs liquidation-execution routing).

6. **NFT rental flow** (ERC721/ERC1155 with ERC4907).
   - Rental duration, prepay, buffer, auto-daily deduction, renter reset.
   - Confirm `setUser(0, 0)` reset on repay / default / autoDeductDaily
     terminal path so the renter cannot retain control past their paid
     window.

7. **Cross-facet revert-data loss**.
   - Most `address(this).call(...)` sites currently swallow the inner
     revert and re-emit a tagged `CrossFacetCallFailed(string)`.
     [`libraries/LibRevert.sol`](../contracts/src/libraries/LibRevert.sol)
     provides `bubbleOnFailure` to forward inner reverts verbatim. A
     follow-up migration will apply it uniformly; until then, debugging
     production reverts may require trace inspection.

---

## Known deviations / design choices

- **No timelock** on admin actions — see rationale above.
- **`useFullTermInterest`** per-loan flag controls interest accrual
  (full-term vs pro-rata). Borrowers choose at offer-acceptance time;
  confirm the flag is propagated correctly from offer → loan.
- **Illiquid collateral valued at $0**: deliberate. Both parties must
  explicitly consent to illiquid collateral at offer time, and
  liquidation falls back to full-collateral transfer (no swap).
- **Feed Registry deprecation**: Chainlink marked the Feed Registry
  deprecated. Migration to direct aggregators is planned for Phase 2.
- **No per-asset governance config for oracles or DEX venues**
  (Phase 7b). The Soft 2-of-N quorum reads `IERC20.symbol()` on-chain
  to derive Tellor / API3 / DIA query keys. The 3-V3-clone OR-logic
  discovers pools via `factory.getPool(...)`. Auditors should verify
  that an attacker cannot manipulate the symbol-derivation path
  (e.g., a malicious token whose `symbol()` returns a symbol owned
  by a different asset on the upstream oracle to spoof a price).
  The OracleFacet only ever applies the secondary check as a
  *deviation gate against Chainlink's primary*, so a spoofed symbol
  would have to land within the 5% deviation band to push a price
  through — not zero risk, but materially bounded.
- **Soft 2-of-N graceful fallback**: when every secondary returns
  Unavailable for an asset (no reporter coverage, symbol unreadable,
  etc.), the protocol accepts the Chainlink-only price. This is
  deliberate to preserve operability on long-tail assets. A
  sophisticated attacker who can DoS / silence every secondary on a
  target asset's symbol can downgrade enforcement to Chainlink-only.
  Auditors should evaluate whether this fallback is acceptable
  given the deployed coverage matrix.
- **Liquidation routing trust** (Phase 7a). The
  `triggerLiquidation` / `triggerDefault` signature now accepts a
  caller-supplied ranked `AdapterCall[]` try-list. The caller picks
  routes; the contract enforces the oracle-derived `minOutputAmount`
  on every adapter. Auditors should verify that no adapter exposes a
  side-channel for the caller to weaken `minOutputAmount` — e.g.,
  by passing crafted calldata that bypasses the underlying DEX's
  slippage guard.

---

## Test posture

- 729 Foundry tests across 25 suites, all passing on the current branch.
- Fuzz runs: 1000; invariant runs: 100 (invariant scaffold deferred —
  proper invariants need view-function plumbing to reach `nextLoanId`,
  `fallbackSnapshot`, and full claim state).
- Gas snapshots: `forge snapshot`.

---

## Deferred work (not blocking audit)

- **Revert-reason bubbling migration**: helper landed
  ([`LibRevert.sol`](../contracts/src/libraries/LibRevert.sol)), call-site
  migration pending.
- **Invariant-test scaffold**: needs `LoanFacet.getNextLoanId()` and
  `LoanFacet.getFallbackSnapshot(uint256)` view helpers first.
- **NFT-status string → enum** (`LibERC721.nftStatuses`): currently keyed
  by stringified status ("Loan Initiated", "Loan Fallback Pending",
  etc.); move to `LoanPositionStatus` enum to eliminate typo risk and
  shave gas.
- **Per-asset oracle staleness window**.

---

## Contacts

- Protocol lead: (fill in)
- Security contact: (fill in)
- Commit under review: (fill in)
