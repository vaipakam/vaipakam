# BNB Smart Chain Testnet — Fresh Deployment Runbook

End-to-end order of operations for a clean BNB Testnet deployment.
BNB Testnet is a **mirror-VPFI / mirror-reward** chain in the Phase-1
mesh — canonical VPFI + reward chain remains Base Sepolia (chainId
`84532`, LZ eid `40245`). BNB Testnet itself: chainId `97`, LZ eid
`40102`.

> Read the [`DeploymentRunbook.md`](./DeploymentRunbook.md) first for
> the cross-chain plumbing rationale (CREATE2 reward proxy, peer
> wiring topology, addresses-as-source-of-truth). This document only
> covers the BNB-specific cookbook + quirks.

All commands run from `contracts/`.

---

## Chain-specific quirks (READ FIRST)

| Quirk | Action |
|---|---|
| Alchemy BNB endpoint stalls under `forge --slow` | **Use `--legacy` instead** of `--slow` for every `forge script` invocation on BNB Testnet. `--slow` polls `eth_getTransactionReceipt` aggressively; on this RPC it hangs past 1h with 0 receipts confirmed even when the txs landed. `--legacy` sends pre-EIP-1559 txs at the gas-price returned by `eth_gasPrice` (1 gwei at this writing) and `forge` resumes its post-broadcast bookkeeping immediately. |
| Wrapped-native is **WBNB**, not WETH | `DeployTestnetLiquidityMocks` wires `OracleAdminFacet.setWethContract(...)` to canonical PancakeSwap WBNB at `0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd`. The protocol's price-asset machinery doesn't care about the symbol — only that a Chainlink-backed feed exists and the v3-style depth check resolves. |
| Buy adapter is **native-BNB** mode | `vpfiBuyPaymentToken = 0x0`. Users pay in tBNB; the canonical Base receiver still quotes the rate in wei-per-VPFI on its side. |
| Funding floor | Deployer EOA needs ≥0.3 tBNB before §1; admin EOA needs ≥0.05 tBNB for handover + config + peer-wire txs. Faucets: <https://www.bnbchain.org/en/testnet-faucet>, <https://testnet.bnbchain.org/faucet-smart>. |

---

## 0. Pre-flight

```bash
# RPC + balances
cast chain-id --rpc-url $BNB_TESTNET_RPC_URL    # → 97
cast balance --ether $(cast wallet address --private-key $PRIVATE_KEY) \
  --rpc-url $BNB_TESTNET_RPC_URL                # ≥ 0.3 tBNB
cast balance --ether $(cast wallet address --private-key $ADMIN_PRIVATE_KEY) \
  --rpc-url $BNB_TESTNET_RPC_URL                # ≥ 0.05 tBNB

# LZ V2 endpoint live + EID matches
cast call 0x6EDcE65403992e310A62460808c4b910D972f10F "eid()(uint32)" \
  --rpc-url $BNB_TESTNET_RPC_URL                # → 40102

# Required env keys (in contracts/.env):
grep -E "^BNB_TESTNET_RPC_URL|^LZ_ENDPOINT_BNB_TESTNET|^PRIVATE_KEY|^ADMIN_PRIVATE_KEY|^ADMIN_ADDRESS|^TREASURY_ADDRESS|^VPFI_OWNER|^VPFI_BUY_RECEIVER_EID" .env
```

`forge build` must pass. The full `forge test` suite is the same as
on Base Sepolia — no chain-specific tests gate this deploy.

---

## 1. Deploy the Diamond

```bash
forge script script/DeployDiamond.s.sol:DeployDiamond \
  --rpc-url $BNB_TESTNET_RPC_URL --broadcast --legacy --slow -vv
```

Note: `--slow` IS safe HERE because the only post-broadcast wait is
the bookkeeping write to `addresses.json` — there's no extended
receipt-polling loop in `DeployDiamond`. Subsequent steps (§2 onward)
must drop `--slow`.

