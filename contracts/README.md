# Vaipakam Contracts

Decentralized P2P lending protocol using the EIP-2535 Diamond Standard, with
per-user UUPS escrow proxies, NFT-collateralized loans, Chainlink-priced
risk, and a **Chainlink CCIP** cross-chain layer carrying the VPFI
governance token across the supported chains.

Language: Solidity `0.8.29` (`via_ir = true`, optimizer 200 runs).
Toolchain: Foundry.

---

## Quick Start

All commands run from `contracts/`.

```bash
# Build
forge build

# Run the full test suite (840 unit tests + 23 invariants)
forge test

# Target a single file / function
forge test --match-path test/RepayFacetTest.t.sol
forge test --match-test testRepayLoan

# Traces on failure
forge test -vvv

# Gas snapshots / coverage
forge snapshot
forge coverage
```

Fuzz budget: 1000 runs. Invariant budget: 100 runs × 50k calls.

---

## Architecture (brief)

`VaipakamDiamond.sol` is the single entry point. All external calls hit its
`fallback()`, which dispatches by function selector to the appropriate facet.
Facets share storage at the deterministic slot
`keccak256("vaipakam.storage")` through `LibVaipakam.Storage`.

Cross-facet calls go through `address(this).call(...)` so they route back
through the diamond's dispatch and reach the correct facet.

Each user has an isolated UUPS escrow proxy (`ERC1967Proxy` over
`VaipakamEscrowImplementation`), deployed on-demand by `EscrowFactoryFacet`.
Collateral — ERC-20, ERC-721, ERC-1155 — never commingles.

Two liquidation paths:

1. **HF-based** (`RiskFacet`) — Health Factor < 1.0 triggers a permissionless
   0x-routed swap, liquidator takes a bonus.
2. **Time-based** (`DefaultedFacet`) — grace period expired. Liquid assets
   swap via 0x, illiquid assets transfer directly to the lender with both
   sides' consent.

---

## Repository Layout

```
contracts/
  src/
    VaipakamDiamond.sol              # Diamond proxy entry point
    VaipakamEscrowImplementation.sol # Per-user UUPS escrow logic
    facets/                          # 23 facets routed by the diamond
      DiamondCutFacet.sol            # EIP-2535 diamond surgery
      DiamondLoupeFacet.sol          # EIP-2535 introspection
      OwnershipFacet.sol             # EIP-173 owner
      AccessControlFacet.sol         # Role-based access
      AdminFacet.sol                 # Treasury + 0x proxy config
      ProfileFacet.sol               # Country/KYC state
      OracleFacet.sol                # Chainlink + v3-style concentrated-liquidity AMM liquidity
      VaipakamNFTFacet.sol           # Position NFTs (ERC721)
      EscrowFactoryFacet.sol         # Per-user escrow proxy factory
      OfferFacet.sol                 # Create/accept/cancel offers
      LoanFacet.sol                  # Loan initiation, HF/LTV gates
      RepayFacet.sol                 # Full/partial repay, late fees
      DefaultedFacet.sol             # Time-based default settlement
      RiskFacet.sol                  # HF liquidation via 0x
      ClaimFacet.sol                 # Fallback-claim collateral path
      AddCollateralFacet.sol         # Top up collateral mid-loan
      TreasuryFacet.sol              # Fee sweeps, mintVPFI gate
      EarlyWithdrawalFacet.sol       # Lender early-exit
      PartialWithdrawalFacet.sol     # Borrower partial collateral pull
      PrecloseFacet.sol              # Borrower preclose
      RefinanceFacet.sol             # Rate renegotiation
      MetricsFacet.sol               # Read-only analytics surface
      VPFITokenFacet.sol             # Bind canonical/mirror VPFI to diamond
    token/
      VPFIToken.sol                  # Canonical ERC20Capped (Base only)
      VaipakamVestingWallet.sol      # Per-recipient vesting wallet
    crosschain/                      # Provider-agnostic cross-chain layer
      ICrossChainMessenger.sol       # Provider-neutral port; domain code
                                     #   depends only on this interface
      CcipMessenger.sol              # CCIP-aware adapter (the one
                                     #   transport-layer contract)
      GuardianPausable.sol           # Two-role emergency pause base
      VPFIMirrorToken.sol            # VPFI mirror on non-canonical chains
                                     #   (stock CCIP CCT shape)
      VpfiPoolRateGovernor.sol       # Bounds-checked rate-limit admin for
                                     #   the CCIP token pools (ET-008)
      VpfiBuyAdapter.sol             # Cross-chain fixed-rate VPFI buy
                                     #   adapter (mirror side)
      VpfiBuyReceiver.sol            # Cross-chain buy receiver (Base side)
      IVpfiBuyCcipMessages.sol       # Buy-flow CCIP message shape
      VaipakamRewardMessenger.sol    # Cross-chain reward accounting
    libraries/                       # LibVaipakam, LibFacet, Lib* helpers
    interfaces/                      # IVaipakamErrors, IVPFIToken,
                                     #   IRewardMessenger, etc.
  script/                            # Forge deploy/ops scripts
  test/                              # Unit + invariant tests, mocks, helpers
  foundry.toml
  remappings.txt
```

