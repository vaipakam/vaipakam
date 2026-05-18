# CCIP Cross-Chain Cutover Runbook

The step-by-step procedure for standing up Vaipakam's Chainlink CCIP
cross-chain layer — first as a **testnet rehearsal**, then as the
**mainnet cutover**.

Audience: release engineer + signing multisig.

This runbook covers only the **cross-chain (T-068 CCIP) stack**. The
Diamond + Timelock deploy and the Cloudflare/app deploys are the existing
[`DeploymentRunbook.md`](DeploymentRunbook.md); this document slots in
where that one's cross-chain rows used to (those rows predate the
LayerZero → CCIP migration and are superseded here).

Design reference:
[`LayerZeroToChainlinkCcipMigration.md`](../DesignsAndPlans/LayerZeroToChainlinkCcipMigration.md)
— §10 carries the resolved decisions this runbook depends on (chain set,
rate-limit starting values, CCT-admin governance path).

---

## 1. What gets deployed

`DeployCrosschain.s.sol` deploys the whole CCIP stack on **one chain**;
`ConfigureCcip.s.sol` wires the lanes/channels **after every chain is
deployed**. Per chain:

| Contract | Every chain | Canonical (Base) only | Mirror only |
|---|:---:|:---:|:---:|
| `CcipMessenger` (the one CCIP-aware adapter) | ✓ | | |
| VPFI CCIP `TokenPool` | ✓ — Lock/Release | | ✓ — Burn/Mint |
| `VpfiPoolRateGovernor` (the pool `rateLimitAdmin`) | ✓ | | |
| `VaipakamRewardMessenger` | ✓ | | |
| `VpfiBuyReceiver` | | ✓ | |
| `VPFIMirrorToken` + `VpfiBuyAdapter` | | | ✓ |

Canonical vs mirror is decided by `block.chainid` — `8453` / `84532` are
canonical Base; every other chain is a mirror.

**Chain set (design §10):** Ethereum, Base, Arbitrum, Optimism, BNB
(mainnet) and their public testnets. zk-rollup chains are out of scope.

---

## 2. Prerequisites

### 2.1 CCIP infrastructure addresses

Each chain has a published CCIP **Router**, **RMN proxy**,
**`TokenAdminRegistry`**, and **`RegistryModuleOwnerCustom`**. Pull them
from the Chainlink CCIP "Supported Networks" directory and put them in
`contracts/.env` as per-chain, slug-suffixed vars — the deploy scripts
resolve the active chain's set automatically:

```
CCIP_ROUTER_BASE=0x…                       CCIP_RMN_PROXY_BASE=0x…
CCIP_TOKEN_ADMIN_REGISTRY_BASE=0x…         CCIP_REGISTRY_MODULE_OWNER_CUSTOM_BASE=0x…
CCIP_ROUTER_ARBITRUM=0x…                   …  (one set per chain slug)
```

The slug suffix is the chain's upper-cased registry slug
(`BASE`, `BASE_SEPOLIA`, `ARBITRUM`, `ARB_SEPOLIA`, `OPTIMISM`,
`OP_SEPOLIA`, `ETHEREUM`, `SEPOLIA`, `BNB`, `BNB_TESTNET`).

### 2.2 Other env vars

- `DEPLOYER_PRIVATE_KEY` — the deploying EOA.
- `ADMIN_PRIVATE_KEY` / `ADMIN_ADDRESS` — owner of every deployed proxy
  and (after the Ownable2Step handover) of every TokenPool. On testnet
  this is the same EOA as the deployer; on mainnet it is the admin
  multisig (see §5).
- `TREASURY_ADDRESS` — local treasury for the buy adapter.
- `BASE_CHAIN_ID` — **mirror chains only** — the EVM chain id of
  canonical Base (`8453` mainnet, `84532` Base Sepolia).
- `CCIP_LANE_CHAIN_IDS` — **for the wiring pass** — comma-separated EVM
  chain ids of every *remote* chain to wire a lane to.