The script writes `chainId`, `chainSlug`, `lzEid`, `deployBlock`,
`diamond`, `escrowImpl`, `treasury`, `admin`, and all 30 facet
addresses to `deployments/bnb-testnet/addresses.json`. After this:

```bash
cat deployments/bnb-testnet/addresses.json | jq '.diamond, .deployBlock, (.facets | keys | length)'
# → "<diamond>", <number>, 30
```

Verify the handover (admin owns the proxy, deployer holds zero roles)
exactly as in the Base Sepolia runbook §1.

---

## 2. Liquidity mocks (testnet only)

The same `DeployTestnetLiquidityMocks.s.sol` covers Base Sepolia,
Sepolia, and BNB Testnet. The script picks the wrapped-native asset
per chain — WBNB on this one — and stores it as `weth` in the
artifact (the schema field is named after the role, not the symbol).

```bash
forge script script/DeployTestnetLiquidityMocks.s.sol:DeployTestnetLiquidityMocks \
  --rpc-url $BNB_TESTNET_RPC_URL --broadcast --legacy -vv
```

Verify both mock assets classify Liquid:

```bash
DIAMOND=$(jq -r .diamond deployments/bnb-testnet/addresses.json)
MUSDC=$(jq -r .mockERC20A deployments/bnb-testnet/addresses.json)
MWBTC=$(jq -r .mockERC20B deployments/bnb-testnet/addresses.json)
cast call $DIAMOND "checkLiquidity(address)(uint8)" $MUSDC --rpc-url $BNB_TESTNET_RPC_URL  # → 0
cast call $DIAMOND "checkLiquidity(address)(uint8)" $MWBTC --rpc-url $BNB_TESTNET_RPC_URL  # → 0
```

---

## 3. VPFIMirror (mirror-side OFT)

```bash
forge script script/DeployVPFIMirror.s.sol:DeployVPFIMirror \
  --rpc-url $BNB_TESTNET_RPC_URL --broadcast --legacy -vv
```

The script calls `VPFITokenFacet(diamond).setVPFIToken(<mirror>)` and
leaves `isCanonicalVPFIChain=false` — the mint gate in
`TreasuryFacet.mintVPFI` will reject any local mint attempt on this
chain. Writes `vpfiMirror`, `vpfiMirrorImpl`, `lzEndpoint`, and
`isCanonicalVPFI=false` to the artifact.

---

## 4. VPFIBuyAdapter (mirror-side buy entrypoint)

```bash
forge script script/DeployVPFIBuyAdapter.s.sol:DeployVPFIBuyAdapter \
  --rpc-url $BNB_TESTNET_RPC_URL --broadcast --legacy -vv
```

The script reads `VPFI_BUY_RECEIVER_EID=40245` (Base Sepolia) and
defaults `vpfiBuyPaymentToken` to `0x0` (native BNB) when no
`BNB_TESTNET_VPFI_BUY_PAYMENT_TOKEN` env is set. Writes
`vpfiBuyAdapter`, `vpfiBuyAdapterImpl`, `lzEndpoint`,
`vpfiBuyReceiverEid`, `vpfiBuyPaymentToken` to the artifact.

**Mainnet warning — DO NOT carry native-gas mode forward to BNB
Smart Chain mainnet (chainId 56).** The receiver's wei-per-VPFI
rate is denominated in ETH-equivalent value; native-gas mode on
mainnet would mean users pay 1 BNB where the receiver expects 1 ETH
worth of value, mis-pricing every buy. For mainnet, set
`BNB_VPFI_BUY_PAYMENT_TOKEN` to the canonical bridged WETH9 on BNB
(`0x2170Ed0880ac9A755fd29B2688956BD959F933F8` — verify against
BscScan and the LayerZero bridged-asset registry before pasting).
The deploy script's pre-flight will refuse to proceed otherwise —
that's by design. Same gate applies to Polygon PoS mainnet
(chainId 137) with `POLYGON_VPFI_BUY_PAYMENT_TOKEN` and the
canonical Polygon WETH9 (`0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619`).
Full per-chain table in
[`DeploymentRunbook.md`](DeploymentRunbook.md) under "VPFIBuyAdapter —
payment-token mode".