---

## VPFI Cross-Chain Topology

Phase 1 ships VPFI as an **independent-diamond, shared-token** design:
one diamond per chain, one governance token mesh linked over Chainlink
CCIP. VPFI is registered as a CCIP **Cross-Chain Token (CCT)** — on
Base it's the canonical `VPFIToken` paired with a stock
`LockReleaseTokenPool`; on every mirror chain it's `VPFIMirrorToken`
paired with a stock `BurnMintTokenPool`. The token pools are the only
authority allowed to mint / burn / release supply on their respective
sides; CCIP's `TokenAdminRegistry` is the single source of truth for
the pool registration.

```
   ┌────────────────────────────────────────────────────────────┐
   │                       CANONICAL CHAIN                      │
   │                     (Base mainnet 8453,                    │
   │                     Base Sepolia 84532)                    │
   │                                                            │
   │   VPFIToken (ERC20Capped 230M, cap-enforced, pauseable)    │
   │       ▲                                                    │
   │       │ lock / release                                     │
   │   LockReleaseTokenPool (stock CCIP)                        │
   │   VaipakamDiamond  ─── isCanonicalVPFIChain = true         │
   └────────┼───────────────────────────────────────────────────┘
            │
            │ Chainlink CCIP messages
            │  (committing DON + executing DON +
            │   independent Risk Management Network)
            ▼
   ┌─────────────────────────┐    ┌─────────────────────────┐
   │  MIRROR CHAIN (e.g.     │    │  MIRROR CHAIN (e.g.     │
   │  Ethereum / Polygon /   │    │  Arbitrum / Optimism /  │
   │  BNB Chain)             │    │  Sepolia / Amoy)        │
   │                         │    │                         │
   │  VPFIMirrorToken        │    │  VPFIMirrorToken        │
   │     ▲ mint / burn       │    │     ▲ mint / burn       │
   │  BurnMintTokenPool      │    │  BurnMintTokenPool      │
   │  VaipakamDiamond        │    │  VaipakamDiamond        │
   │  isCanonicalVPFIChain   │    │  isCanonicalVPFIChain   │
   │    = false              │    │    = false              │
   └─────────────────────────┘    └─────────────────────────┘
```

Key properties:

- **Global cap lives on Base.** `VPFIToken.TOTAL_SUPPLY_CAP = 230M`.
  The Base `LockReleaseTokenPool` LOCKS outgoing VPFI (never burns), so
  every mirror-side VPFI is backed 1:1 by a locked VPFI in the canonical
  pool. The cap therefore bounds the entire mesh, not just Base.
