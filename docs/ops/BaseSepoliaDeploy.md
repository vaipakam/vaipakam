# Base Sepolia — Fresh Deployment Runbook

End-to-end order of operations for a clean Base Sepolia deployment. Canonical VPFI + reward chain is Base Sepolia (chainId `84532`, LZ eid `40245`).

Scope: a Base Sepolia fresh deployment wipes the old `BASE_SEPOLIA_DIAMOND_ADDRESS` and everything downstream (VPFI token, OFT adapter, mirrors, reward OApp, buy receiver/adapter). Mirror-chain deployments (Sepolia / Arb Sepolia / OP Sepolia / Polygon Amoy) assume their own fresh `<CHAIN>_DIAMOND_ADDRESS`.

All commands run from `contracts/`.

> **Admin handover ordering.** Steps 1–11 run from the `PRIVATE_KEY` EOA because it needs `ADMIN_ROLE` / `ORACLE_ADMIN_ROLE` / `ESCROW_ADMIN_ROLE` to land every `Configure*.s.sol`. Step 11.5 (*Hand over admin to timelock*) is **one-way** — after it runs, every `Configure*` invocation must be scheduled through the `TimelockController` (48h delay). Always land the full config sweep and run smoke tests under the EOA first; hand over last.

> **Address propagation.** As of the Track-B refactor, every `Deploy*.s.sol`
> writes its outputs to `deployments/base-sepolia/addresses.json` and every
> downstream `Configure*` / `Wire*` / `Upgrade*` / seeder script reads from
> the same file via the `Deployments.sol` helper. **Operators no longer
> need to manually export `BASE_SEPOLIA_DIAMOND_ADDRESS` (or any other
> deployment address) between steps.** The file is the source of truth.
> Commit it after the deploy is green (Step 12). Legacy chain-prefixed env
> vars still work as a fallback for one-off ops calls; the file wins when
> both are present.

---

## 0. Pre-flight

```bash
cp .env.example .env
# Fill in: PRIVATE_KEY, ADMIN_ADDRESS, TREASURY_ADDRESS, LENDER_ADDRESS,
# BORROWER_ADDRESS, all RPC URLs, ETHERSCAN_API_KEY, VPFI_OWNER,
# VPFI_TREASURY, VPFI_INITIAL_MINTER.
```

Sanity checks:

```bash
forge build
forge test -q
cast balance $ADMIN_ADDRESS --rpc-url $BASE_SEPOLIA_RPC_URL
# Admin needs ~0.2 ETH for the full deploy + config sweep.
```

---

## 1. Deploy Diamond

```bash
forge script script/DeployDiamond.s.sol \
  --rpc-url $BASE_SEPOLIA_RPC_URL \
  --broadcast --verify \
  --etherscan-api-key $ETHERSCAN_API_KEY
```

The script auto-writes the Diamond address (and a `chainId` /
`deployedAt` header) to `deployments/base-sepolia/addresses.json` —
**no manual env-var export is needed for downstream steps.** The
deploy produces 31 facets cut into the Diamond (LegalFacet now
included; OracleAdminFacet has the full Phase 7b secondary-quorum
selector set). Post-check:

```bash
DIAMOND=$(jq -r .diamond deployments/base-sepolia/addresses.json)
cast call $DIAMOND "paused()(bool)" --rpc-url $BASE_SEPOLIA_RPC_URL          # → false
cast call $DIAMOND "getTreasury()(address)" --rpc-url $BASE_SEPOLIA_RPC_URL  # → $TREASURY_ADDRESS
```

---

## 2. Configure Oracle + DEX adapters (per chain)

### 2a. Deploy + register the swap-adapter chain (Phase 7a)

Phase 7a's swap failover replaces the legacy single-0x liquidation
path with a registered chain of `ISwapAdapter` contracts. Production
deploys four adapters per chain in priority order: ZeroEx → OneInch
→ UniV3 → BalancerV2.

For testnet, Base Sepolia has no real 0x / 1inch deployment, so we
register a `MockZeroExLegacyAdapter` that wraps the existing
`ZeroExProxyMock` for back-compat with pre-Phase-7a tests:

```bash
forge script script/DeployZeroExMock.s.sol \
  --rpc-url $BASE_SEPOLIA_RPC_URL --broadcast
```

Record the logged `Mock proxy:` address. Then register the legacy-
shim adapter on the diamond:

```bash
# (Replace MOCK_ADAPTER with the deployed shim address.)
cast send $BASE_SEPOLIA_DIAMOND_ADDRESS \
  "addSwapAdapter(address)" $MOCK_ADAPTER \
  --rpc-url $BASE_SEPOLIA_RPC_URL --private-key $DEPLOYER_PK
```

For mainnet, deploy each of the four production adapters
(`ZeroExAggregatorAdapter` / `OneInchAggregatorAdapter` /
`UniV3Adapter` / `BalancerV2Adapter`) with the chain-correct router
addresses, then `addSwapAdapter` each in order. **A diamond with
zero adapters reverts every liquidation — this step blocks any
`triggerLiquidation` / `triggerDefault` action.**

### 2b. Configure oracle (primary + secondary quorum)

Populate in `.env`:
- `BASE_SEPOLIA_WETH_ADDRESS` · `BASE_SEPOLIA_UNISWAP_V3_FACTORY`
- `BASE_SEPOLIA_PANCAKESWAP_V3_FACTORY` · `BASE_SEPOLIA_SUSHISWAP_V3_FACTORY` (Phase 7b.1; leave blank where the chain has no deployment)
- `BASE_SEPOLIA_ETH_USD_FEED` · `BASE_SEPOLIA_USD_DENOMINATOR` · `BASE_SEPOLIA_ETH_DENOMINATOR`
- `BASE_SEPOLIA_SEQUENCER_UPTIME_FEED`
- `BASE_SEPOLIA_TELLOR_ORACLE` · `BASE_SEPOLIA_API3_SERVER_V1` · `BASE_SEPOLIA_DIA_ORACLE_V2` (Phase 7b.2; leave blank where the chain has no deployment)
- (optional) `VPFI_STABLE_FEED_SYMBOLS=USDC` and `BASE_SEPOLIA_USDC_FEED`

```bash
forge script script/ConfigureOracle.s.sol \
  --rpc-url $BASE_SEPOLIA_RPC_URL --broadcast
```

The Phase 7b setters wired by `ConfigureOracle.s.sol`:
- `setUniswapV3Factory`, `setPancakeswapV3Factory`,
  `setSushiswapV3Factory` — 3-V3-clone OR-logic for liquidity
  classification.
- `setTellorOracle`, `setApi3ServerV1`, `setDIAOracleV2` — Soft
  2-of-N quorum cross-validation against Chainlink primary.
- `setSecondaryOracleMaxDeviationBps(500)` and
  `setSecondaryOracleMaxStaleness(3600)` — chain-level deviation +
  staleness ceilings; tighten if desired.

Verify with a spot quote:
```bash
cast call $BASE_SEPOLIA_DIAMOND_ADDRESS \
  "getAssetPrice(address)(uint256)" $BASE_SEPOLIA_WETH_ADDRESS \
  --rpc-url $BASE_SEPOLIA_RPC_URL
# ≈ current ETH/USD · 1e18
```

Verify Phase 7b admin readback:
```bash
cast call $BASE_SEPOLIA_DIAMOND_ADDRESS "getPancakeswapV3Factory()(address)" --rpc-url $BASE_SEPOLIA_RPC_URL
cast call $BASE_SEPOLIA_DIAMOND_ADDRESS "getSushiswapV3Factory()(address)" --rpc-url $BASE_SEPOLIA_RPC_URL
cast call $BASE_SEPOLIA_DIAMOND_ADDRESS "getTellorOracle()(address)" --rpc-url $BASE_SEPOLIA_RPC_URL
cast call $BASE_SEPOLIA_DIAMOND_ADDRESS "getApi3ServerV1()(address)" --rpc-url $BASE_SEPOLIA_RPC_URL
cast call $BASE_SEPOLIA_DIAMOND_ADDRESS "getDIAOracleV2()(address)" --rpc-url $BASE_SEPOLIA_RPC_URL
cast call $BASE_SEPOLIA_DIAMOND_ADDRESS "getSwapAdapters()(address[])" --rpc-url $BASE_SEPOLIA_RPC_URL
```

---

## 2.5. Base Sepolia testnet liquidity mocks (testnet-only)

