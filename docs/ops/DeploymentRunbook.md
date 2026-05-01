# Deployment Runbook

Step-by-step procedure for a fresh deployment of the Vaipakam Diamond on a target chain, including cross-chain reward plumbing.

Audience: release engineer + signing multisig.

---

## TL;DR — pick the right script

| Target | Script | Notes |
|---|---|---|
| Local dev (anvil) | `bash contracts/script/anvil-bootstrap.sh` | Full local playground — diamond + mocks + Multicall3 etch + Range Orders flags ON + seed offers + ABI/JSON sync (one command). |
| Testnet one-shot | `bash contracts/script/deploy-chain.sh <chain-slug>` | Auto-chains build → diamond → timelock → VPFI lane (canonical / mirror branched on slug) → reward OApp → ABI/JSON sync → frontend wrangler deploy → watcher wrangler deploy. Refuses any mainnet slug. |
| Mainnet | `bash contracts/script/deploy-mainnet.sh <chain-slug> --phase <phase>` | Tiered. Each phase (`preflight`, `contracts`, `lz-config`, `abi-sync`, `cf-frontend`, `cf-watcher`, `verify`) is a deliberate operator action. Confirm flags gate the irreversible phases (`--confirm-i-have-multisig-ready`, `--confirm-dvn-policy-reviewed`). Refuses testnet slugs. |

**What the scripts deliberately do NOT do** (every chain — these stay
manual for safety):

- **Role rotation** to governance multisig + timelock — multi-party
  ceremony, see §6 below.
- **LayerZero peer wiring** across chains — needs both legs deployed
  first; run `WireVPFIPeers.s.sol` on each (canonical, mirror) pair.
- **Wrangler secrets** — operator-specific (TG_BOT_TOKEN, RPC API
  keys, push-channel PK, aggregator keys, keeper PK). `wrangler secret
  put <KEY>` per the watcher's docs; never in any repo.
- **Mainnet phases auto-chained** — each `--phase` invocation lands
  one stage so the operator eyeballs the diff before the next.

The sections below remain the canonical step-by-step. The new scripts
just bundle the routine forge-script + export-script + wrangler steps
into reproducible flows; the ceremonies (§6 role rotation, LZ peer
wiring) stay one-by-one.

---

## Adding support for a new chain

Before you can run a single deploy step on a chain, the codebase must
*know* that chain — the per-chain Diamond address, env-var prefix, LZ
endpoint id, and frontend wagmi record. Adding a new chain is **exactly
four code edits**:

1. **`contracts/script/lib/Deployments.sol#chainSlug()`** — add
   `if (cid == X) return "<slug>";`. The slug becomes the
   `deployments/<slug>/addresses.json` directory name.
2. **`contracts/script/lib/Deployments.sol#envPrefix()`** — add
   `if (cid == X) return "<PREFIX>_";`. This is the binding that turns
   `block.chainid == 97` into `vm.envAddress("BNB_TESTNET_DIAMOND_ADDRESS")`
   when the artifact file is missing.
3. **`contracts/script/lib/Deployments.sol#lzEidForChain()`** — add the
   LayerZero V2 endpoint id row (e.g. `if (cid == 97) return 40102;`).
   Every Deploy*OApp* / RewardOApp script stamps this into
   `addresses.json#lzEid` automatically.
4. **`frontend/src/contracts/config.ts`** — add the per-chain record,
   literally spelling out the `VITE_<PREFIX>_*` keys it consumes
   (`rpcUrl`, `diamondAddress`, `deployBlock`,
   `metricsFacetAddress`, `vpfiBuyAdapter`, `vpfiBuyPaymentToken`).
   Each chain's env-var name is hardcoded in its record — there is no
   general "for chainId N read `VITE_<PREFIX>_*`" rule, only the
   per-chain literal.

The `.env`, `.env.local`, `.env.example` files are **just storage** for
the values those four code rows look up. **Without the four code edits,
the env vars are dead text**: setting `BNB_TESTNET_DIAMOND_ADDRESS` in
`.env` does nothing if `Deployments.sol#envPrefix()` doesn't return
`"BNB_TESTNET_"` for chainid 97.

Quick sanity check after the four edits:

```bash
# Solidity side — should not revert and should produce the expected slug
forge script -vv --rpc-url $NEW_CHAIN_RPC_URL \
  --sig 'run()' contracts/script/PrintChainSlug.s.sol  # if you have it,
                                                       # else just attempt
                                                       # any Deploy* in dry-run
                                                       # — chainSlug()/envPrefix()
                                                       # are called in writeChainHeader.

# Frontend side — should compile and the new chainId should appear in the picker
cd frontend && npm run typecheck && npm run dev
```

After those pass, the per-chain runbook (e.g.
[`BaseSepoliaDeploy.md`](./BaseSepoliaDeploy.md),
[`BNBTestnetDeploy.md`](./BNBTestnetDeploy.md)) is the cookbook for the
actual broadcasts.

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

Both the frontend and the hf-watcher Worker consume these via a
single consolidated `deployments.json` keyed by `chainId`:

- `frontend/src/contracts/deployments.json` — read by
  [`frontend/src/contracts/deployments.ts`](../../frontend/src/contracts/deployments.ts)
  (`getDeployment(chainId)`) and folded into the
  `CHAIN_REGISTRY` by `frontend/src/contracts/config.ts`.
- `ops/hf-watcher/src/deployments.json` — read by
  [`ops/hf-watcher/src/deployments.ts`](../../ops/hf-watcher/src/deployments.ts)
  and consumed by `getChainConfigs(env)` in `env.ts`.

Both files are byte-identical merges of every per-chain
`addresses.json`. Don't hand-edit either; both are emitted by:

```bash
bash contracts/script/exportFrontendDeployments.sh
```

The script auto-detects both consumers via the sibling layout
(`vaipakam/frontend` and `vaipakam/ops/hf-watcher`), merges every
`deployments/<chain>/addresses.json`, and writes the merged JSON
+ a `_deployments_source.json` provenance stamp into each
target's `src/contracts/` (frontend) / `src/` (watcher). Pass
`WATCHER_DIR=` (empty) to skip the watcher target. Idempotent:
re-running with no upstream changes leaves both outputs
byte-identical.

Run it after every contract redeploy *before*:
- `cd frontend && npm run deploy` (so new addresses inline into
  the JS bundle), AND
- `cd ops/hf-watcher && wrangler deploy` (so the watcher reads
  the new addresses on its next cron tick).

What stays operator-side after this consolidation:

- Frontend `.env.local`: per-chain RPC URLs (with API key),
  WalletConnect project ID, default chain ID, log-chunk tuning,
  feature flags, push channel address.
- Watcher `wrangler.jsonc:vars`: `FRONTEND_ORIGIN`,
  `TG_BOT_USERNAME`, `DIAG_*` knobs.
- Watcher Cloudflare secrets (`wrangler secret put …`):
  `RPC_*` URLs (carry API keys), `TG_BOT_TOKEN`,
  `PUSH_CHANNEL_PK`, aggregator API keys, keeper private key.

Caveat for CI: `frontend/.env.local` is gitignored. The
addresses themselves are NOT in `.env.local` anymore, so a CI
build that doesn't have the operator's local file will still get
correct Diamond / facet addresses from the committed
`frontend/src/contracts/deployments.json`. The CI environment
only needs the operator-side values listed above (RPC URLs,
WalletConnect ID, etc.) — set those in the Cloudflare Workers
Builds → Build environment variables panel one-time, then every
push picks them up.

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
4. Record the logged addresses in `deployments/<chain>/addresses.json` and populate `<CHAIN>_DIAMOND_ADDRESS` in `contracts/.env`. The frontend + watcher consumer side is one command — `bash contracts/script/exportFrontendDeployments.sh` merges every chain artifact into `frontend/src/contracts/deployments.json` AND `ops/hf-watcher/src/deployments.json`, plus provenance stamps for both. The frontend's `getDeployment(chainId)` and the watcher's `getChainConfigs(env)` both read from the merged JSON. Idempotent.

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

## 7.5. Sync ABIs to dependent repos / bundles

Any contract change in this deploy that touches a public selector or
struct shape needs the dependent ABI bundles regenerated, otherwise
they encode calldata against stale shapes. Two consumers, both
sourced via `forge inspect`:

```bash
forge build   # if not already built since the last edit

# (a) Frontend — full Diamond surface (~27 facets). Run on every
#     facet-touching deploy.
bash contracts/script/exportFrontendAbis.sh
cd frontend && node_modules/.bin/tsc -b --noEmit && cd ..
git diff frontend/src/contracts/abis/
git commit -am 'Sync frontend ABIs with contracts@<hash>'

# (b) Public keeper-bot — narrow surface (Metrics / Risk / Loan).
#     Skip if the deploy didn't touch those selectors.
KEEPER_BOT_DIR=../../vaipakam-keeper-bot \
  bash contracts/script/exportAbis.sh
cd ../../vaipakam-keeper-bot
git diff src/abis/ && npm run typecheck
git commit -am 'Sync ABIs with vaipakam@<hash>' && git push
```

Why both: a missed frontend sync surfaces as a generic
`"exceeds max transaction gas limit"` revert during
`eth_estimateGas` on Base public RPCs (the calldata is one word
too long; the RPC strips the real revert reason). A missed keeper
sync ships a public bot with `"function selector not found"`
failures in production. Per-chain runbooks
(`BaseSepoliaDeploy.md` §13–14, `BNBTestnetDeploy.md`, etc.)
inherit this step from here — don't duplicate the long form
there, just point back.

**Local anvil playground** — `contracts/script/anvil-bootstrap.sh`
ships with this same sync wired in as its final step (6/6) so a
`bash anvil-bootstrap.sh` lands a fresh diamond, etches Multicall3,
flips Range Orders flags on, seeds offers, AND regenerates
`frontend/src/contracts/abis/`, `frontend/src/contracts/deployments.json`,
`ops/hf-watcher/src/deployments.json`, and (when the sibling repo is
present) `vaipakam-keeper-bot/src/abis/` — all in one command. The
keeper-bot export is gated on `../../vaipakam-keeper-bot` existing
so a contributor without that checkout still gets a clean run. For
the production deploy path the sync stays manual on purpose so the
operator can review each diff before committing.

---

## VPFIBuyAdapter — payment-token mode (per-chain MANDATORY config)

The mirror-chain VPFIBuyAdapter pulls the buyer's funds locally and
forwards a BUY_REQUEST via LayerZero to the canonical Base receiver,
which mints + sends VPFI. The receiver quotes a single global
**wei-per-VPFI rate denominated in ETH-equivalent value**. That makes
the adapter's `paymentToken` a per-chain economic gate, not a free
choice:

| Chain (mainnet)        | chainId | Mode                | Required env var                  | Canonical bridged WETH9                       |
|------------------------|--------:|---------------------|-----------------------------------|-----------------------------------------------|
| Ethereum               |       1 | Native-gas (ETH)    | (leave unset)                     | n/a                                           |
| Base                   |    8453 | Canonical receiver  | n/a — buys hit Diamond directly   | n/a                                           |
| Arbitrum One           |   42161 | Native-gas (ETH)    | (leave unset)                     | n/a                                           |
| Optimism               |      10 | Native-gas (ETH)    | (leave unset)                     | n/a                                           |
| Polygon zkEVM          |    1101 | Native-gas (ETH)    | (leave unset)                     | n/a                                           |
| **BNB Smart Chain**    |    **56** | **WETH-pull (REQUIRED)** | `BNB_VPFI_BUY_PAYMENT_TOKEN` | `0x2170Ed0880ac9A755fd29B2688956BD959F933F8` |
| **Polygon PoS**        |   **137** | **WETH-pull (REQUIRED)** | `POLYGON_VPFI_BUY_PAYMENT_TOKEN` | `0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619` |

**Why mainnet BNB / Polygon need WETH-pull mode:** native-gas mode
on these chains would mean the user pays 1 BNB / 1 POL where the
receiver expects 1 ETH worth of value. Every buy mis-prices vs. the
global rate. The bridged WETH9 ERC20 fixes this — buyer holds and
approves WETH; the adapter pulls the ETH-denominated `amountIn`
unchanged.

**Two-layer enforcement (don't disable, don't paper over):**

1. **Deploy-script pre-flight (`DeployVPFIBuyAdapter.s.sol`)** —
   `_chainRequiresWethPaymentToken(chainId)` is `true` for chainIds
   56 and 137. The script reverts before broadcasting if the
   resolved `paymentToken` is zero on those chains, with an error
   message naming the env var the operator should set.
