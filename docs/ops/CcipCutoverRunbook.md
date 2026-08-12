# CCIP Cross-Chain Cutover Runbook

> Tracked under the post-T-087 operator-activation umbrella card
> [#492](https://github.com/vaipakam/vaipakam/issues/492) as item
> A.2 (T-068 Stage 2). The umbrella is the single-stop index for
> every operator-gated activation step.

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

Pass-2 order across chains is free — every step reads only pass-1
artifacts. (#1568 C2: the repatriation lane-capacity bounds resolve
registry → active pool → lane membership → limiter bucket LIVE at
issuance/execution; the only repatriation wiring in pass 2 is
`setRepatriationTokenAdminRegistry`, so nothing per-lane has to be
derived, recorded, or ordered, and a CCT pool rotation auto-tracks.)

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
2. **Wire** every mainnet chain once all are deployed (any order):
   ```
   CCIP_LANE_CHAIN_IDS=<remote chain ids> \
     bash contracts/script/deploy-mainnet.sh <chain-slug> --phase ccip-wire
   ```
3. **Verify** every chain (`--phase verify`). On every chain
   additionally confirm the Diamond's repatriation registry is wired —
   `cast call $DIAMOND 'getRepatriationTokenAdminRegistry()(address)'`
   must return that chain's CCIP TokenAdminRegistry, not zero (the
   live lane-capacity bounds resolve the active pool through it;
   unset = repatriation stays dark) — the automated verify phase does
   not read this (same known limit as the per-lane limiter configs).
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

### Rotation: outstanding compensations must survive the cutover (#1434 P2-w6)

Before retiring a canonical Base deployment, read
`getCompensationOutstandingChains()` on it. For every chain listed, either
settle the compensation first (consumption ack, stranded return, or
recovery ceremony + terminal loss), or carry it over to the new
deployment. No unresolved compensation may be silently forgotten by a
redeploy.

**Carrying one over.** On the NEW deployment, run
`importOutstandingCompensation(chain, oldDeployment, oldRemitId,
quarantineObserved)` for each open tuple.

- Read the tuple from the retiring deployment's `getImportedOutstanding`
  when that deployment was ITSELF holding a carried-over gate. Its visible
  `getCompensationOutstanding` reads a sentinel in that case, and
  importing the sentinel is refused — no old-era acknowledgement could
  ever match it.
- Carry `quarantineObserved` across. Dropping it would turn a mirror's
  already-observed quarantine-then-consumed contradiction back into a
  clean consumption on the new deployment.
- Each tuple may be imported exactly once.

The import carries no figures about the parcel, and needs none: settling a
carried-over gate creates no spending capacity, so there is nothing a
wrong figure could inflate. A mistaken import therefore costs only
availability on the one chain it names — new compensation is blocked there
until the settlement runs — and never value.

**Resolving it.** The carried gate blocks new compensation for that chain
until the operator settles it with
`clearImportedOutstanding(chain, recycledInflow)`. That is the ONLY way it
opens.

There is deliberately no permissionless path. A mistyped import can name
an unrelated, already-consumed historical receipt, and if that receipt's
re-presented acknowledgement could release the gate, you would then fund a
replacement while the genuinely outstanding delivery was still live — both
would back mirror claims. A re-presented old-era acknowledgement is
therefore refused outright (`RemitAckSenderMismatch`); do not wait for
one.

On settlement the recycled component re-enters bucket custody — the call
asserts those tokens are actually present — and any fresh component simply
remains in ordinary custody. Pass `0` when nothing came home.

**Funding the replacement.** Use the ordinary CHARGED path
(`remitManualBudget`), not a from-recovery dispatch. The new deployment's
lifetime budget counter starts at zero and never charged for the old
parcel, so charging it now is the correct accounting rather than a double
charge.

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

### Changing lane rate limits after deployment (#1568 C2)

The repatriation bounds need **no coupled ceremony**: authorize reads
the canonical pool's INBOUND limiter and execute reads the mirror
pool's OUTBOUND limiter LIVE, so a capacity change through
`VpfiPoolRateGovernor.setLaneRateLimits` binds new authorizations and
executions the moment it lands — there is no recorded ceiling to
update, on either chain, and nothing to keep in sync across timelocks.

What a capacity change DOES require is attention to work already in
flight, in this order when **lowering**:

1. **Before lowering a canonical INBOUND capacity**, retire EVERY
   repatriation authorization above the proposed value that is not yet
   SETTLED — not only the in-flight ones (Codex #1618 r7): the mirror's
   execute checks only its OUTBOUND capacity, so an oversized
   authorization still PENDING (or whose instruction is undispatched)
   remains executable by anyone AFTER the inbound is lowered, and its
   return would then fail delivery permanently. Concretely, for each
   authorization with `getRepatriationAuthorization` status 1 and
   amount above the proposed capacity:
   - mirror instruction state 0/1 (never arrived / pending):
     `requestRepatriationCancel` and WAIT for the ACK to land
     (status 3, draw released);
   - mirror instruction state 2 (executed, return in flight): WAIT for
     settlement (status 2) — an in-flight message that exceeds the new
     inbound capacity fails delivery PERMANENTLY (a single
     over-capacity request is rejected, never queued), and the mirror's
     executed marker is irreversible, so cancellation could never
     produce an ACK and the draw would stay charged until governance
     re-raises the lane. The same in-flight caution applies to every
     VPFI token message class — reward remits and buyback remits share
     the pools.
   Only when no unsettled authorization above the proposed value
   remains, lower the capacity.
2. **Lowering a mirror OUTBOUND capacity** is self-healing for
   not-yet-executed instructions: `executeRepatriation` re-checks the
   live limiter BEFORE its one-shot marker, so an instruction above
   the new value fails retryably and the canonical side releases the
   draw through the normal cancellation ceremony. Drain or cancel
   any such pending authorizations at your convenience.
3. **Raising** a capacity needs nothing: the live bounds simply accept
   larger amounts from that moment.

### Rotating a Diamond or a pool under in-flight repatriations

- **CCT pool rotation** (`TokenAdminRegistry.setPool`) needs no
  repatriation step: the bounds resolve the ACTIVE pool through the
  registry at every check (#1618 r7). Mind only the in-flight caution
  above if the replacement pool's capacities are lower.
- **Canonical Diamond rotation** (`VpfiReturnReceiver.setDiamond`, and
  the same for the reward/buyback remittance receivers): DRAIN FIRST.
  A delayed return or cancellation ACK delivered after the rotation
  still names the old issuing Diamond and is refused by the new one
  (`RepatriationWrongEra` — the era binding doing its job), leaving the
  delivery failed-but-re-executable against a target that will never
  accept it. Settle or cancel-and-ACK every PENDING authorization
  before pointing the receiver at a new Diamond; this is the standing
  receiver-rotation precondition shared by every remittance receiver,
  not a repatriation-specific rule.
- **Reward-broadcast era rotation** (#1434 P2-w1, Codex #1632 r2) —
  when the canonical Base DIAMOND rotates, every mirror's V3-broadcast
  era ground truth rotates with it, in this order:
  1. **Drain the old era's broadcasts first**: let (or force) every
     in-flight kind-5/kind-10 delivery from the old Base land — or
     accept their loss — BEFORE step 2. Order matters because step 2
     is one-way. **Also heal every era-UNKNOWN day now** (#1632 r3):
     days applied before the mirror's first arming carry no era
     provenance, and a rotated mirror permanently refuses to attach V3
     clock facts to them (it can no longer tell which era supplied
     their figures) — run `broadcastGlobalTo(dayId, mirror)` for each
     while the old era is still current, or accept them staying
     clockless forever.
  2. On every mirror: `RewardReporterFacet.setBaseRewardDeployment(newBaseDiamond)`.
     A second, DIFFERENT nonzero value is detected as a rotation and
     **permanently retires the legacy broadcast wires' fresh applies**
     on that mirror (`LegacyBroadcastRetired`): kind-5/kind-2 packets
     carry no deployment identity, so after a rotation a retired era's
     delayed or manually re-executed delivery cannot be told apart
     from a legitimate one — only the V3 wire (which authenticates its
     era) keeps applying fresh days. Replays of already-applied days
     stay idempotent.
  3. Days whose figures were applied under the OLD era keep their
     recorded era (the apply-time provenance stamp) and refuse
     new-era V3 backfills (`BroadcastEraMismatch`) — cross-era
     combination is the exact state-poisoning this blocks. Such days
     are the drain/heal ceremony's job, not silent overwrite.
  The first arming (zero → nonzero) is NOT a rotation; a disarm/re-arm
  cycle of the same address is not one either.
- **Mirror-era registry on Base** (#1434 P2-w3, Codex #1636 r2/r3) —
  the RECIPROCAL registration: Base's compensation-quote (kind-11)
  ingress authenticates every arriving quote's sending-Diamond word
  against `RewardCommitmentFacet.setMirrorRewardDeployment(chainId,
  mirrorDiamond)` and is FAIL-CLOSED per chain until that registration
  exists (`CompQuoteMirrorEraUnset`; deliveries stay failed-but-
  re-executable).
  1. **Initial setup** — register every mirror's Diamond on Base as
     part of the reward-mesh configuration.
     `ConfigureRewardReporter.s.sol` does this on canonical chains from
     `MIRROR_REWARD_DEPLOYMENTS` (format
     `"42161:0xMirrorDiamond,10:0xMirrorDiamond"`); leaving it unset
     logs a loud warning and leaves zeroed-day compensation quoting
     unreachable for the unregistered lanes.
  1b. **Lapse-terminal arming (constraint-19, #1656 r2)** — the two
     permissionless lapse terminals ship DARK
     (`LapseTerminalsNotArmed`). Per mirror, arm them
     (`RewardCommitmentFacet.armLapseTerminals`, ADMIN, one-shot) ONLY
     after: (a) Base's `getLegacyManualReservations` pages read EMPTY
     over the full id range (Pending hits released or resolved), and
     (b) every delivered legacy receipt was stamped mirror-side
     (`stampLegacyCompensation`) and any pre-w4 funded day seeded
     Base-side (`seedCompFunded`, at the RECEIVED figure for
     short-ACKed deliveries). The arm is the checklist's on-chain
     attestation — an upgrade window's expired days cannot be lapsed
     out from under an unstamped legacy delivery.
  2. **When a MIRROR Diamond rotates**: on Base, run
     `setMirrorRewardDeployment(chainId, newMirrorDiamond)`, then
     `clearCompQuote(dayId, chainId)` for any NONZERO quote still
     standing under the retired mirror. Two record classes refuse the
     clear by design (#1636 r4): funded days (their standing quote is
     the receipt-bound obligation) and RESOLVED-ZERO records
     (`CompQuoteResolvedZeroFinal` — the (0,0) ingress already retired
     the day's funding anchor, the day is terminally zero, and a
     re-quote under any era is deterministically (0,0) again; the
     record stays as the receipt). The new era then re-quotes the
     cleared days permissionlessly from the mirror side.

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