Base Sepolia has only nine real Chainlink feeds (ETH/USD, BTC/USD,
USDC/USD, USDT/USD, DAI/USD, LINK/USD, LINK/ETH, CBETH/ETH, CBETH/USD)
and no Chainlink Feed Registry, so a fresh deploy can't classify
arbitrary ERC-20s as **liquid** out of the box. For end-to-end testing
without depending on real Base Sepolia DEX liquidity, deploy the
mock infrastructure that surfaces TWO fully-liquid mock ERC-20s
(`mUSDC` / `mWBTC`) along with a mock Feed Registry, mock per-asset
feeds, and a mock UniswapV3 factory whose pool depth clears the
$1M `MIN_LIQUIDITY_USD` floor:

```bash
forge script script/DeployTestnetLiquidityMocks.s.sol \
  --rpc-url $BASE_SEPOLIA_RPC_URL --broadcast
```

The script:
- Deploys `mUSDC` (6 dec, $1.00) + `mWBTC` (8 dec, $60,000) ERC-20s
  with 100M / 1k initial supply on the deployer.
- Deploys `MockChainlinkRegistry` + per-asset feeds (`mUSDC/USD`,
  `mWBTC/USD`, `WETH/USD` at $2,000) registered under the canonical
  Chainlink Denomination sentinels.
- Deploys `MockUniswapV3Factory` + pools `mUSDC/WETH` and
  `mWBTC/WETH` at fee=3000, `liquidity()=1e24` (well above the $1M
  floor under any sane ETH/USD price).
- Wires every address into the Diamond via `OracleAdminFacet`
  setters (`setChainlinkRegistry`, `setEthUsdFeed`,
  `setUniswapV3Factory`, `setWethContract`) plus
  `RiskFacet.updateRiskParams` for both mocks.
- Writes `.mockChainlinkAggregator`, `.mockUniswapV3Factory`,
  `.mockERC20A`, `.mockERC20B`, `.mockUSDCFeed`, `.mockWBTCFeed`,
  `.mockWETHFeed` keys to `addresses.json`.

Verify both mocks classify Liquid:

```bash
DIAMOND=$(jq -r .diamond deployments/base-sepolia/addresses.json)
MUSDC=$(jq -r .mockERC20A deployments/base-sepolia/addresses.json)
MWBTC=$(jq -r .mockERC20B deployments/base-sepolia/addresses.json)

cast call $DIAMOND "checkLiquidity(address)(uint8)" $MUSDC --rpc-url $BASE_SEPOLIA_RPC_URL  # → 0 (Liquid)
cast call $DIAMOND "checkLiquidity(address)(uint8)" $MWBTC --rpc-url $BASE_SEPOLIA_RPC_URL  # → 0 (Liquid)
```

**Skip this step on mainnet deploys** — production wires real
Chainlink + real UniswapV3 (factory `0x33128a8fC17869897dcE68Ed026d694621f6FDfD`),
not mocks. Real-DEX deploys jump straight from §2 to §3.

---

## 3. Deploy canonical VPFI stack (Base only)

```bash
forge script script/DeployVPFICanonical.s.sol \
  --rpc-url $BASE_SEPOLIA_RPC_URL --broadcast --verify
```

Record the logged addresses into `.env`:
- `BASE_SEPOLIA_VPFI_TOKEN_IMPL` · `BASE_SEPOLIA_VPFI_TOKEN`
- `BASE_SEPOLIA_VPFI_OFT_ADAPTER_IMPL` · `BASE_SEPOLIA_VPFI_OFT_ADAPTER`

Owner-only follow-ups (run from `VPFI_OWNER` wallet):
```bash
# 1) Authorise the Diamond as VPFI minter:
cast send $BASE_SEPOLIA_VPFI_TOKEN "setMinter(address)" $BASE_SEPOLIA_DIAMOND_ADDRESS \
  --rpc-url $BASE_SEPOLIA_RPC_URL --private-key $VPFI_OWNER_PK
```

---

## 4. Configure VPFI buy (Base only)

Populate `.env`: `VPFI_BUY_WEI_PER_VPFI=1000000000000000`, `VPFI_BUY_GLOBAL_CAP=2300000000000000000000000`, `VPFI_BUY_PER_WALLET_CAP=30000000000000000000000`, `VPFI_BUY_ENABLED=true`, `BASE_SEPOLIA_VPFI_DISCOUNT_ETH_PRICE_ASSET` (= WETH).

