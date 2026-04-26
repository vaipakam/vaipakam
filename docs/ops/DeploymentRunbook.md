# Deployment Runbook

Step-by-step procedure for a fresh deployment of the Vaipakam Diamond on a target chain, including cross-chain reward plumbing.

Audience: release engineer + signing multisig.

---

## How addresses get persisted

Every deploy script writes its outputs to a single per-chain artifact at:

```
contracts/deployments/<chain-slug>/addresses.json
```

`<chain-slug>` is fixed per chainId (`base-sepolia` for 84532, `sepolia` for
11155111, `bnb-testnet` for 97, etc. — see `Deployments.sol#chainSlug`).
Every Configure / Wire / Upgrade / Seed / smoke-test script reads from
this file via `Deployments.readDiamond()` etc.; operators no longer need
chain-prefixed env vars to follow each fresh deploy. The file is
committed and is the canonical post-deploy source of truth for both the
contract layer and the frontend env builder.

The schema each script populates (no manual editing needed since the
26 April 2026 enrichment):

| Key | Written by |
|---|---|
| `chainId`, `chainSlug`, `deployedAt`, `deployBlock` | `DeployDiamond` |
| `lzEid`, `lzEndpoint` | `DeployDiamond` (eid) + each OApp deploy script (endpoint) |
| `diamond`, `escrowImpl`, `treasury`, `admin` | `DeployDiamond` |
| `facets.<name>` (×30) | `DeployDiamond` |
| `vpfiToken`, `vpfiTokenImpl`, `vpfiOftAdapter`, `vpfiOftAdapterImpl`, `isCanonicalVPFI=true` | `DeployVPFICanonical` |
| `vpfiMirror`, `vpfiMirrorImpl`, `isCanonicalVPFI=false` | `DeployVPFIMirror` |
| `vpfiBuyReceiver`, `vpfiBuyReceiverImpl` | `DeployVPFIBuyReceiver` |
| `vpfiBuyAdapter`, `vpfiBuyAdapterImpl`, `vpfiBuyReceiverEid`, `vpfiBuyPaymentToken` | `DeployVPFIBuyAdapter` |
| `rewardOApp`, `rewardOAppBootstrapImpl`, `rewardOAppRealImpl`, `rewardLocalEid`, `rewardBaseEid`, `isCanonicalReward` | `DeployRewardOAppCreate2` |
| `rewardOApp` / `rewardLocalEid` / `rewardBaseEid` / `rewardGraceSeconds` / `isCanonicalReward` | `ConfigureRewardReporter` (idempotent overwrite) |
| `vpfiDiscountEthPriceAsset` / `vpfiBuyWeiPerVpfi` / `vpfiBuyGlobalCap` / `vpfiBuyPerWalletCap` / `vpfiBuyEnabled` | `ConfigureVPFIBuy` |
| `interactionLaunchTimestamp`, `interactionCapVpfiPerEth` | `SetInteractionLaunch` |
| `weth`, `mockChainlinkAggregator`, `mockUniswapV3Factory`, `mockERC20A/B`, `mockUSDC/WBTC/WETHFeed` | `DeployTestnetLiquidityMocks` |

Frontend `.env.local` and `frontend/.env.example` consume these by
mirroring the matching keys (e.g. `diamond` → `VITE_<CHAIN>_DIAMOND_ADDRESS`,
`deployBlock` → `VITE_<CHAIN>_DEPLOY_BLOCK`,
`facets.metricsFacet` → `VITE_<CHAIN>_METRICS_FACET_ADDRESS`,
`vpfiBuyAdapter` → `VITE_<CHAIN>_VPFI_BUY_ADAPTER`).

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
| v3-style concentrated-liquidity AMM factory and USDT/USD denominator configured for the chain | see `OracleAdminFacet` setters |

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

---

## Chain-specific quirks

### BNB Smart Chain Testnet (chainId 97, eid 40102)

- **Do not pass `--slow` to `forge script` on this chain.** Alchemy's
  BNB Testnet endpoint stalls indefinitely on `eth_getTransactionReceipt`
  polling under `--slow`, causing `forge` to hang post-broadcast even
  when the txs landed. We hit a 1h hang with zero receipts confirmed
  during the first §2 mocks deploy. Use `--legacy` instead:
  ```bash
  forge script script/<Name>.s.sol:<Name> \
    --rpc-url $BNB_TESTNET_RPC_URL --broadcast --legacy -vv
  ```
  `--legacy` sends pre-EIP-1559 txs at the gas-price returned by
  `eth_gasPrice` (1 gwei on BNB Testnet at this writing) and Foundry
  resumes its post-broadcast bookkeeping immediately. The deploy then
  takes ~30s instead of timing out.
