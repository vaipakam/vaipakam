# Deployment Runbook

Step-by-step procedure for a fresh deployment of the Vaipakam Diamond on a target chain, including cross-chain reward plumbing.

Audience: release engineer + signing multisig.

---

## 0. Pre-flight (before broadcasting any tx)

| Check | Command / Source |
|---|---|
| `forge build` passes | `cd contracts && forge build` |
| `forge test` — 100% pass | `cd contracts && forge test` |
| Gas snapshot reviewed (`.gas-snapshot` diff) | `forge snapshot --diff` |
| `CLAUDE.md`, `remappings.txt` unchanged since audit | `git status` |
| Release commit tagged | `git tag -s vX.Y.Z && git push --tags` |
| `ADMIN_ADDRESS` env = timelock contract (**not** an EOA on mainnet) | see `AdminKeysAndPause.md` |
| `TREASURY_ADDRESS` env = multisig safe | review on Safe UI |
| `PRIVATE_KEY` deployer is a hot key, revoked post-deploy | see step 6 |
| Target chain RPC matches intended network id | `cast chain-id --rpc-url $RPC` |
| Chainlink feeds for every supported asset are live on target chain | `cast call <feed> "latestRoundData()"` |
| Uniswap v3 factory and USDT/USD denominator configured for the chain | see `OracleAdminFacet` setters |

If any check fails → **do not broadcast**.

---

## 1. Diamond deployment

`DeployDiamond.s.sol` uses simple CREATE — the Diamond address is nonce-dependent, so every chain produces a different address. Cross-chain address parity (if ever required) would need a Singleton-Factory CREATE2 variant, which is not shipped in Phase 1.

1. Set envs:
   ```bash
   export ADMIN_ADDRESS=0x...        # timelock for mainnet, EOA only for testnets
   export TREASURY_ADDRESS=0x...     # multisig
   export PRIVATE_KEY=0x...          # hot deployer key (DEPLOYER_ADDRESS)
   export RPC_URL=https://...
   ```
   Phase-1 2-EOA topology: the deployer EOA owns the Diamond during the cut, then the script hands over ERC-173 ownership + all 7 access-control roles to `ADMIN_ADDRESS` and renounces the deployer's roles. Verify post-deploy that the deployer holds zero roles.
2. Dry-run:
   ```bash
   forge script script/DeployDiamond.s.sol:DeployDiamond \
     --rpc-url $RPC_URL --sender $(cast wallet address $PRIVATE_KEY)
   ```
3. Broadcast:
   ```bash
   forge script script/DeployDiamond.s.sol:DeployDiamond \
     --rpc-url $RPC_URL --broadcast --verify
   ```
4. Record the logged addresses in `deployments/<chain>/addresses.json` and populate `<CHAIN>_DIAMOND_ADDRESS` in `contracts/.env` plus `VITE_<CHAIN>_DIAMOND_ADDRESS` / `VITE_<CHAIN>_DEPLOY_BLOCK` in `frontend/.env.local`.

**Post-step verification:**
- `diamondLoupe.facetAddresses()` returns 30 non-zero facets (DiamondCutFacet + 29 cut in).
- `OwnershipFacet.owner()` == `ADMIN_ADDRESS` (handover complete).
- `AccessControlFacet.hasRole(DEFAULT_ADMIN_ROLE, ADMIN_ADDRESS)` == `true` and the deployer holds zero roles.
- `AdminFacet.getTreasury()` == `TREASURY_ADDRESS`.
- `EscrowFactoryFacet.getVaipakamEscrowImplementationAddress()` != `0x0`.
- `RewardReporterFacet.getRewardReporterConfig()` returns zeros for `rewardOApp`/`localEid`/`baseEid` — wiring happens in §3.

---

## 2. Oracle / asset wiring

Automated: `script/ConfigureOracle.s.sol` writes the per-chain oracle config from env vars. For manual / multisig control, the underlying setters are:

On `OracleAdminFacet`:

1. `setChainlinkRegistry(<feed registry>)` — mainnet only; on testnets `ConfigureOracle` skips the registry and goes straight to per-symbol feeds
2. `setUsdChainlinkDenominator(<USD denominator>)`
3. `setEthChainlinkDenominator(<ETH denominator>)`
4. `setWethContract(<WETH on this chain>)`
5. `setEthUsdFeed(<ETH/USD feed>)`
6. `setStableTokenFeed("USDC" | "USDT" | ..., <feed>)` — once per stable symbol
7. `setSequencerUptimeFeed(<feed>)` — L2s only (Base / Arbitrum / Optimism / Polygon)
8. `setUniswapV3Factory(<v3 factory>)`

On `AdminFacet`:

9. `setZeroExProxy(<0x ExchangeProxy>)`
10. `setallowanceTarget(<0x allowance-target>)`

**Do not skip 9/10** on any chain where liquidation is enabled — a missing 0x proxy makes HF-based liquidations fail.

---

## 3. Reward plumbing (cross-chain)

`RewardReporterFacet` and `RewardAggregatorFacet` are cut in by `DeployDiamond.s.sol` alongside the other 27 facets. The script stops short of wiring the cross-chain config — every field below must be set per chain before the mesh is live.

### 3a. RewardOApp proxy deployment