The fixed-rate buy path follows `docs/TokenomicsTechSpec.md` §8 / §8a:
buyers pay ETH, VPFI is delivered to the buyer's wallet, and any
wallet-to-escrow deposit is a separate explicit action. Do not run the
buy smoke test until §7 has configured `LOCAL_EID=40245`; direct buys
bucket the per-wallet cap under the Diamond's `localEid`.

```bash
forge script script/ConfigureVPFIBuy.s.sol \
  --rpc-url $BASE_SEPOLIA_RPC_URL --broadcast
```

Verify:
```bash
cast call $BASE_SEPOLIA_DIAMOND_ADDRESS "getVPFIBuyConfig()(uint256,uint256,uint256,bool)" \
  --rpc-url $BASE_SEPOLIA_RPC_URL
# → (1e15, 2_300_000e18, 30_000e18, true)
```

---

## 5. Deploy VPFIBuyReceiver (Base only)

```bash
forge script script/DeployVPFIBuyReceiver.s.sol \
  --rpc-url $BASE_SEPOLIA_RPC_URL --broadcast --verify
```

Record: `BASE_SEPOLIA_VPFI_BUY_RECEIVER_IMPL`, `BASE_SEPOLIA_VPFI_BUY_RECEIVER`.

Pre-fund the receiver with ETH (it pays LZ fees for responses + the return OFT send):
```bash
cast send $BASE_SEPOLIA_VPFI_BUY_RECEIVER "fundETH()" \
  --value 0.1ether \
  --rpc-url $BASE_SEPOLIA_RPC_URL --private-key $PRIVATE_KEY
```

If LZ options were unset at deploy, set them now from the owner wallet:
```bash
# Build the options hex off-chain (LZ V2 — see LayerZero docs).
cast send $BASE_SEPOLIA_VPFI_BUY_RECEIVER \
  "setResponseOptions(bytes)" <options-hex> \
  --rpc-url $BASE_SEPOLIA_RPC_URL --private-key $VPFI_OWNER_PK
cast send $BASE_SEPOLIA_VPFI_BUY_RECEIVER \
  "setOFTSendOptions(bytes)" <options-hex> \
  --rpc-url $BASE_SEPOLIA_RPC_URL --private-key $VPFI_OWNER_PK
```

---

## 6. Deploy RewardOApp (CREATE2, per chain)

Run this on EVERY chain including Base Sepolia. The proxy address must match across chains.

```bash
# Base Sepolia (canonical):
IS_CANONICAL_REWARD=true BASE_EID=0 \
LZ_ENDPOINT=$LZ_ENDPOINT_BASE_SEPOLIA \
DIAMOND_ADDRESS=$BASE_SEPOLIA_DIAMOND_ADDRESS \
  forge script script/DeployRewardOAppCreate2.s.sol \
    --rpc-url $BASE_SEPOLIA_RPC_URL --broadcast
```

Write the logged `RewardOAppProxy` to `.env` as `REWARD_OAPP_PROXY`. Confirm byte-identical when you later run on mirrors.

---

## 7. Configure reward reporter (per chain)

Populate `.env`: `LOCAL_EID=40245`, `BASE_EID=40245`, `REWARD_GRACE_SECONDS=14400`, `REWARD_EXPECTED_SOURCE_EIDS=40161,40231,40232,40267` (mirrors you will deploy).

```bash
forge script script/ConfigureRewardReporter.s.sol \
  --rpc-url $BASE_SEPOLIA_RPC_URL --broadcast
```

Verify `localEid` before any direct Base buy:
```bash
cast call $BASE_SEPOLIA_DIAMOND_ADDRESS \
  "getRewardReporterConfig()(address,uint32,uint32,uint32,bool)" \
  --rpc-url $BASE_SEPOLIA_RPC_URL
# localEid must be 40245 on Base Sepolia
```

Verify:
```bash
cast call $BASE_SEPOLIA_DIAMOND_ADDRESS "getRewardReporterConfig()" \
  --rpc-url $BASE_SEPOLIA_RPC_URL
```

---

## 8. Anchor interaction-rewards day 0

Pick ONE timestamp for the whole mesh — e.g. `date +%s` at a known wall-clock moment. Every chain must use the same value.

```bash
INTERACTION_LAUNCH_TIMESTAMP=1745049600 \
  forge script script/SetInteractionLaunch.s.sol \
    --rpc-url $BASE_SEPOLIA_RPC_URL --broadcast
```

---