- **Wrapped-native is WBNB, not WETH.** `DeployTestnetLiquidityMocks`
  wires `OracleAdminFacet.setWethContract(...)` to the canonical
  PancakeSwap WBNB at `0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd`.
  The Diamond's price-asset machinery doesn't care about the symbol —
  only that a Chainlink-backed feed exists and the v3-style depth
  check resolves to a non-zero pool.
- **Buy adapter pays in tBNB**, not tETH. The script writes
  `vpfiBuyPaymentToken = 0x0` (native-gas mode); the canonical Base
  receiver still quotes the rate in wei-per-VPFI on its side, so the
  user pays whatever the local chain's native asset is.
- **Funding floor**: the §1 Diamond cut + §2 mocks + §3-§6 contract
  deploys cost ~0.13 tBNB at 1 gwei. Have ≥0.3 tBNB on the deployer
  EOA before starting; admin EOA needs ≥0.05 tBNB for handover +
  config + peer-wire txs.

---

## 8. Off-chain alert watcher (one-time, not per-chain)

The HF alert watcher at `ops/hf-watcher/` runs as a Cloudflare Worker
and is shared across every supported chain — it polls each Diamond on
a 5-minute cron and dispatches per-user threshold notifications via
Telegram + Push Protocol. This section is one-time setup and does
**not** repeat per-chain deploy.

### 8a. Telegram bot

1. Create the bot via [`@BotFather`](https://t.me/BotFather) with `/newbot`.
   Use the handle `@VaipakamBot` for production. BotFather hands back
   the bot's API token on creation — this is the only time it appears
   in plaintext.
2. Set worker secrets / vars:
   ```bash
   cd ops/hf-watcher
   npx wrangler secret put TG_BOT_TOKEN          # paste BotFather token
   ```
   `TG_BOT_USERNAME` is committed in `wrangler.jsonc` as a public var.
3. Register the webhook so Telegram pushes inbound DMs into the worker:
   ```bash
   curl "https://api.telegram.org/bot<TG_BOT_TOKEN>/setWebhook" \
        --data-urlencode "url=https://alerts.vaipakam.com/tg/webhook"
   ```
   Verify with `getWebhookInfo`.

### 8b. Push Protocol channel

1. **One-time channel creation.** Connect a fresh dedicated EOA at
   <https://app.push.org/>, fund it with 50 PUSH (the staking deposit;
   refundable on channel deletion), and create the Vaipakam channel
   with name + description + icon + website.
2. **Production channel address** (do not change without rotating):
   - **`0x6F5847A0CA1F2cB1bbEf944124cE5995988a1D6b`**
   - Public URL: <https://app.push.org/channels/0x6F5847A0CA1F2cB1bbEf944124cE5995988a1D6b>
   - End-user subscribe deep-link rendered on the Alerts page goes to
     the same URL via the `VITE_PUSH_CHANNEL_ADDRESS` env var.
3. **Channel signer privkey → worker secret.**
   ```bash
   npx wrangler secret put PUSH_CHANNEL_PK       # paste 0x-prefixed 64-hex
   ```
   The private key is **never** committed and never appears in
   `wrangler.jsonc`. The channel-owner wallet should hold only the
   staking deposit + ~$50 of native gas — nothing else of value.
4. **Frontend env.** Set on every frontend deploy:
   ```
   VITE_PUSH_CHANNEL_ADDRESS=0x6F5847A0CA1F2cB1bbEf944124cE5995988a1D6b
   VITE_HF_WATCHER_ORIGIN=https://alerts.vaipakam.com
   ```
   Without these, the Alerts page falls closed gracefully; with them,
   the "Subscribe on Push →" deep link and the Push rail enable
   button both render correctly.

### 8c. Smoke test the watcher

```bash
cd ops/hf-watcher
npx wrangler tail        # tail logs in another terminal

# From a test wallet:
#   1. Subscribe to the Push channel at the URL in 8b.2
#   2. /app/alerts → Save thresholds, Link Telegram, Enable Push rail
#   3. Lower one threshold below the connected wallet's HF
#   4. Wait for the next 5-min cron tick
# Expect: log lines for `tg send` + Push API success on band crossings.
```

A `[push] send failed …` line means either `PUSH_CHANNEL_PK` is
wrong format or the channel hasn't cleared the post-stake delay
(~10 blocks after channel-create tx on mainnet). Re-stake confirmations
take a few minutes; nothing else to do.