The RewardOApp proxy must live at the **same address on every chain** so LayerZero peer wiring works with a single bytes32 peer value. Because the real impl's ctor takes the chain-specific LZ endpoint, we use a **bootstrap-proxy pattern**: deploy a chain-agnostic bootstrap impl via CREATE2, deploy an `ERC1967Proxy(bootstrap, "")` via CREATE2, then atomically `upgradeToAndCall` to the real chain-specific impl inside the same broadcast.

Per chain:

```bash
export PRIVATE_KEY=0x...
export REWARD_VERSION=v1            # must match across every chain
export REWARD_OWNER=0x...           # ideally same address on every chain
export DIAMOND_ADDRESS=0x...        # local Vaipakam Diamond (§1)
export IS_CANONICAL_REWARD=true     # "true" on Base, "false" elsewhere
export BASE_EID=0                   # 0 on Base; Base's EID on mirrors
export LZ_ENDPOINT=0x...            # chain-local LZ V2 endpoint
export REPORT_OPTIONS_HEX=0x        # safe to leave empty at init
export BROADCAST_OPTIONS_HEX=0x     # safe to leave empty at init

forge script script/DeployRewardOAppCreate2.s.sol:DeployRewardOAppCreate2 \
  --rpc-url $RPC_URL --broadcast --verify
```

The script prints `RewardOAppProxy (CROSS-CHAIN IDENTICAL)` — the value MUST match byte-for-byte on every chain or `REWARD_VERSION` drifted. The bootstrap impl address also matches everywhere.

> ⚠️ **Never split the bootstrap → upgrade sequence across broadcasts.** The bootstrap's `_authorizeUpgrade` is permissionless — if a proxy is left pointing at the bootstrap impl, any caller can upgrade it to their own code. The script's `upgradeToAndCall` in the same `vm.broadcast` block closes this window atomically.

### 3b. Reward config wiring

On **every** chain:

1. `RewardReporterFacet.setLocalEid(<LZ eid of this chain>)`
2. `RewardReporterFacet.setBaseEid(<LZ eid of Base>)`
3. `RewardReporterFacet.setRewardOApp(<RewardOApp proxy from §3a>)`
4. `RewardReporterFacet.setRewardGraceSeconds(14400)` — 4h default

On **Base only** (the canonical reward chain):

5. `RewardReporterFacet.setIsCanonicalRewardChain(true)`
6. `RewardAggregatorFacet.setExpectedSourceEids([eidA, eidB, ...])` — every reporter chain's eid

On **all other chains** (reporters):

5'. `RewardReporterFacet.setIsCanonicalRewardChain(false)` — explicit, do not rely on default

Then, once per chain:

7. `InteractionRewardsFacet.setInteractionLaunchTimestamp(<unix ts of launch day 00:00 UTC>)`

**Post-step verification:**
- On Base: `getRewardReporterConfig()` returns `isCanonical == true`, `localEid == baseEid`, expected-source-eids list matches intent.
- On every reporter: `getRewardReporterConfig()` returns `isCanonical == false`, `rewardOApp != 0x0`, `baseEid != 0`.
- `getInteractionLaunchTimestamp()` is non-zero on every chain and identical across chains.

---

## 4. VPFI token wiring

1. Canonical chain only: `DeployVPFICanonical.s.sol`
2. All other chains: `DeployVPFIMirror.s.sol`
3. `WireVPFIPeers.s.sol` on every chain (idempotent — can be re-run)
4. Verify `VPFITokenFacet.isCanonicalVPFIChain()` returns the correct boolean on each chain.

---

## 5. Smoke tests (required before announcing)

Run the `Sepolia*` family on the target testnet first, then execute on mainnet forks:

```bash
forge script script/SepoliaPositiveFlows.s.sol --rpc-url $RPC_URL --broadcast
forge script script/SepoliaActiveLoan.s.sol   --rpc-url $RPC_URL --broadcast
```

Manual checks post-smoke:
- At least one `ChainInterestReported` event on Base from the smoke-run chain.
- `RewardAggregatorFacet.isDayReadyToFinalize(day)` progresses through states 2 → 3 → 1 across the grace window.
- One user claim succeeds after `finalizeDay` + `broadcastGlobal` + `onRewardBroadcastReceived`.

---

## 6. Key rotation (within 24h of deploy)

1. From timelock: `AccessControlFacet.grantRole(DEFAULT_ADMIN_ROLE, <production multisig>)`
2. `AccessControlFacet.grantRole(ADMIN_ROLE, <timelock>)`
3. `AccessControlFacet.grantRole(PAUSER_ROLE, <pauser multisig — separate from admin multisig>)`
4. From the deployer hot key: `AccessControlFacet.renounceRole(DEFAULT_ADMIN_ROLE, <deployer>)` then every other role the deployer was granted in `initializeAccessControl`.
5. Verify via `hasRole` that the deployer holds **no roles** on the Diamond.

See `AdminKeysAndPause.md` for the full role map and the Timelock + Multisig topology.

---

## 7. Publish

- Tag `vX.Y.Z-deployed-<chain>` on the commit actually deployed.
- Commit `deployments/<chain>/addresses.json`.
- Post the diamond address + facet addresses to the public status page.
- File an entry in `docs/ops/IncidentRunbook.md#deployment-log`.