## 9. Mirror chains (Sepolia / Arb Sepolia / OP Sepolia / Polygon Amoy)

For each mirror chain, repeat in order:
1. `DeployDiamond.s.sol`
2. `ConfigureOracle.s.sol` (chain-specific feeds + sequencer where applicable)
3. `DeployVPFIMirror.s.sol` — mirror VPFI + OFTAdapter, records `<CHAIN>_VPFI_MIRROR_IMPL` / `<CHAIN>_VPFI_MIRROR`
4. `DeployVPFIBuyAdapter.s.sol` — non-Base buy adapter
5. `DeployRewardOAppCreate2.s.sol` with `IS_CANONICAL_REWARD=false`, `BASE_EID=40245`, `LZ_ENDPOINT=$LZ_ENDPOINT_<CHAIN>`. **Confirm the logged proxy address matches Base.**
6. `ConfigureRewardReporter.s.sol`
7. `SetInteractionLaunch.s.sol` (same `INTERACTION_LAUNCH_TIMESTAMP` as Base)

---

## 10. Wire LZ peers (OApp peer-pairing)

Wiring is symmetric — every pair needs both directions. Use `WireVPFIPeers.s.sol` for all three meshes.

### 10.1 VPFI OFT mesh (Base ↔ each mirror)

Base Sepolia → mirror (run N times, once per mirror):
```bash
LOCAL_OAPP=$BASE_SEPOLIA_VPFI_OFT_ADAPTER \
REMOTE_EID=<mirror eid> REMOTE_PEER=<mirror VPFI_MIRROR> \
  forge script script/WireVPFIPeers.s.sol \
    --rpc-url $BASE_SEPOLIA_RPC_URL --broadcast
```

Reverse (from each mirror):
```bash
LOCAL_OAPP=<mirror VPFI_MIRROR> \
REMOTE_EID=40245 REMOTE_PEER=$BASE_SEPOLIA_VPFI_OFT_ADAPTER \
  forge script script/WireVPFIPeers.s.sol \
    --rpc-url <mirror RPC> --broadcast
```

### 10.2 VPFI fixed-rate buy mesh (Base receiver ↔ each mirror adapter)

Base → mirror:
```bash
LOCAL_OAPP=$BASE_SEPOLIA_VPFI_BUY_RECEIVER \
REMOTE_EID=<mirror eid> REMOTE_PEER=<mirror VPFI_BUY_ADAPTER> \
  forge script script/WireVPFIPeers.s.sol \
    --rpc-url $BASE_SEPOLIA_RPC_URL --broadcast
```

Reverse:
```bash
LOCAL_OAPP=<mirror VPFI_BUY_ADAPTER> \
REMOTE_EID=40245 REMOTE_PEER=$BASE_SEPOLIA_VPFI_BUY_RECEIVER \
  forge script script/WireVPFIPeers.s.sol \
    --rpc-url <mirror RPC> --broadcast
```

### 10.3 RewardOApp mesh

Same pattern — `LOCAL_OAPP=$REWARD_OAPP_PROXY` on each side with the counterpart's address. Since the proxy is deterministic, `LOCAL_OAPP` and `REMOTE_PEER` are often the same value on both sides.

---

## 11. Smoke tests

Base Sepolia:
```bash
# Buy 100 VPFI as admin:
cast send $BASE_SEPOLIA_DIAMOND_ADDRESS \
  "buyVPFIWithETH()" \
  --value 0.1ether \
  --rpc-url $BASE_SEPOLIA_RPC_URL --private-key $PRIVATE_KEY

cast call $BASE_SEPOLIA_DIAMOND_ADDRESS \
  "getVPFIBalanceOf(address)(uint256)" $ADMIN_ADDRESS \
  --rpc-url $BASE_SEPOLIA_RPC_URL

cast call $BASE_SEPOLIA_DIAMOND_ADDRESS \
  "getVPFISoldToByEid(address,uint32)(uint256)" $ADMIN_ADDRESS 40245 \
  --rpc-url $BASE_SEPOLIA_RPC_URL
# → 100e18; confirms the direct buy landed in the Base Sepolia cap bucket
```

Mirror (e.g. Sepolia) — bridged buy:
```bash
cast send $SEPOLIA_VPFI_BUY_ADAPTER "buy(uint256,uint256,bytes)" \
  100000000000000000 1e18 0x \
  --value 0.11ether \
  --rpc-url $SEPOLIA_RPC_URL --private-key $PRIVATE_KEY
# Watch LayerZero Scan for the BUY_REQUEST → BUY_SUCCESS round trip.
```