2. **Contract-side validation (`VPFIBuyAdapter.initialize`,
   `setPaymentToken`)** — when `paymentToken != address(0)`, the
   adapter requires `code.length > 0` (real contract, not EOA) AND
   `IERC20Metadata(token).decimals() == 18` (canonical WETH9
   invariant; catches the most common honest-mistake misconfig of
   pasting USDC's 6-dec address). New errors:
   `PaymentTokenNotContract`, `PaymentTokenDecimalsNot18`,
   `PaymentTokenDecimalsCallFailed`.

**What's NOT enforced on-chain — the operational check.** There's
no on-chain registry that says "this is *the canonical* bridged
WETH9 on chain X." A determined operator (or an attacker at deploy
time) could deploy a fake contract returning the right decimals.
Defence is operational: the deploy script logs the configured
token's `name()` / `symbol()` for human-eyeball confirmation
against the addresses in the table above. Always cross-check
against the chain's published bridge contracts list (BscScan +
LayerZero registry for BNB; PolygonScan + Polygon bridge contracts
for Polygon) before pasting.

**Pre-flight checklist before broadcasting `DeployVPFIBuyAdapter`
on BNB / Polygon mainnet:**

- [ ] Set `BNB_VPFI_BUY_PAYMENT_TOKEN` (or
      `POLYGON_VPFI_BUY_PAYMENT_TOKEN`) in `contracts/.env` to the
      canonical bridged WETH9 address from the table above.
- [ ] Visually confirm the address on BscScan / PolygonScan —
      contract verified, deployer is the chain's canonical bridge
      operator, NOT a recently-deployed proxy or a contract from an
      unknown EOA.
