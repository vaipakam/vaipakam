# Vaipakam Platform — Smart Contract Security Scan Questionnaire

## Are there any attack vectors you are most concerned about?

Vaipakam is an EIP-2535 Diamond P2P lending / borrowing / NFT-rental protocol that custodies and moves user funds, so the highest-severity classes for us are:

**1. Oracle manipulation & price-path integrity.** This is our biggest surface. Pricing is a layered stack (`OracleFacet` / `OracleAdminFacet` / `LibRiskMath`): Chainlink-primary with a hybrid `asset/<numeraire>` → `asset/ETH × ETH/<numeraire>` fallback, a **PAD** (Predominantly Available Denominator) pivot, a **soft 2-of-N secondary quorum** (Tellor / API3 / DIA, symbol-derived), a **Pyth cross-check**, per-feed staleness/min-answer overrides, an L2 sequencer-uptime circuit breaker, and peg-aware stable staleness. We're concerned about: stale/negative/low-confidence answers slipping through, the secondary-quorum agreement/divergence logic failing open, PAD/numeraire conversion math errors, and manipulation of the **slippage-at-floor liquidity check** and **depth-tiered LTV** (V2 modeled exactly, V3 approximated from notional reserves; spot-vs-oracle and price-history manipulation guards must both hold). Also the **peer-LTV reads** (Aave V3 / Compound V3 low-level staticcalls) feeding the tier→LTV cache.

**2. Liquidation & settlement value-extraction.** Two paths (HF-based permissionless 0x/1inch/Uniswap-v3/Balancer swaps in `RiskFacet`; time-based in `DefaultedFacet`). Critical invariant: **liquidation swap calldata must use the protocol-computed, oracle-derived minimum output — the caller must not be able to influence the slippage floor.** Please verify no caller-supplied minOut, no slippage-floor bypass, and correct liquidation-bonus math.

**3. Swap-adapter arbitrary-call surface.** The aggregator adapters (`src/adapters/*`, `LibSwap`) low-level-call external routers against an allowance target. Concerns: destination allowlist bypass (unallowlisted router), approval-drain, and the "can't remove the last allowed destination" guard.

**4. Diamond storage & upgrade integrity.** ~65 facets share one storage struct at `keccak256("vaipakam.storage")`. Cross-facet calls route through the external `fallback()` via `address(this).call(...)` — a real reentrancy surface. Watch for storage-layout collisions, selector clashes, unauthorized `diamondCut`, and UUPS `_authorizeUpgrade` gaps on the per-user vault, backstop vault, and adapter implementations (uninitialized / re-initializable implementation risk).

**5. Per-user vault isolation.** `VaultFactoryFacet` deploys one `ERC1967Proxy` vault per user (UUPS). Each holds that user's ERC20/721/1155 in isolation — cross-vault fund leakage, missing caller-auth on vault entrypoints, or the ERC-4907 `setUser`/custody model letting a borrower gain real custody are top concerns. Also the **protocol-tracked-balance vs raw-balance** accounting (unsolicited-transfer dust clamp, EIP-712 stuck-token recovery).

**6. Signed-offer / gasless / intent path.** EIP-712 signed offers, Permit2-sourced stake, ERC-1271 smart-wallet signing, keeper-matcher partial fills, and standing lender intents with locked working capital. Concerns: signature replay (order-hash + nonce cancellation), partial-fill over-fill accounting, the **acceptance term-binding anti-phishing** check (confirmed terms must equal stored offer before value moves), and the **commit–reveal unguessable risk-terms anchor** that stops pre-signing consent for a future terms version.

**7. VPFI tokenomics & anti-gaming.** 230M **hard supply cap enforced on-chain**; mint only via `TreasuryFacet` / multisig-behind-timelock (no direct EOA mint). Concerns: cap enforcement across chains, the **cross-chain supply invariant** (canonical locked/minted == Σ mirror supplies), the time-weighted fee-discount accumulator re-stamping at **post-mutation** balance, the **`min(actualVaultBalance, protocolTrackedVaultBalance)` clamp** that stops unsolicited transfers inflating discount tiers, and interaction-reward pull-model accounting (`sum(userPayout[d]) == dailyPool[d]`, no double-claim, day-finalization gate).