Reward daily close (Base):
```bash
cast send $BASE_SEPOLIA_DIAMOND_ADDRESS "closeDay()" \
  --rpc-url $BASE_SEPOLIA_RPC_URL --private-key $PRIVATE_KEY
```

---

## 11.5. Hand over admin to timelock (one-way)

Only run after smoke tests (§11) pass. After this step, every admin setter — `OracleAdminFacet.*`, `AdminFacet.setTreasury`, `EscrowAdminFacet.*`, role grants, `OwnershipFacet.transferOwnership` — must be scheduled through the `TimelockController` with a minimum 48h delay.

Populate `.env`: `TIMELOCK_PROPOSER` (ops multi-sig address), `TIMELOCK_EXECUTOR=0x0000000000000000000000000000000000000000` (open execution after delay), `TIMELOCK_MIN_DELAY=172800` (48h).

**Deploy the timelock:**
```bash
forge script script/DeployTimelock.s.sol \
  --rpc-url $BASE_SEPOLIA_RPC_URL --broadcast --verify
```

Record the logged address → `.env` as `BASE_SEPOLIA_TIMELOCK_ADDRESS`.

**Hand over roles + ERC-173 ownership** (renounces EOA roles last; deployer keeps retry capability if any grant reverts):
```bash
CONFIRM_HANDOVER=YES \
  forge script script/TransferAdminToTimelock.s.sol \
    --rpc-url $BASE_SEPOLIA_RPC_URL --broadcast
```

Post-check — every privileged role should be held by the timelock, not the deployer:
```bash
cast call $BASE_SEPOLIA_DIAMOND_ADDRESS \
  "hasRole(bytes32,address)(bool)" \
  $(cast keccak "ADMIN_ROLE") $BASE_SEPOLIA_TIMELOCK_ADDRESS \
  --rpc-url $BASE_SEPOLIA_RPC_URL  # → true

cast call $BASE_SEPOLIA_DIAMOND_ADDRESS \
  "hasRole(bytes32,address)(bool)" \
  $(cast keccak "ADMIN_ROLE") $ADMIN_ADDRESS \
  --rpc-url $BASE_SEPOLIA_RPC_URL  # → false

cast call $BASE_SEPOLIA_DIAMOND_ADDRESS "owner()(address)" \
  --rpc-url $BASE_SEPOLIA_RPC_URL  # → $BASE_SEPOLIA_TIMELOCK_ADDRESS
```

`PAUSER_ROLE` and `KYC_ADMIN_ROLE` are **not** transferred to the timelock — both stay on the ops multi-sig for same-hour response (pause/unpause, per-asset reserve pause, KYC tier bumps). See `SECURITY.md` and `AdminKeysAndPause.md` for the full rationale. The handover script does *not* touch either role: grant them to the ops multi-sig *before* running the handover, then manually renounce from the deployer EOA afterward:
```bash
# Pre-handover: grant the two hot-key roles to the ops multi-sig.
cast send $BASE_SEPOLIA_DIAMOND_ADDRESS \
  "grantRole(bytes32,address)" \
  $(cast keccak "PAUSER_ROLE") $OPS_MULTISIG \
  --rpc-url $BASE_SEPOLIA_RPC_URL --private-key $PRIVATE_KEY
cast send $BASE_SEPOLIA_DIAMOND_ADDRESS \
  "grantRole(bytes32,address)" \
  $(cast keccak "KYC_ADMIN_ROLE") $OPS_MULTISIG \
  --rpc-url $BASE_SEPOLIA_RPC_URL --private-key $PRIVATE_KEY

# Post-handover: renounce both from the deployer EOA.
cast send $BASE_SEPOLIA_DIAMOND_ADDRESS \
  "renounceRole(bytes32,address)" \
  $(cast keccak "PAUSER_ROLE") $ADMIN_ADDRESS \
  --rpc-url $BASE_SEPOLIA_RPC_URL --private-key $PRIVATE_KEY
cast send $BASE_SEPOLIA_DIAMOND_ADDRESS \
  "renounceRole(bytes32,address)" \
  $(cast keccak "KYC_ADMIN_ROLE") $ADMIN_ADDRESS \
  --rpc-url $BASE_SEPOLIA_RPC_URL --private-key $PRIVATE_KEY
```