- **Mirrors cannot mint locally.** `VPFIMirrorToken` only exposes mint /
  burn to its registered `BurnMintTokenPool`; the pool only mints on
  receipt of a CCIP-delivered, RMN-verified message routed through the
  canonical lane. `TreasuryFacet.mintVPFI` is additionally gated on
  `isCanonicalVPFIChain`, which is flipped true exactly once (on Base)
  by `VPFITokenFacet.setCanonicalVPFIChain`.
- **One transport-aware contract.** Domain code in `facets/` depends only
  on the provider-neutral `ICrossChainMessenger` port. The CCIP-aware
  glue lives entirely in `crosschain/CcipMessenger.sol`. Migrating to a
  different transport in the future would touch one file plus the
  registry pointer; no facet would change.
- **Per-lane rate limits.** Every token-pool lane carries a CCIP rate
  limit (capacity + refill rate) administered via
  `VpfiPoolRateGovernor`, which bounds-checks every setter (`ET-008`)
  and refuses to disable a live lane's limit.
- **Pause levers on every runtime-path contract.** `CcipMessenger`,
  `VPFIMirrorToken`, `VaipakamRewardMessenger`, `VpfiBuyAdapter`, and
  `VpfiBuyReceiver` all extend `GuardianPausable`: guardian-or-owner
  `pause()`, owner-only `unpause()`, applied on both send and receive
  paths. `VpfiPoolRateGovernor` is the rate-limit admin only — it has
  no send/receive path of its own and its setters are already
  owner-gated, so it doesn't extend the pause base.
- **Ownership model.** Every proxy's owner is expected to be a Gnosis
  Safe behind a timelock. `Ownable2StepUpgradeable` guards rotation
  with an accept step so fat-finger transfers don't brick the mesh.

---

## Deployment Guide

### Environment variables

Required by `DeployCrosschain.s.sol`:

| Var                   | Notes                                                                                  |
|-----------------------|----------------------------------------------------------------------------------------|
| `DEPLOYER_PRIVATE_KEY`| Broadcaster key                                                                        |
| `ADMIN_ADDRESS`       | Owner of every deployed proxy                                                          |
| `CCIP_ROUTER`         | Chainlink CCIP `Router` on this chain (immutable on `CcipMessenger`)                  |
| `CCIP_RMN_PROXY`      | Chainlink CCIP `RMNProxy` on this chain (passed to the token-pool constructor)         |
| `BASE_CHAIN_ID`       | Mirror chains only — EVM chain id of canonical Base for reward + buy flow targeting   |
| `TREASURY_ADDRESS`    | Mirror chains only — local treasury for the buy adapter                                |
| `VPFI_BUY_PAYMENT_TOKEN`  | Optional, mirror chains — `0x0` for native gas (default); bridged WETH address on chains where native gas isn't ETH-priced (BNB / Polygon mainnet — see CLAUDE.md "VPFIBuyAdapter payment-token mode") |
| `VPFI_BUY_REFUND_TIMEOUT` | Optional, mirror chains — seconds before a stuck cross-chain buy can be refunded (default 900)                              |
| `CCIP_DEST_GAS_LIMIT` | Optional — cross-chain callback gas, default 400_000                                   |

`DeployCrosschain` reads the diamond and (on canonical chains) the
`VPFIToken` proxy addresses from the per-chain
`deployments/<chain>/addresses.json` written by earlier deploy steps;
they are NOT passed via env.

Required by `ConfigureCcip.s.sol`:

| Var                                | Notes                                                                                |
|------------------------------------|--------------------------------------------------------------------------------------|
| `ADMIN_PRIVATE_KEY`                | The admin key (owner of every deployed proxy + the TokenPool's pending owner)        |
| `CCIP_TOKEN_ADMIN_REGISTRY`        | Chainlink `TokenAdminRegistry` on this chain                                          |
| `CCIP_REGISTRY_MODULE_OWNER_CUSTOM`| Chainlink `RegistryModuleOwnerCustom` on this chain (the CCT owner-based registrar)  |
| `CCIP_LANE_CHAIN_IDS`              | Comma-separated EVM chain ids of every REMOTE chain to wire a TokenPool lane to       |
| `BASE_CHAIN_ID`                    | Mirror chains only — the hub the buy / reward channels peer with                      |
| `CCIP_GUARDIAN`                    | Optional — guardian address set on every `GuardianPausable` contract (default unset)  |
| `CCIP_RATE_CAPACITY`               | Optional — per-lane token-bucket capacity (default 50,000 VPFI, design §10)           |
| `CCIP_RATE_REFILL`                 | Optional — per-lane refill rate, VPFI/s (default 5.8 VPFI/s, design §10)              |

`ConfigureCcip` reads every deployed-contract address from the
per-chain artifacts `DeployCrosschain` wrote; only the env above is
operator-supplied.

### Step 1 — Deploy a diamond on each chain

Once per chain (Base, Ethereum, Polygon, Arbitrum, Optimism + their testnets):

```bash
forge script script/DeployDiamond.s.sol:DeployDiamond \
  --rpc-url $RPC_URL \
  --broadcast --verify
```

`DeployDiamond` deploys every facet, the `VaipakamDiamond` proxy, and
cuts every facet in one broadcast. It writes the diamond proxy address
to `deployments/<chain>/addresses.json` — the same artifact every
subsequent script reads from. Canonical-chain `VPFIToken` deployment
is operator-driven, lives in the per-chain deploy procedure as a
prerequisite step before `DeployCrosschain` runs, and is recorded in
the same artifact (`vpfiToken` field). `DeployDiamond` itself does not
deploy `VPFIToken`.

### Step 2 — Deploy the cross-chain layer

Run on every chain — Base + every mirror. The single
`DeployCrosschain.s.sol` script forks on a canonical-vs-mirror flag
(`block.chainid ∈ {8453, 84532}` ⇒ canonical) so the same broadcast
deploys the right contracts for each chain.

```bash
# every chain
export DEPLOYER_PRIVATE_KEY=<broadcaster>
export ADMIN_ADDRESS=<owner of every proxy>
export CCIP_ROUTER=<local CCIP Router>
export CCIP_RMN_PROXY=<local CCIP RMNProxy>

# mirror-chain-only env additions
export BASE_CHAIN_ID=<EVM chain id of canonical Base>
export TREASURY_ADDRESS=<local treasury for the buy adapter>

forge script script/DeployCrosschain.s.sol:DeployCrosschain \
  --rpc-url $RPC_URL \
  --broadcast --verify
```

What this does in one broadcast — chain-dependent:

**On every chain (canonical or mirror):**

1. Deploy `CcipMessenger` impl + `ERC1967Proxy` — the one CCIP-aware
   contract that fronts every send / receive path (router is immutable
   on the impl).
2. Deploy the VPFI CCIP `TokenPool` (LockRelease on canonical,
   BurnMint on mirrors) and transfer pending ownership to `ADMIN_ADDRESS`
   (the pool is `Ownable2Step`; the handover is accepted in step 3).
3. Deploy `VpfiPoolRateGovernor` impl + `ERC1967Proxy` initialized with
   the pool address — the bounds-checked rate-limit admin.
4. Deploy `VaipakamRewardMessenger` impl + `ERC1967Proxy` initialized
   with the messenger, diamond, canonical flag, `BASE_CHAIN_ID` (zero
   on canonical), and the destination gas limit.

**On the canonical chain (Base) only:**

- The token pool is the stock CCIP `LockReleaseTokenPool` bound to the
  pre-existing canonical `VPFIToken` (read from
  `deployments/<chain>/addresses.json`; deploy the token in the
  operator step that precedes this script).
- Deploy `VpfiBuyReceiver` impl + `ERC1967Proxy` — the receiver side
  of the cross-chain fixed-rate VPFI buy flow.

**On a mirror chain only:**

- Deploy `VPFIMirrorToken` impl + `ERC1967Proxy` (`initialize(admin)`)
  — the local mirror VPFI ERC20. Token-pool wiring on the mirror token
  itself (`setTokenPool`) happens in `ConfigureCcip`, not here.
- The token pool is the stock CCIP `BurnMintTokenPool` bound to the
  fresh mirror token.
- Deploy `VpfiBuyAdapter` impl + `ERC1967Proxy` — the sender side of
  the cross-chain VPFI buy flow.

`VPFITokenFacet.setVPFIToken(...)` and
`VPFITokenFacet.setCanonicalVPFIChain(true)` are operator actions
done outside this script (the canonical Base configuration runbook
calls them once `DeployCrosschain` has settled and the addresses
are recorded). `DeployCrosschain` itself does NOT touch the
diamond's token-binding state.

Addresses use regular `new ERC1967Proxy(...)` deployment — non-
deterministic. The per-chain `deployments/<chain>/addresses.json`
is the canonical record of every deployed address.

### Step 3 — Configure CCIP lanes + token pools

After Step 2 has run on every chain, run `ConfigureCcip.s.sol` to
register chain-selector maps, remote-messenger peers, the buy +
reward channels, per-lane rate limits, and register the token pool
with the local `TokenAdminRegistry`.

```bash
# env (per chain pair you're wiring)
export DIAMOND_ADDRESS=<local diamond>
export CCIP_TOKEN_ADMIN_REGISTRY=<local TokenAdminRegistry>
export LOCAL_CHAIN_SELECTOR=<local CCIP selector>
export REMOTE_CHAIN_SELECTOR=<remote CCIP selector>
export REMOTE_MESSENGER=<remote CcipMessenger proxy>
export REMOTE_POOL=<remote token pool>

forge script script/ConfigureCcip.s.sol:ConfigureCcip \
  --rpc-url $LOCAL_RPC --broadcast
```

The script is idempotent and `ADMIN`-broadcast. For each chain it
configures:

- `CcipMessenger`: `setChainSelector`, `setRemoteMessenger`,
  `registerChannel` for the `vpfi-buy` + `vpfi-reward` flows,
  `setChannelPeer`, `setGuardian`.
- `VPFIMirrorToken.setTokenPool(burnMintPool)` on mirrors (the mirror
  token only accepts mint / burn from its registered pool).
- `VpfiPoolRateGovernor.setLaneRateLimits` per lane — Phase 1 starting
  values: capacity 50,000 VPFI, refill ≈5.8 VPFI/s. The governor
  refuses to disable a lane's limit and bounds every value (ET-008).
- `VaipakamRewardMessenger.setBroadcastDestinations([mirror chain ids])`
  — Base only; the canonical messenger broadcasts the finalized daily
  global denominator to every mirror.
- Register each token pool with CCIP `TokenAdminRegistry` via
  `RegistryModuleOwnerCustom`. Admin is the deploy multisig at this
  stage; rotates to the timelock at the handover step.

Run `ConfigureCcip` once per (local, remote) chain pair; the wiring
is symmetric so each ordered pair `(A → B)` and `(B → A)` gets one
run.

**Anvil rehearsal**: the same scripts can be exercised end-to-end on
a local anvil via `script/RehearseCcipAnvil.s.sol`, which stands up
two logical chains via `chainlink-local`'s `CCIPLocalSimulator` and
drives all three flows (VPFI CCT transfer, the buy-flow two-step
release, and the reward REPORT / BROADCAST round-trip). The
rehearsal pre-deploys CCIP `Router` + a local `TokenAdminRegistry`
in-harness, so the CCT pool-registration path is exercised the same
way it will be on testnet / mainnet.

### Step 4 — Rotate `minter` to the diamond

Once the canonical deploy has settled and the treasury has its 23M, the
owner rotates mint authority from the treasury safe onto the Base
`VaipakamDiamond` so `TreasuryFacet.mintVPFI` can issue emissions:

```solidity
// Executed by VPFIToken owner (timelock/multi-sig)
vpfiToken.setMinter(address(baseDiamond));
```

After this, only the diamond — via `TreasuryFacet.mintVPFI`, which itself
is role-gated — can mint, and only on Base. On every other chain
`isCanonicalVPFIChain` is false, so the mint gate short-circuits.

---

## Cross-Chain Security (CCIP)

Vaipakam's cross-chain layer runs on **Chainlink CCIP** — T-068 migrated
it off LayerZero. CCIP is operated by Chainlink: a committing DON, an
executing DON, and an independent **Risk Management Network** (separate
codebase + operators) that re-verifies every committed message. Security
is uniform for every integrator — there is no DVN set to choose or
configure and no insecure default. The LayerZero "1-required /
0-optional DVN" footgun — the shape the April 2026 ~$292M Kelp bridge
exploit rode — does not exist here.

The cross-chain contracts live in `src/crosschain/` behind the
provider-agnostic `ICrossChainMessenger` port; `CcipMessenger` is the
only CCIP-aware contract. VPFI moves as a CCIP **Cross-Chain Token**
(`VPFIMirrorToken` + the stock `LockReleaseTokenPool` / `BurnMintTokenPool`).

Mainnet-deploy gates, the per-lane rate-limit policy (`VpfiPoolRateGovernor`),
and the `GuardianPausable` pause levers are documented in the
"Cross-Chain Security Policy (CCIP)" section of the repo-root `CLAUDE.md`.
Full design:
[`docs/DesignsAndPlans/LayerZeroToChainlinkCcipMigration.md`](../docs/DesignsAndPlans/LayerZeroToChainlinkCcipMigration.md).

## VPFI Cross-Chain Token (CCT) Bridging Flow

The user-facing entry point on every chain is the CCIP `Router.ccipSend`
call (typically reached via the CCT-aware aggregator UI). Locally the
`crosschain/` contracts only configure pools + register tokens with the
`TokenAdminRegistry` — the lock / burn / release / mint accounting
itself is the stock CCIP token-pool path.

**Outbound (Base → mirror chain)**

1. User approves the canonical `LockReleaseTokenPool` for `N` VPFI on
   Base via the CCIP UI / SDK.
2. User calls `Router.ccipSend(destChainSelector, message)` with `N`
   VPFI in the `tokenAmounts` payload.
3. CCIP lifts `N` VPFI from the user into the canonical token pool —
   the pool LOCKS them (does not burn).
4. CCIP commits the message via the committing DON; the Risk Management
   Network re-verifies on its independent codebase; the executing DON
   delivers the message on the destination side.
5. The destination `BurnMintTokenPool` MINTS `N` VPFIMirrorToken to the
   recipient (since `VPFIMirrorToken` only allows mint by its
   registered pool).

**Inbound (mirror chain → Base)**

1. User approves the local `BurnMintTokenPool` for `N` VPFIMirrorToken.
2. User calls `Router.ccipSend(baseChainSelector, message)`.
3. The mirror pool BURNS `N` VPFIMirrorToken locally.
4. CCIP commits + RMN-verifies + delivers on Base.
5. The canonical `LockReleaseTokenPool` RELEASES `N` VPFI from its
   locked holdings to the recipient.

Mesh-wide supply invariant at any instant:

```
mirror_totalSupply[chain_1] + mirror_totalSupply[chain_2] + ... +
    canonical_balance_of(lockReleasePool) ==
    canonical_totalSupply  <=  TOTAL_SUPPLY_CAP (230M)
```

In-flight CCIP messages count as "locked on source / not yet minted on
destination", so the invariant holds across the message-pending window.

**Failure model**: a paused contract's inbound CCIP message reverts;
CCIP records it as a failed message, manually re-executable once the
contract is unpaused. Nothing is lost — the lock / burn on the sender
side remains, the destination mint executes on retry. Same shape for
the buy-flow and reward-flow channels which are routed through
`CcipMessenger` on top of the same Router.

---

## Core Protocol Config

All in `LibVaipakam.sol` — treat as audit-reviewed constants, not knobs.

| Constant                         | Value       | Meaning                                                 |
|----------------------------------|-------------|---------------------------------------------------------|
| `MIN_HEALTH_FACTOR`              | `1.5e18`    | Minimum HF at loan initiation                           |
| `TREASURY_FEE_BPS`               | `100`       | 1% treasury cut on accrued interest                     |
| `KYC_TIER0_THRESHOLD_USD`        | `1000e18`   | Tier-0 cap (unverified wallets). Loans ≥ this need Tier-1 |
| `KYC_TIER1_THRESHOLD_USD`        | `10000e18`  | Tier-1 cap (email / light KYC). Loans ≥ this need Tier-2  |
| `RENTAL_BUFFER_BPS`              | `500`       | 5% prepay buffer on NFT rentals                         |
| `VOLATILITY_LTV_THRESHOLD_BPS`   | `11000`     | 110% LTV collapse trigger                               |
| `BASIS_POINTS`                   | `10000`     | BPS denominator                                         |
| `HF_SCALE`                       | `1e18`      | HF fixed-point scale                                    |

VPFI tokenomics constants (in `VPFIToken.sol`):

| Constant             | Value               |
|----------------------|---------------------|
| `TOTAL_SUPPLY_CAP`   | `230_000_000 * 1e18`|
| `INITIAL_MINT`       | `23_000_000 * 1e18` |
| Name / symbol / dec  | "Vaipakam DeFi Token" / `VPFI` / `18` |

---

## Script Reference

| Script                             | Purpose                                                         |
|------------------------------------|-----------------------------------------------------------------|
| `DeployDiamond.s.sol`              | Deploy diamond + every facet, run the initial cut               |
| `DeployCrosschain.s.sol`           | Deploy the cross-chain layer for this chain (CcipMessenger + token-side contracts + buy adapter/receiver + reward messenger + rate governor) — auto-forks on canonical-vs-mirror by `block.chainid` |
| `ConfigureCcip.s.sol`              | Wire chain selectors, remote messengers, channels, per-lane rate limits, and `TokenAdminRegistry` pool registration |
| `ConfigureRewardReporter.s.sol`    | Bind the reward messenger to the diamond + register the canonical chain id |
| `ConfigureVPFIBuy.s.sol`           | Diamond-side cross-chain VPFI buy params (rate, caps, payment token mode) |
| `RehearseCcipAnvil.s.sol`          | End-to-end anvil rehearsal: VPFI CCT transfer + buy flow + reward round-trip via `CCIPLocalSimulator` |
| `RedeployFacets.s.sol`             | Redeploy specific facets and cut them in (surgical upgrade)     |
| `ReplaceStaleFacets.s.sol`         | Replace facets whose selectors have drifted                     |
| `UpgradeOracleFacet.s.sol`         | Swap the OracleFacet implementation                             |
| `AddKeeperSelectors.s.sol`         | Grant keeper selector access                                    |
| `CheckSelectors.s.sol`             | Diff the diamond's live selector map vs. local facet bytecode   |
| `SepoliaActiveLoan.s.sol`          | Testnet scenario: stand up an active loan                       |
| `SepoliaPositiveFlows.s.sol`       | Testnet scenario: happy-path end-to-end flows                   |

---

## Conventions

- Rates / fees in **basis points** (BPS, denominator 10000).
- Health Factor and USD values scaled to **1e18**.
- Facets use `ReentrancyGuard` + `Pausable` (OZ).
- ERC20 transfers use `SafeERC20`.
- Custom errors, not revert strings.
- Events declare indexed parameters for off-chain filtering.
- **Storage layout is append-only** on `LibVaipakam.Storage` post-launch —
  reordering or removing fields is forbidden.

---

## Foundry Basics

```bash
forge build                 # compile
forge test                  # all tests
forge test -vvv             # traces on failure
forge snapshot              # gas deltas
forge coverage              # line coverage
forge fmt                   # formatter
anvil                       # local node
cast <subcommand>           # EVM CLI
```

Full Foundry docs: <https://book.getfoundry.sh/>