- [ ] Confirm `decimals()` returns 18 (block-explorer "Read
      Contract" tab — one click). If it returns anything else, the
      env var points at the wrong contract; do NOT proceed.
- [ ] Run the dry-run (`forge script ... --rpc-url`) without
      `--broadcast` first; the deploy script's logs print the
      resolved `paymentToken` address before it would broadcast.
      Eyeball-compare to the table above one more time.

**Testnet exemption.** BNB Smart Chain Testnet (chainId 97) and
Polygon Amoy (chainId 80002) are intentionally NOT in the strict
WETH-pull list. Their gas tokens have no real value and the
testnet rate is symbolic, so native-gas mode is acceptable for
dev-loop convenience. Mainnet equivalents must use WETH-pull —
the deploy-script pre-flight will refuse to proceed otherwise.

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
  **Mainnet equivalent (chainId 56) requires WETH-pull mode** — see
  the "VPFIBuyAdapter — payment-token mode" section above for the
  canonical bridged-WETH9 address and the deploy-script pre-flight
  that gates this. The testnet's native-gas mode is a deliberate
  exemption for dev-loop convenience; production deploys must
  flip to WETH-pull.
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

### 8d. Server-side error capture

The hf-watcher Worker also serves `POST /diag/record` — the
frontend fires-and-forgets one POST per UI failure event so
support has a server-side audit trail (UUID embedded in any
GitHub-issue prefill cross-references back to a real session).
Lives on the same Worker and the same D1 binding as §8a/§8b
above; no separate deploy.

**One-time setup (per environment)**:

1. Apply the new migration to the production database:
   ```bash
   cd ops/hf-watcher
   npx wrangler d1 migrations apply vaipakam-alerts-db --remote
   ```
   This creates the `diag_errors` table + indexes. Idempotent
   (uses `CREATE TABLE IF NOT EXISTS`).

2. Deploy the worker (same command as §8b — pushes the new
   `/diag/record` route + the per-IP rate-limit binding):
   ```bash
   npx wrangler deploy
   ```

3. Smoke test the endpoint:
   ```bash
   # From a shell on a host the FRONTEND_ORIGIN allows (or via
   # `curl --resolve` to bypass DNS):
   curl -X POST https://alerts.vaipakam.com/diag/record \
     -H 'origin: https://vaipakam.com' \
     -H 'content-type: application/json' \
     -d '{
       "id":"123e4567-e89b-42d3-a456-426614174000",
       "client_at":'"$(date +%s)"',
       "area":"smoke-test",
       "flow":"runbook-8d"
     }'
   # Expect: {"recorded":true,"id":"123e4567-…"}
   ```

   Then verify the row landed:
   ```bash
   npx wrangler d1 execute vaipakam-alerts-db --remote \
     --command "SELECT id, area, flow, recorded_at FROM diag_errors ORDER BY recorded_at DESC LIMIT 1"
   ```

**Tunable knobs** (all in `ops/hf-watcher/wrangler.jsonc`,
override per-environment via `wrangler vars` or the dashboard):

| Var | Default | What it does |
|---|---|---|
| `DIAG_SAMPLE_RATE` | `1.0` | Random write sampling. Drop to `0.1` to write 10% when error volume spikes. |
| `DIAG_RETENTION_DAYS` | `90` | Cron-driven prune deletes rows older than this. Bumped on every 5-min tick. |
| `DIAG_RECORD_RATELIMIT.simple.limit` / `period` | `60 / 60` | Per-IP rate limit. Tune in the `unsafe.bindings` block. |

**Frontend coupling**:

The frontend reads `VITE_HF_WATCHER_ORIGIN` (already set —
same origin as the Alerts page uses). No new frontend env var
is required for capture itself; the optional
`VITE_APP_VERSION` (CI-injected commit hash) gets stamped on
each captured row for release-correlation.

A second frontend var, `VITE_DIAG_DRAWER_ENABLED` (default
`true`), gates the user-facing Diagnostics drawer + FAB. Set
to `"false"` once server capture is observed healthy in
production to hide the drawer entirely — server capture
keeps running regardless. The user can still grab their
session journey log from the Data Rights page when the
drawer is hidden.

**GitHub-issue cross-reference workflow** (support team):

When a user files a GitHub issue using the prefill, the body
contains `**Report ID:** \`<UUID>\``. Look it up:

```bash
cd ops/hf-watcher
npx wrangler d1 execute vaipakam-alerts-db --remote \
  --command "SELECT * FROM diag_errors WHERE id = '<UUID>'"
```

If the row exists with a matching error fingerprint, the
report came from a real session. If not, the user fabricated
or altered the UUID — the surrounding error metadata in their
issue body is unverified.

**Privacy note**: the `diag_errors` table stores only what
the existing GitHub-issue prefill already publishes (redacted
wallet `0x…abcd`, error metadata, locale, viewport). No
user-agent, no full address, no localStorage / cookies / free-form
text. The Privacy Policy on the website carries one paragraph
describing this; keep them in sync if you change the schema.

---

## 9. LayerZero security watcher (one-time, not per-chain)

The `ops/lz-watcher` Cloudflare Worker is **separate from** the
hf-watcher in §8. It is internal-only — it has no public HTTP
surface, no fetch handler, no user-facing notification rails.
Its single job is detection + alert into a private ops Telegram
channel for three LayerZero security drift conditions:

- **DVN-set drift** (every `(chain × OApp × peer eid × send/receive)`
  pair must keep `requiredDVNCount=3`, `optionalDVNCount=2`,
  `optionalDVNThreshold=1`).
- **OFT mint/burn imbalance** (Base-locked VPFI must equal sum
  of mirror supplies — exact, by construction).
- **Oversized single-tx VPFI flow** (any `Transfer` event with
  `value > FLOW_THRESHOLD_VPFI`, default 100,000 VPFI).

The split from hf-watcher is deliberate: hf-watcher doubles as
a competitive autonomous keeper that any operator can clone via
the sibling `vaipakam-keeper-bot` repo (Phase 9.A) and run from
their own infrastructure. Co-locating internal security ops on
that same Worker would conflate two adversarial postures and
risk leaking incident state to the public surface. lz-watcher's
incident-response procedures live in `IncidentRunbook.md` §5.

### 9a. D1 database

```bash
cd ops/lz-watcher
npm install
npx wrangler d1 create vaipakam-lz-alerts-db
```

Wrangler prints the new database id. Paste it into
`wrangler.jsonc`'s `d1_databases[0].database_id` (replacing the
`REPLACE_AFTER_d1_create` placeholder).

Apply the schema migration (creates `lz_alert_state`,
`scan_cursor`, `oft_balance_history`):

```bash
npm run db:migrate
```

### 9b. Per-chain RPC keys

Use Alchemy / QuickNode / Infura — public RPCs (publicnode,
sepolia.base.org, polygon-rpc) rate-limit `eth_getLogs`
aggressively and the flow scanner will silently throttle into
uselessness. One key per chain in scope:

```bash
npx wrangler secret put RPC_BASE
npx wrangler secret put RPC_ETH
npx wrangler secret put RPC_ARB
npx wrangler secret put RPC_OP
npx wrangler secret put RPC_ZKEVM
npx wrangler secret put RPC_BNB
```

Skip any chain that's not yet live — the watcher silently
skips chains with empty RPC and the corresponding alerts are
not generated for that chain.

### 9c. Telegram bot — reuse vs. fresh

The Telegram bot token can be **reused** from hf-watcher
(`@VaipakamBot`) — chat IDs alone don't grant posting access
without the token, so a single bot serving two chats is fine.
What MUST be different is the destination chat: the ops
channel for lz-watcher is internal-only and must not be the
same chat as the user-facing alert handle.

```bash
npx wrangler secret put TG_BOT_TOKEN   # paste @VaipakamBot's token (same as hf-watcher)
```

Then add `@VaipakamBot` to the internal ops Telegram channel,
send any message in the channel, and read the chat id via:

```bash
curl "https://api.telegram.org/bot<TG_BOT_TOKEN>/getUpdates" | jq '.result[].message.chat.id'
```

The chat id is a negative integer for channels and groups. Set
it as a public var in `wrangler.jsonc`'s `vars` block:

```jsonc
"TG_OPS_CHAT_ID": "-1001234567890"
```

Not a secret — chat ids alone don't authorize posting.

If the security team prefers a separate bot identity for ops
channels (so a future hf-watcher token compromise can't post to
ops, and vice versa), create a fresh bot via @BotFather and
keep the two `TG_BOT_TOKEN` secrets distinct between Workers.

### 9d. LZ inventory (vars)

Edit `ops/lz-watcher/wrangler.jsonc`'s `vars` block — paste, per
chain, the LZ V2 endpoint address, the ULN302 send + receive
library addresses, and every Vaipakam OApp deployed on that
chain. Optional vars: `VPFI_TOKEN_BASE` (only needed for the
OFT-imbalance check), `FLOW_THRESHOLD_VPFI` (default 100,000
VPFI in base units = `100000000000000000000000`).

Empty values are OK — the watcher silently skips chains /
OApps with empty addresses, useful while bringing the mesh up
incrementally.

### 9e. Deploy

```bash
npm run deploy
```

The cron `*/5 * * * *` is wired in `wrangler.jsonc`. First tick
fires within 5 minutes.

### 9f. Smoke test

```bash
npx wrangler tail   # in another terminal
```

Empty cron ticks log `[lz-watcher] tick clean — no alerts`. To
verify the alert path end-to-end without engineering a real
drift, drop the threshold for the flow detector to a value
below current daily VPFI volume:

```bash
# In wrangler.jsonc temporarily:
"FLOW_THRESHOLD_VPFI": "1"
```

Redeploy. Within 5 minutes a Telegram alert should land in the
ops channel for any recent VPFI Transfer event. Restore the
production threshold and redeploy.

To verify the dedup path: keep the bad threshold in place
across two cron ticks. Only the first tick should produce a
fresh alert; subsequent ticks should log without delivering.

### 9g. Free-tier sizing

| Limit | Free tier | This Worker |
|---|---|---|
| Requests / day | 100,000 | 1,440 (5-min cron) — 1.4 % |
| CPU time / invocation | 10 ms | idle ≈ 2 ms; per-alert ≈ 3 ms |
| Subrequests / invocation | 50 | 18-25 steady state, more on backfill ticks |
| D1 storage / writes | 5 GB / 50K writes/day | ~10 writes/day |

If volume grows past those budgets (Phase 2 traffic, sub-minute
polling needs), upgrade to Workers Standard ($5/mo) for 1000
subrequests + 30 s CPU. No per-cron-tick code changes needed.

### 9h. When to redeploy

This Worker only redeploys when:
- New chain comes online → new RPC secret + new `vars` block.
- New OApp deployed → new `vars` entry.
- Threshold tuning (`FLOW_THRESHOLD_VPFI`).
- Incident-driven changes to the alert surface.

It does **not** need a redeploy when contract code changes —
the ABIs it uses are LZ V2 standard surface (`endpoint.getConfig`,
`oapp.peers`, ERC20 `Transfer` / `balanceOf` / `totalSupply`),
not Vaipakam Diamond selectors.