- Optional: `VPFI_BUY_PAYMENT_TOKEN` (default native ETH; bridged WETH on
  BNB/Polygon mainnet — see CLAUDE.md "VPFIBuyAdapter — payment-token
  mode by chain"), `VPFI_BUY_REFUND_TIMEOUT` (default 900s),
  `CCIP_DEST_GAS_LIMIT` (default 400000), `CCIP_GUARDIAN`,
  `CCIP_RATE_CAPACITY` / `CCIP_RATE_REFILL` (default the design §10
  starting values — see §4).

### 2.3 The Diamond must already exist

`DeployCrosschain.s.sol` reads the Diamond (and, on Base, the canonical
`VPFIToken`) from the per-chain `deployments/<slug>/addresses.json` that
`DeployDiamond.s.sol` writes. Deploy the Diamond first, per
`DeploymentRunbook.md`.

---

## 3. Deploy order

CCIP wiring is **two passes**: deploy every chain, *then* wire every
chain. `ConfigureCcip.s.sol` reads each remote chain's
`addresses.json` to resolve lane + channel peers, so it cannot run on a
chain until every chain in the topology has been deployed.

```
Pass 1 — deploy, every chain:        DeployCrosschain.s.sol
Pass 2 — wire, every chain:          ConfigureCcip.s.sol
```

The orchestration scripts encode this:

- **`deploy-chain.sh`** (testnet one-shot) — runs `DeployCrosschain` at
  step [4]; CCIP wiring is explicitly deferred (step [5c] is a note).
  Its closing message prints the `ConfigureCcip` command to run later.
- **`deploy-testnet.sh` / `deploy-mainnet.sh`** (tiered) — the
  `contracts` phase runs `DeployCrosschain`; the **`ccip-wire`** phase
  runs `ConfigureCcip`. Run `contracts` on every chain, then `ccip-wire`
  on every chain.

---

## 4. Stage A — testnet rehearsal

Testnet rehearsals stay **deployer/admin-owned** — no governance
handover (the handover ceremony is mainnet-only; testnet flow tests need
the EOA keys live).

For each testnet chain (`base-sepolia` first — it is canonical — then the
mirrors):

```
bash contracts/script/deploy-testnet.sh <chain-slug> --phase preflight
bash contracts/script/deploy-testnet.sh <chain-slug> --phase contracts \
     --confirm-i-have-multisig-ready
```

Once **every** chain's `contracts` phase has landed, wire each chain:

```
CCIP_LANE_CHAIN_IDS=<other chain ids> \
  bash contracts/script/deploy-testnet.sh <chain-slug> --phase ccip-wire
```

`CCIP_LANE_CHAIN_IDS` is the topology: on canonical Base list every
mirror; on a mirror list `84532` (hub-spoke) — or add the other mirrors
for a full mesh of direct mirror↔mirror VPFI transfers.

Then verify each chain:

```
bash contracts/script/deploy-testnet.sh <chain-slug> --phase verify
```

The `verify` phase checks the pool's `rateLimitAdmin` is the
`VpfiPoolRateGovernor` and that at least one lane is configured — proof
the bounded rate-limit path is wired.

**Local pre-flight before any testnet run:** the deploy + config scripts
are exercised end-to-end by `test/CcipDeploymentRehearsalTest.t.sol` —
run `forge test --match-path test/CcipDeploymentRehearsalTest.t.sol` to
confirm the stack assembles and all three flows round-trip.

---

## 5. Stage B — mainnet cutover

Same two passes, run as deliberate phased operator actions via
`deploy-mainnet.sh`. The difference from testnet is the **governance
posture**: every contract's owner, and the CCT admin, must end at the
admin multisig → governance timelock.

1. **Deploy** every mainnet chain (`base` first):
   ```
   bash contracts/script/deploy-mainnet.sh <chain-slug> --phase preflight
   bash contracts/script/deploy-mainnet.sh <chain-slug> --phase contracts \
        --confirm-i-have-multisig-ready
   ```
2. **Wire** every mainnet chain once all are deployed:
   ```
   CCIP_LANE_CHAIN_IDS=<remote chain ids> \
     bash contracts/script/deploy-mainnet.sh <chain-slug> --phase ccip-wire
   ```
3. **Verify** every chain (`--phase verify`).
4. **Hand over** ownership to governance — see §7.

On mainnet the admin is a **multisig**, which cannot broadcast a Foundry
script with a private key. `ConfigureCcip.s.sol` is admin-broadcast, so
on mainnet its calls are executed as a **multisig batch** with the same
arguments — `--phase ccip-wire` is the canonical reference for *which*
calls and *in what order*; the operator reproduces them through the Safe.

---

## 6. The mainnet-deploy gates

These are the CLAUDE.md "Cross-Chain Security Policy" gates — **all three
must be true before any real value is routed**:

1. **CCIP lanes enabled and each `CcipMessenger`'s registry configured.**
   `ConfigureCcip` sets chainId↔CCIP-selector, remote messengers, and the
   `vpfi-buy` + `vpfi-reward` channel peers. Confirm with `--phase
   verify` and by spot-reading `chainSelectorOf` / `remoteMessengerOf` /
   `handlerOf` / `channelPeerOf` on each `CcipMessenger`.

2. **Per-lane CCIP rate limits set on every VPFI TokenPool via
   `VpfiPoolRateGovernor`.** Starting values (design §10): **capacity
   50,000 VPFI, refill ≈ 5.8 VPFI/s** (≈ 500,000 VPFI/day). The governor
   refuses to *disable* a lane's limit and range-bounds every value
   (ET-008). `ConfigureCcip` applies these; override per chain with
   `CCIP_RATE_CAPACITY` / `CCIP_RATE_REFILL` only with a deliberate
   reason. Confirm the governor is the pool's `rateLimitAdmin`.

3. **CCT admin and every contract owner = admin multisig → timelock.**
   The CCIP `TokenAdminRegistry` administrator and every cross-chain
   contract's owner start at the admin multisig and are handed to the
   governance timelock — the *same* governance entity that owns every
   other protocol knob (§7).

---

## 7. Ownership handover (mainnet only)

Every cross-chain contract is `Ownable2Step`:

- The **proxies** (`CcipMessenger`, `VpfiPoolRateGovernor`,
  `VaipakamRewardMessenger`, `VPFIMirrorToken`, `VpfiBuyAdapter` /
  `VpfiBuyReceiver`) are initialized with the admin multisig as owner.
- The **TokenPools** are deployed by the EOA, then `transferOwnership`'d
  to the admin multisig by `DeployCrosschain`; `ConfigureCcip`'s
  `acceptOwnership()` completes that handover.

Rotating the admin multisig → governance timelock is the final step.

> **Known follow-up:** `script/Handover.s.sol` still reads LayerZero-era
> artifact keys and does **not** yet rotate the CCIP stack
> (`CcipMessenger`, the TokenPools, `VpfiPoolRateGovernor`) to
> governance. Until it is updated, the CCIP-stack timelock handover is a
> **manual multisig step** — `transferOwnership(timelock)` on each
> cross-chain contract, then `acceptOwnership()` from the timelock. Do
> not skip it: an admin-EOA-owned cross-chain contract on mainnet
> violates gate #3.

---

## 8. Post-deploy operational steps

- **Fund the `VpfiBuyReceiver` ETH float.** The cross-chain buy is two
  legs; the receiver pays leg 2's CCIP fee from a held ETH balance. Send
  ETH to the receiver via `fundETH()` after deploy — an unfunded receiver
  soft-fails leg 2 and parks the minted VPFI as stuck (recoverable via
  `retryStuckDelivery` once funded).
- **Register VPFI as a CCT** in the CCIP `TokenAdminRegistry`.
  `ConfigureCcip` does this (`registerAdminViaOwner` → `acceptAdminRole`
  → `setPool`); on mainnet it is part of the multisig batch. The token's
  `owner()` must be the broadcasting admin for `registerAdminViaOwner` to
  succeed.
- **Set the guardian** on every `GuardianPausable` contract (pass
  `CCIP_GUARDIAN`) — the detect-to-freeze fast lever.
- **Sync the consolidated deployments JSON + ABIs** to the apps —
  `bash contracts/script/exportFrontendDeployments.sh` and the typecheck
  cycle (see CLAUDE.md "Deployments sync").

---

## 9. Verification checklist

- [ ] `--phase verify` green on every chain (pool `rateLimitAdmin` =
      governor; ≥ 1 lane configured).
- [ ] Each `CcipMessenger`: `chainSelectorOf` / `remoteMessengerOf` set
      for every peer chain; `vpfi-buy` + `vpfi-reward` channels have a
      local handler and a remote peer.
- [ ] Each VPFI TokenPool: lane present for every remote chain; inbound +
      outbound rate limits enabled at the design §10 values.
- [ ] Mirror chains: `VPFIMirrorToken.tokenPool()` = the Burn/Mint pool.
- [ ] Base: `VaipakamRewardMessenger.getBroadcastDestinations()` lists
      every mirror chain id.
- [ ] VPFI registered in each chain's `TokenAdminRegistry` with the pool
      set.
- [ ] `VpfiBuyReceiver` ETH float funded.
- [ ] Mainnet: every cross-chain contract owner + the CCT admin =
      governance timelock (gate #3).

---

## 10. Incident lever

Every cross-chain contract carries `GuardianPausable` — guardian-or-owner
`pause()`, owner-only `unpause()`, on both the send and the receive path.
A paused inbound message reverts; CCIP records it as a failed message,
manually re-executable once unpaused — nothing is lost. Use
`pause-all-chains.sh` to fan the pause calldata across every chain's
Pauser Safe in parallel.