**8. Cross-chain (Chainlink CCIP).** `CcipMessenger`, `VPFIMirrorToken` (CCT), reward messengers, `VpfiPoolRateGovernor`. Concerns: message authenticity / remote-peer validation, replay/forged-delivery handling, per-lane rate-limit bounds (governor must refuse to disable a lane), and `GuardianPausable` on both send and receive.

**9. Loan-accounting invariants.** Interest/fee math mixes BPS (1/10000) and 1e18 scaling — rounding/precision and fixed-maturity guarantees (partial repay / liquidation / swap-to-repay must not move maturity or restart the grace clock). Preclose / offset / refinance / early-withdrawal shortfall formulas must keep the original lender whole; VPFI LIF custody (`vpfiHeld`) must be zero on any settled loan.

---

## Which parts of the application should we focus on?

Scope: **Solidity contracts under `contracts/src/`** (Solidity 0.8.29, `viaIR = true`, optimizer 200 runs). Priority order:

1. **Oracle / risk / liquidation** — `OracleFacet`, `OracleAdminFacet`, `RiskFacet`, `RiskMatchLiquidationFacet`, `RiskSplitLiquidationFacet`, `RiskAccessFacet`, and libs `LibRiskMath`, `LibPeerLTV`, `LibSlippage`, `LibPeriodicInterest`, `LibRiskAccess`, `LibBackstopOracleGate`. _(Highest-value target — pricing drives every fund-moving decision.)_
2. **Core diamond & shared state** — `VaipakamDiamond.sol`, `libraries/LibVaipakam.sol`, `DiamondCutFacet`, `DiamondLoupeFacet`, `OwnershipFacet`, `AccessControlFacet`, `LibReentrancyGuard`, `LibPausable`.
3. **Loan lifecycle** — `LoanFacet`, `OfferCreateFacet` / `OfferAcceptFacet` / `OfferMatchFacet` / `OfferCancelFacet` / `OfferMutateFacet`, `SignedOfferFacet`, `LenderIntentFacet` / `IntentDispatchFacet`, `RepayFacet` / `RepayPeriodicFacet`, `DefaultedFacet`, `PrecloseFacet`, `RefinanceFacet`, `ClaimFacet`, `AddCollateralFacet`, `EarlyWithdrawalFacet` / `PartialWithdrawalFacet`, and libs `LibLoan`, `LibSettlement`, `LibCollateralSettlement`, `LibSignedOffer`, `LibOfferMatch`, `LibPermit2`.
4. **Swap adapters** — all of `src/adapters/`, `SwapToRepayFacet` / `SwapToRepayIntentFacet`, `LibSwap`, `LibSlippage`.
5. **Vaults & upgradeability** — `VaipakamVaultImplementation.sol`, `BackstopVaultImplementation.sol`, `AggregatorAdapterImplementation.sol`, `VaultFactoryFacet`, `LibUserVault`, `LibERC721`, `LibEntitlement` (ERC-4907 rental custody).
6. **VPFI token & rewards** — `VPFITokenFacet`, `VPFIDiscountFacet`, `VPFIDiscountAccumulatorFacet`, `TreasuryFacet`, `InteractionRewardsFacet`, reward remittance / aggregator / reporter facets, `LibVPFIDiscount`, `LibTreasuryYield`, `LibTreasuryBuyback`, `LibInteractionRewards`.
7. **Cross-chain** — all of `src/crosschain/` plus `governance/VaipakamTimelock.sol`.
8. **Compliance gates** — `ProfileFacet`, `LibCompliance`, `LibSanctionedLock` (verify the two-tier sanctions gating described below).

**Out of scope / lower priority:** off-chain TypeScript Workers (`apps/keeper`, `apps/indexer`, `apps/agent`), React frontends (`apps/*`), and the test suite (`contracts/test/`) — unless off-chain review is also wanted.

