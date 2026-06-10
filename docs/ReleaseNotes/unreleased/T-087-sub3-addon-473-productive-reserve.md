## Thread — T-087 Sub 3 add-on #473: Productive treasury reserve Phase 0 (PR #<n>)

Sub 3 add-on. Per 2026-06-09 design discussion: idle treasury reserves earn 0% today. This card adds Phase 0 of the productive reserve — external yield via Aave V3 (ERC20 supply) and Lido (ETH staking) — bounded by a counterparty-risk floor.

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

### Counterparty-risk floor

`cfgTreasuryExternalYieldMaxBps` bounds how much of a token's treasury can be deployed externally:

- Default 7000bps → max 70% externally deployed; min 30% liquid in the diamond.
- Hard upper bound 8000bps → governance can raise the ceiling but never above 80%.
- Denominator is `treasuryBalance + alreadyDeployed` (the total addressable treasury for that token). Cap holds across multiple deployment calls — after a partial deploy, the next call's allowable amount accounts for what's already external.

### Storage additions (append-only)

- `mapping(address => uint8) cfgTreasuryYieldVenue` — per-token venue enum.
- `mapping(address => uint256) treasuryDeployedExternal` — currently-deployed amount per token.
- `uint16 cfgTreasuryExternalYieldMaxBps` — ceiling.
- `address cfgAaveV3Pool` + `address cfgLidoStaking` — venue addresses.
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
- **Yield harvest tracking** (Codex round-1 P2 #2): `treasuryDeployedExternal[token]` tracks principal only. As Aave interest accrues, the diamond's aToken balance grows above this counter. Phase 0 does NOT include a separate `harvestTreasuryInterest(token)` method that pulls only the interest delta — the admin can withdraw up to the recorded principal, and accrued interest stays at the venue until Phase 1 adds the harvest path. Operator can full-withdraw + re-deploy to realise interest in the meantime.
- **Phase 1 — `VAIPAKAM_INTERNAL` venue**: shifts portion to Vaipakam itself after $50M+ TVL. Tracked separately.

### Verification

- TreasuryYieldTest 15/15.
- All prior Sub 3 suites still green (54 total).
- Deploy-sanity 12/12.
- Frontend tsc clean.