---

## 5. Set the discount ETH price asset (mirror-side §5)

`ConfigureVPFIBuy.s.sol` is canonical-only by design (rate/caps are
authoritative on Base) — it reverts on chainId 97. Mirror chains only
need the discount math's price-asset pointer, which we set via direct
`cast send`:

```bash
DIAMOND=$(jq -r .diamond deployments/bnb-testnet/addresses.json)
WBNB=0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd
cast send $DIAMOND "setVPFIDiscountETHPriceAsset(address)" $WBNB \
  --private-key $ADMIN_PRIVATE_KEY --rpc-url $BNB_TESTNET_RPC_URL --legacy
```

Verify:

```bash
cast call $DIAMOND "getVPFIBuyConfig()(uint256,uint256,uint256,uint256,bool,address)" \
  --rpc-url $BNB_TESTNET_RPC_URL
# Last field = 0xae13...a7cd (WBNB)
```

---

## 6. RewardOApp (CREATE2 — must match Base Sepolia address)

```bash
REWARD_VERSION=v1 \
REWARD_OWNER=$ADMIN_ADDRESS \
IS_CANONICAL_REWARD=false \
BASE_EID=40245 \
REPORT_OPTIONS_HEX=0x \
BROADCAST_OPTIONS_HEX=0x \
LZ_ENDPOINT=$LZ_ENDPOINT_BNB_TESTNET \
forge script script/DeployRewardOAppCreate2.s.sol:DeployRewardOAppCreate2 \
  --rpc-url $BNB_TESTNET_RPC_URL --broadcast --legacy -vv
```

**Critical**: the logged `RewardOAppProxy (CROSS-CHAIN IDENTICAL)`
address MUST match the Base Sepolia + Sepolia values byte-for-byte.
For the v1 mesh that's `0x88C6a502c38E854C04F0A5f21850808A26452aDd`.
A divergent address means `REWARD_VERSION` drifted or a non-owner
deployer produced a different bootstrap init code — abort and
re-deploy with the same version key.

---

## 7. ConfigureRewardReporter (mirror-side wiring)

The reporter facet is admin-gated, so override `PRIVATE_KEY` with the
admin key:

```bash
PRIVATE_KEY=$ADMIN_PRIVATE_KEY \
LOCAL_EID=40102 \
BASE_EID=40245 \
REWARD_OAPP_PROXY=0x88C6a502c38E854C04F0A5f21850808A26452aDd \
forge script script/ConfigureRewardReporter.s.sol:ConfigureRewardReporter \
  --rpc-url $BNB_TESTNET_RPC_URL --broadcast --legacy -vv
```

The script writes `rewardOApp`, `rewardLocalEid=40102`, `rewardBaseEid=40245`,
`rewardGraceSeconds=14400`, `isCanonicalReward=false` to the artifact.

---

## 8. Anchor day-0 (cross-chain timestamp parity)

The same launch timestamp must be used on every chain in the mesh.
For the v1 testnet mesh: **`1777075200`** (UTC midnight 2026-04-25).
Re-deploys should NOT use a different value — it would split the
day-index into incompatible windows.

```bash
INTERACTION_LAUNCH_TIMESTAMP=1777075200 \
PRIVATE_KEY=$ADMIN_PRIVATE_KEY \
forge script script/SetInteractionLaunch.s.sol:SetInteractionLaunch \
  --rpc-url $BNB_TESTNET_RPC_URL --broadcast --legacy -vv
```

Cross-chain parity check:

```bash
jq '.interactionLaunchTimestamp' deployments/*/addresses.json | sort -u
# MUST output a single value across every per-chain file
```

---

## 9. Wire peers into the mesh

BNB Testnet joining the existing BS↔Sep mesh requires **8 peer
`setPeer` calls + 1 aggregator update**:

| # | On chain | Local OApp | Remote eid | Remote peer |
|---|---|---|---|---|
| 1 | Base Sepolia | OFTAdapter | 40102 | BNB Mirror |
| 2 | Sepolia | Mirror | 40102 | BNB Mirror |
| 3 | BNB Testnet | Mirror | 40245 | BS OFTAdapter |
| 4 | BNB Testnet | Mirror | 40161 | Sep Mirror |
| 5 | Base Sepolia | BuyReceiver | 40102 | BNB BuyAdapter |
| 6 | BNB Testnet | BuyAdapter | 40245 | BS BuyReceiver |
| 7 | Base Sepolia | RewardOApp | 40102 | BNB RewardOApp |
| 8 | BNB Testnet | RewardOApp | 40245 | BS RewardOApp |

Plus update the aggregator's expected source list:

```bash
BS_DIAMOND=$(jq -r .diamond deployments/base-sepolia/addresses.json)
cast send $BS_DIAMOND "setExpectedSourceEids(uint32[])" "[40161,40102]" \
  --private-key $ADMIN_PRIVATE_KEY --rpc-url $BASE_SEPOLIA_RPC_URL
```

Each peer wire is one `setPeer(uint32 eid, bytes32 peer)` call. You
can either run `WireVPFIPeers.s.sol` 8 times with different envs, or
loop with direct `cast send` (faster) — see the BNB session in the
release notes for an end-to-end script.

**Cast pacing on Base Sepolia**: the `setExpectedSourceEids` and 3
peer-wire calls back-to-back can hit `replacement transaction
underpriced` / `nonce too low` if `cast` underestimates the next
nonce. If that happens, fetch the explicit nonce and retry:

```bash
NONCE=$(cast nonce $(cast wallet address --private-key $ADMIN_PRIVATE_KEY) \
  --rpc-url $BASE_SEPOLIA_RPC_URL)
cast send <target> <sig> <args> --private-key $ADMIN_PRIVATE_KEY \
  --rpc-url $BASE_SEPOLIA_RPC_URL --nonce $NONCE
```

---

## 10. Verify the wiring

```bash
EID_BS=40245; EID_SE=40161; EID_BNB=40102

# Base Sepolia must list both mirrors
cast call $BS_DIAMOND "getExpectedSourceEids()(uint32[])" --rpc-url $BASE_SEPOLIA_RPC_URL
# → [40161, 40102]

# Each peer's bytes32 must match the counterpart proxy address
cast call <local_oapp> "peers(uint32)(bytes32)" <remote_eid> --rpc-url <local_rpc>
```

Cross-chain invariants (all three must hold):

- **RewardOApp address parity** — `jq -r .rewardOApp deployments/*/addresses.json | sort -u` returns one value.
- **Day-0 anchor parity** — `jq -r .interactionLaunchTimestamp deployments/*/addresses.json | sort -u` returns one value.
- **Bidirectional peers** — for every (A, B) pair in the mesh, `peers[A→B]` on chain A = peer-of-B's address, and `peers[B→A]` on chain B = peer-of-A's address.

---

## 11. Publish

- Commit `deployments/bnb-testnet/addresses.json`.
- Sync the merged JSON to both consumers in one command:
  `bash contracts/script/exportFrontendDeployments.sh`. This
  rewrites `frontend/src/contracts/deployments.json` AND
  `ops/hf-watcher/src/deployments.json` from the canonical
  `addresses.json` files. No more `VITE_BNB_TESTNET_DIAMOND_ADDRESS`
  / `VITE_BNB_TESTNET_*_FACET_ADDRESS` edits in `.env.local` —
  those env vars were removed when the JSON-import pattern landed.
- Commit the regenerated `deployments.json` files alongside the
  contracts change.
- Update `contracts/.env` chain-prefixed legacy keys
  (`BNB_TESTNET_DIAMOND_ADDRESS` etc.) — these are still consulted as
  env-fallback by some legacy scripts.
- Tag the commit `vX.Y.Z-deployed-bnb-testnet`.
- File an entry in [`docs/ops/IncidentRunbook.md#deployment-log`](./IncidentRunbook.md#deployment-log).