---

## Is there anything else we should know about this repository?

- **Build for tooling:** Solidity 0.8.29, `viaIR = true`, optimizer 200 runs; remappings in `contracts/remappings.txt`; deps in `contracts/lib/` are pinned git submodules (OpenZeppelin-Upgradeable, Diamond-3, Chainlink, chainlink-local). The full test-inclusive compile is heavy (~17 GB RSS, near the viaIR stack ceiling) — for a source-only compile use `forge build --skip test`.
- **Diamond call semantics:** "internal" cross-facet calls actually route through the external `fallback()`. A static analyzer that treats them as internal calls will misjudge reentrancy and access-control reachability — please account for this.
- **Deliberately-dormant paths — do NOT flag as dead/misconfigured.** The retail deploy is **KYC-off and country-pair-off by design**: `LibVaipakam.canTradeBetween` is intentionally pure-true and `kycEnforcementEnabled` defaults false. The gated twins (`_canTradeBetweenStorageGated`, `setKYCEnforcement`) exist only for a separate industrial fork. KYC test files carry `vm.skip`-marked Phase-2 cases intentionally.
- **Sanctions screening IS active but fails open during the deploy window.** `LibVaipakam.isSanctionedAddress` returns `false` for all addresses until `ProfileFacet.setSanctionsOracle(<oracle>)` is set — intentional, but worth flagging on the deploy runbook. **Two-tier gating is intentional:** Tier-1 entrypoints (create/accept offer, vault creation, VPFI ops, liquidation, preclose, refinance, claim) block sanctioned callers; **Tier-2 close-out paths (`repayLoan`, `markDefaulted`, time-based liquidation) stay open on purpose** so the unflagged counterparty can be made whole. Flagging Tier-2 as "missing sanctions check" is a false positive.
- **Intentional design choices that look like bugs but aren't:**
  - **Illiquid assets** (all NFTs + feed-less tokens) are valued at **$0** and trigger full in-kind collateral transfer on default with two-party consent — not a pricing bug.
  - The diamond **holds VPFI (`borrowerLifRebate[loanId].vpfiHeld`) in custody from `acceptOffer` until a terminal event** — a mid-loan "stuck" balance is expected; a non-zero balance on a _Settled_ loan is the actual bug to look for.
  - **Fixed maturity** — partial repay / liquidation / swap-to-repay must never move maturity or restart the grace clock; that's an invariant, verify it holds.
  - **Protocol-tracked balance ≠ raw token balance** by design (the `min(...)` clamp defends the fee-discount tier against unsolicited transfers).
- **Governance / authority model to verify:** Governance Safe + Timelock, a **PAUSER_ROLE / UNPAUSER_ROLE split** (PAUSER can pause but cannot unpause; UNPAUSER_ROLE is Timelock-held), Diamonds are **born paused** and unpause only after facet cuts, and the **deployer EOA must retain zero residual privileged roles after handover**. CCIP lane/pool/messenger config runs under its own documented owner, not the Diamond admin key by assumption.
- **Operator-responsibility config (documented gates, not code vulns):** `VpfiBuyAdapter` payment-token mode must be WETH-pull on non-ETH-gas chains (BNB / Polygon mainnet); CCIP per-lane rate limits + peer registry must be set before routing value (`VpfiPoolRateGovernor` refuses to disable a lane).
- **Existing in-house safety nets** a scanner can lean on but should still independently verify: a deploy-sanity suite (`contracts/test/deploy/`) enforcing EIP-170 facet-size limits + selector coverage/collision, a `predeploy-check.sh` gate, and an extensive invariant suite (`contracts/test/invariants/`) covering funds-conservation, vault solvency, VPFI supply cap, claim exclusivity, self-dealing prevention, and default timing. **Liquidation-invariant tests already assert callers can't influence the slippage floor** — please confirm the assertion matches the code.
- Third-party audit + public bug bounty are planned pre-mainnet; the goal for this scan is to drive open high-risk static-analysis findings to zero with written rationale for any dismissals.