### Post-handover: scheduling a config change

To run any `Configure*.s.sol` after handover, wrap the setter call in a `timelock.schedule` → wait 48h → `timelock.execute` sequence. Example for rotating the ETH/USD feed:
```bash
# 1) Encode the setter call:
DATA=$(cast calldata "setEthUsdFeed(address)" $NEW_FEED)

# 2) Schedule from the proposer multi-sig (via Safe):
cast send $BASE_SEPOLIA_TIMELOCK_ADDRESS \
  "schedule(address,uint256,bytes,bytes32,bytes32,uint256)" \
  $BASE_SEPOLIA_DIAMOND_ADDRESS 0 $DATA 0x00 0x00 172800

# 3) After 48h, execute (open executor — anyone can land it):
cast send $BASE_SEPOLIA_TIMELOCK_ADDRESS \
  "execute(address,uint256,bytes,bytes32,bytes32)" \
  $BASE_SEPOLIA_DIAMOND_ADDRESS 0 $DATA 0x00 0x00
```

Emergency admin actions that **cannot wait 48h** — `AdminFacet.pause` / `unpause`, `AdminFacet.pauseAsset` / `unpauseAsset` (per-asset reserve pause / blacklist), and KYC tier bumps — stay on their respective hot-key roles (`PAUSER_ROLE`, `KYC_ADMIN_ROLE`) and bypass the timelock by design. `pauseAsset` / `unpauseAsset` accept either `ADMIN_ROLE` or `PAUSER_ROLE`, so once ADMIN sits behind the timelock the ops multi-sig remains the practical responder.

---

## 12. Publish addresses

Commit the final `.env` values (addresses only — never private keys) to `docs/deployments/base-sepolia.md` or the equivalent for ops lookups. Include `BASE_SEPOLIA_TIMELOCK_ADDRESS` — integrators verifying the admin surface will check `owner()` against it.

Record the block numbers too: `cast block-number --rpc-url $BASE_SEPOLIA_RPC_URL` at the start of each script for a point-in-time audit trail.

---

## 13. Sync the public keeper-bot ABI (Phase 9.A)

If this fresh-deploy run involved any contract change that
touches a selector the public reference keeper bot reads — i.e.
`MetricsFacet.getActiveLoansCount` /
`getActiveLoansPaginated`, `RiskFacet.calculateHealthFactor` /
`triggerLiquidation`, `LoanFacet.getLoanDetails` — regenerate the
bot's checked-in ABI bundles before tagging the deploy as done:

```bash
KEEPER_BOT_DIR=../../vaipakam-keeper-bot \
  bash contracts/script/exportAbis.sh
cd ../../vaipakam-keeper-bot
git diff src/abis/    # review the change
npm run typecheck
git commit -am 'Sync ABIs with vaipakam@<commit>'
git push
```

If the deploy was a pure config / parameter sweep with no
selector changes, this step is a no-op — the script still
re-runs cleanly but the diff is empty.

---

## 14. Sync the frontend ABI bundle

The frontend imports per-facet ABIs from
`frontend/src/contracts/abis/` (full Diamond surface, currently
27 facets). Any contract change that adds, removes, or reshapes a
selector or struct must be mirrored here, otherwise the frontend's
encoded calldata diverges from the deployed contract — and Base
Sepolia public RPCs (publicnode, sepolia.base.org) wrap the
resulting revert during `eth_estimateGas` as the generic
`"exceeds max transaction gas limit"`, so the failure mode looks
nothing like an ABI mismatch from the user's side.

```bash
forge build   # if you haven't built since the last edit
bash contracts/script/exportFrontendAbis.sh
cd frontend
node_modules/.bin/tsc -b --noEmit   # confirm the frontend still typechecks
git diff src/contracts/abis/    # review the change
git commit -am 'Sync frontend ABIs with contracts@<commit>'
```

The script writes `_source.json` next to the JSONs with the
contracts commit hash so the frontend bundle and the on-chain
deploy can be correlated post-hoc.

If you added a brand-new facet to the frontend, append it to the
`FACETS=(...)` array in `contracts/script/exportFrontendAbis.sh`
AND wire it into `frontend/src/contracts/abis/index.ts` — the
script does not touch the re-export barrel.
