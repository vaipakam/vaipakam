## Thread — T-087 Sub 3 add-on #473: Productive treasury reserve Phase 0 (PR #<n>)

Sub 3 add-on. Per 2026-06-09 design discussion: idle treasury reserves earn 0% today. This card adds Phase 0 of the productive reserve.

**Aave V3 is the only operational venue in Phase 0.** The Lido venue enum value, setter (`setLidoStaking`), and address slot are reserved but `deployTreasuryYield` for a `LIDO_STETH`-configured token currently reverts `LidoVenueNotYetSupported` — the WETH-unwrap + native-ETH submit + Lido withdrawal-queue plumbing lands in Phase 1. The deployment is bounded by a per-deploy ceiling check (NOT a continuously-enforced floor).

### Architecture

**New library — `LibTreasuryYield`**

Phase 0 venue adapters:

- `deployTreasuryYield(token, amount)` — supplies to the configured venue. Enforces the per-token external-yield cap.
- `withdrawTreasuryYield(token, amount)` — pulls back from the venue.
- Aave V3: `supply(asset, amount, onBehalfOf, referralCode)` + `withdraw(asset, amount, to)`.
- Lido: `submit(referral) payable returns (uint256)`.

The library is storage-aware (tracks `s.treasuryDeployedExternal[token]`) and trust-aware (rejects deployments above the cap).

**TreasuryFacet additions**

- `setTreasuryYieldVenue(token, venue)` — venue is `NONE` (0), `AAVE_V3` (1), or `LIDO_STETH` (2).
- `setTreasuryExternalYieldMaxBps(uint16)` — counterparty-risk ceiling. Default 7000bps (70%); hard upper bound 8000bps (20% always retained in-diamond).
- `setAaveV3Pool(address)` + `setLidoStaking(address)` — venue addresses (EOA-rejecting via `code.length > 0`).
- `deployTreasuryYield(token, amount)` + `withdrawTreasuryYield(token, amount)` — ADMIN-gated wrappers.
- Public reads: `getTreasuryYieldVenue`, `getTreasuryDeployedExternal`, `getTreasuryExternalYieldMaxBps`, `getAaveV3Pool`, `getLidoStaking`.

### Counterparty-risk gate (deploy-time only)

`cfgTreasuryExternalYieldMaxBps` is a **deploy-time gate**, not an ongoing invariant. At the moment a `deployTreasuryYield` call lands, it ensures the cumulative externally-deployed amount doesn't exceed the configured BPS share of the total addressable treasury (`treasuryBalance + alreadyDeployed`). After deployment, other treasury debit paths (`claimTreasuryFees`, `convertTreasuryAsset`, payroll funding, buyback `creditBuybackBudget`) can still consume `treasuryBalances[token]` — the "30% liquid floor" is NOT a continuously-enforced invariant; it is the state guaranteed at the moment of deployment.

- Default 7000bps → at deploy-time, at most 70% of the total addressable treasury can be in external position.
- Hard upper bound 8000bps → governance can raise the ceiling to no more than 80% at deploy time. This does NOT imply a continuously-retained 20% in-diamond floor — see operator guidance below.
- Denominator is `treasuryBalance + alreadyDeployed` (the total addressable treasury for that token).

Operators monitoring the floor in production are advised to either (a) re-deploy only what fits the cap when the in-diamond balance drops below the desired floor, or (b) treat the cap as a per-deploy gate with the understanding that subsequent treasury debits may drop the in-diamond portion below 30%.

### Storage additions (append-only)

- `mapping(address => uint8) cfgTreasuryYieldVenue` — per-token venue enum.
- `mapping(address => uint256) treasuryDeployedExternal` — currently-deployed amount per token.
- `uint16 cfgTreasuryExternalYieldMaxBps` — ceiling.
- `address cfgAaveV3Pool` + `address cfgLidoStaking` — venue addresses.
- `uint256 aaveDeployedTokenCount` (round-2 P1 #1) — count of tokens with non-zero Aave principal; consulted by `setAaveV3Pool` to block rotation while live positions exist.
- Constants: `TREASURY_YIELD_VENUE_NONE / AAVE_V3 / LIDO_STETH`.

### Producer artifacts

- TreasuryFacet selectors 38 → 49 (11 new).
- ABI bundle regenerated.

### Test coverage

15 new tests in `TreasuryYieldTest.t.sol`:

- All config setter happy paths + access control rejection + EOA-rejection on Aave/Lido addresses.
- BPS-above-max rejection + default 7000bps fallback.
- Aave deploy + withdraw round-trip; ledger counter + diamond treasury balance both update.
- Revert paths: venue not configured, pool address not set, withdraw exceeds deployed, cap exceeded, cap enforced after partial deploy.

Mock Aave V3 Pool + Mock Lido staking simulate the venue side. Cap math is exercised against the diamond's `treasuryBalances` (probed via EIP-7201 namespaced slot).

### Out of scope (deferred)

- **Lido path entirely** (Codex round-1 P1): `deployTreasuryYield` for a `LIDO_STETH`-configured token reverts `LidoVenueNotYetSupported` in Phase 0. The native-ETH submit path needs a WETH-unwrap leg the diamond doesn't yet have; wiring it without that leg would silently debit `treasuryBalances[token]` while no ETH actually reaches Lido. Phase 1 wires the WETH→ETH unwrap + the Lido withdrawal queue interaction. The venue enum + setters remain reserved.
- **Yield harvest tracking** (Codex round-1 P2 #2 + round-2 P2 + round-3 P2): `treasuryDeployedExternal[token]` tracks principal only. As Aave interest accrues, the diamond's aToken balance grows above this counter. Phase 0 does NOT include a separate `harvestTreasuryInterest(token)` method, and `withdrawTreasuryYield` is hard-capped at the recorded principal — the surplus aTokens (the accrued interest) are unreachable through this facet. There is NO valid Phase-0 workaround: an admin EOA cannot use Aave's UI to burn the diamond's aTokens (the aTokens belong to `address(this)`, not the admin), so the only way to realise the interest before Phase 1 is to add a new diamond function that calls Aave's `withdraw(asset, type(uint256).max, address(this))` against the live aToken balance. Phase 1 ships that path.
- **Phase 1 — `VAIPAKAM_INTERNAL` venue**: shifts portion to Vaipakam itself after $50M+ TVL. Tracked separately.

### Verification

- TreasuryYieldTest 15/15.
- All prior Sub 3 suites still green (54 total).
- Deploy-sanity 12/12.
- Frontend tsc clean.
