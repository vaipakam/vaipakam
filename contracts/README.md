# Vaipakam Contracts

Decentralized P2P lending protocol using the EIP-2535 Diamond Standard, with
per-user UUPS escrow proxies, NFT-collateralized loans, Chainlink-priced
risk, and a LayerZero OFT V2 cross-chain governance token (VPFI).

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
      OracleFacet.sol                # Chainlink + Uniswap v3 liquidity
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
      VPFIMirror.sol                 # Pure OFT V2 on mirror chains
      VPFIOFTAdapter.sol             # Canonical-side OFT adapter (Base)
    libraries/                       # LibVaipakam, LibFacet, Lib* helpers
    interfaces/                      # IVaipakamErrors, IVPFIToken, etc.
  script/                            # Forge deploy/ops scripts
  test/                              # Unit + invariant tests, mocks, helpers
  foundry.toml
  remappings.txt
```

---

## VPFI Cross-Chain Topology

Phase 1 ships VPFI as an **independent-diamond, shared-token** design:
one diamond per chain, one governance token mesh linked over LayerZero
OFT V2.

```
   ┌────────────────────────────────────────────────────────────┐
   │                       CANONICAL CHAIN                      │
   │                     (Base mainnet 8453,                    │
   │                     Base Sepolia 84532)                    │
   │                                                            │
   │   VPFIToken (ERC20Capped 230M, cap-enforced, pauseable)    │
   │   VPFIOFTAdapter ◀────┐                                    │
   │        │              │  setPeer(eid, mirror)              │
   │   VaipakamDiamond     │  isCanonicalVPFIChain = true       │
   └────────┼──────────────┘                                    │
            │                                                   │
            │ LayerZero V2 messages (DVN-verified)              │
            ▼                                                   │
   ┌─────────────────────────┐    ┌─────────────────────────┐   │
   │  MIRROR CHAIN (e.g.     │    │  MIRROR CHAIN (e.g.     │   │
   │  Ethereum / Polygon /   │    │  Arbitrum / Optimism)   │   │
   │  Sepolia / Amoy)        │    │                         │   │
   │                         │    │                         │   │
   │  VPFIMirror (pure OFT,  │    │  VPFIMirror             │   │
   │    no cap, no mint API) │    │                         │   │
   │  VaipakamDiamond        │    │  VaipakamDiamond        │   │
   │  isCanonicalVPFIChain   │    │  isCanonicalVPFIChain   │   │
   │    = false              │    │    = false              │   │
   └─────────────────────────┘    └─────────────────────────┘   │
```

Key properties:

- **Global cap lives on Base.** `VPFIToken.TOTAL_SUPPLY_CAP = 230M`.
  Because the canonical adapter LOCKS outgoing VPFI (never burns), every
  mirrored VPFI is backed 1:1 by a locked VPFI in the adapter. The cap
  therefore bounds the entire mesh, not just Base.
- **Mirrors cannot mint locally.** `VPFIMirror` is a pure OFT — the only
  supply entry point is `_credit` from an authenticated LayerZero message
  from an authorized peer. `TreasuryFacet.mintVPFI` is additionally gated
  on `isCanonicalVPFIChain`, which is flipped true exactly once (on Base)
  by `VPFITokenFacet.setCanonicalVPFIChain`.
- **Ownership model.** Every proxy's owner is expected to be a Gnosis Safe
  behind a timelock. `Ownable2StepUpgradeable` guards rotation with an
  accept step so fat-finger transfers don't brick the mesh.

---

## Deployment Guide

### Environment variables

Shared across scripts:

| Var                   | Used by                                         | Notes                                                    |
|-----------------------|-------------------------------------------------|----------------------------------------------------------|
| `PRIVATE_KEY`         | all scripts                                     | Broadcaster key                                          |
| `ADMIN_ADDRESS`       | `DeployDiamond`                                 | Receives `ADMIN_ROLE` on the diamond                     |
| `TREASURY_ADDRESS`    | `DeployDiamond`                                 | Initial treasury recipient                               |
| `DIAMOND_ADDRESS`     | `DeployVPFICanonical`, `DeployVPFIMirror`       | Per-chain diamond proxy                                  |
| `VPFI_OWNER`          | `DeployVPFICanonical`, `DeployVPFIMirror`       | Timelock/multi-sig owning the token / mirror / adapter   |
| `VPFI_TREASURY`       | `DeployVPFICanonical`                           | Recipient of the 23M (10%) initial mint                  |
| `VPFI_INITIAL_MINTER` | `DeployVPFICanonical`                           | First `minter` — typically the treasury safe             |
| `LZ_ENDPOINT`         | `DeployVPFICanonical`, `DeployVPFIMirror`       | LayerZero EndpointV2 on the target chain                 |
| `LOCAL_OAPP`          | `WireVPFIPeers`                                 | Local adapter OR mirror proxy                            |
| `REMOTE_EID`          | `WireVPFIPeers`                                 | LayerZero endpoint id of the remote chain                |
| `REMOTE_PEER`         | `WireVPFIPeers`                                 | Remote adapter/mirror address (cast to bytes32 in-script)|

### Step 1 — Deploy a diamond on each chain

Once per chain (Base, Ethereum, Polygon, Arbitrum, Optimism + their testnets):

```bash
forge script script/DeployDiamond.s.sol:DeployDiamond \
  --rpc-url $RPC_URL \
  --broadcast --verify
```

`DeployDiamond` deploys all 23 facets, the `VaipakamDiamond`, and cuts every
facet in one broadcast. Logs the diamond proxy address — save it into the
per-chain `DIAMOND_ADDRESS` env for the next step.

### Step 2 — Canonical VPFI deploy (Base only)

Runs **once across the whole mesh**, only on Base mainnet or Base Sepolia:

```bash
# env
export DIAMOND_ADDRESS=<base diamond>
export VPFI_OWNER=<timelock-safe>
export VPFI_TREASURY=<treasury-safe>
export VPFI_INITIAL_MINTER=<treasury-safe>   # rotate to diamond later
export LZ_ENDPOINT=<base LZ EndpointV2>

forge script script/DeployVPFICanonical.s.sol:DeployVPFICanonical \
  --rpc-url $BASE_RPC \
  --broadcast --verify
```

What this does in a single broadcast:

1. Deploy `VPFIToken` impl + `ERC1967Proxy`, calling `initialize(owner,
   treasury, initialMinter)` which mints the 23M initial supply to
   `VPFI_TREASURY`.
2. Deploy `VPFIOFTAdapter` impl + `ERC1967Proxy` bound to the token proxy
   and the Base LayerZero endpoint.
3. `VPFITokenFacet.setVPFIToken(vpfi)` — register the token on the diamond.
4. `VPFITokenFacet.setCanonicalVPFIChain(true)` — enable
   `TreasuryFacet.mintVPFI` on this chain (and nowhere else).

### Step 3 — Mirror deploy (each non-canonical chain)

Run **once per mirror chain**, after that chain's diamond is live:

```bash
# env
export DIAMOND_ADDRESS=<local diamond>
export VPFI_OWNER=<local timelock-safe>
export LZ_ENDPOINT=<local LZ EndpointV2>

forge script script/DeployVPFIMirror.s.sol:DeployVPFIMirror \
  --rpc-url $LOCAL_RPC \
  --broadcast --verify
```

What this does:

1. Deploy `VPFIMirror` impl + `ERC1967Proxy`, calling `initialize(owner)`.
2. `VPFITokenFacet.setVPFIToken(mirror)` — register on the local diamond.
3. **Leaves `isCanonicalVPFIChain = false`.** The mint gate in
   `TreasuryFacet.mintVPFI` therefore reverts with `NotCanonicalVPFIChain`
   on this chain.

### Step 4 — Wire the OFT peer mesh

OFT V2 peers are symmetric: for each ordered pair `(A → B)` and `(B → A)`
the owner wallet must call `setPeer` on the local OApp pointing at the
remote one.

For each chain pair, run `WireVPFIPeers` on both sides with values swapped.
Example: connect Base Sepolia adapter to Polygon Amoy mirror.

```bash
# On Base Sepolia (owner runs with the adapter's owner key)
LOCAL_OAPP=<base-sepolia adapter proxy> \
REMOTE_EID=<amoy eid> \
REMOTE_PEER=<amoy mirror proxy> \
forge script script/WireVPFIPeers.s.sol:WireVPFIPeers \
  --rpc-url $BASE_SEPOLIA_RPC --broadcast

# On Polygon Amoy (owner runs with the mirror's owner key)
LOCAL_OAPP=<amoy mirror proxy> \
REMOTE_EID=<base-sepolia eid> \
REMOTE_PEER=<base-sepolia adapter proxy> \
forge script script/WireVPFIPeers.s.sol:WireVPFIPeers \
  --rpc-url $AMOY_RPC --broadcast
```

Run both directions for every pair in the mesh (`adapter ↔ each mirror`,
plus `mirror ↔ each other mirror` if mirror-to-mirror direct sends are
desired; otherwise mirrors can route through the canonical adapter).

**Owner-only extras** (outside the scripts, via the owner wallet / Safe):

- Register DVNs and the executor (OApp `setConfig`).
- Set enforced options so all outbound sends pay enough gas on the
  destination side.
- Set a delegate (`OAppCore.setDelegate`) if operational control should
  differ from ownership.

### Step 5 — Rotate `minter` to the diamond

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

## Cross-Chain Security (Mandatory Pre-Mainnet Hardening)

Every LayerZero-facing contract in this repo — `VPFIOFTAdapter`,
`VPFIMirror`, `VPFIBuyAdapter`, `VPFIBuyReceiver`, `VaipakamRewardOApp` —
ships with the `OApp`/`OFT` defaults. **LayerZero's default configuration
is 1-required / 0-optional DVN**, which was the root-cause shape of the
April 2026 Kelp DAO exploit ($290M). A mainnet deploy that inherits the
defaults is not acceptable.

Before routing any real value through this system on mainnet:

1. **Run `ConfigureLZConfig.s.sol`** (see the Script Reference) against
   every (OApp, eid) pair we own. The script sets send + receive libraries,
   `UlnConfig` (DVN set + confirmations), and enforced options in one
   multisig / timelock transaction.
2. **Call `setRateLimits(perRequestCap, dailyCap)`** on `VPFIBuyAdapter`
   after deploy. Defaults are `type(uint256).max` (disabled) so the
   contract is safe to deploy before the caps are configured — but the
   runbook must gate mainnet value routing on this call having been made.
3. **Verify via `LZConfig.t.sol`** that every OApp on every eid reflects
   the policy below. The test fails the build if any pair is still on
   defaults.

### DVN Policy

- **3 required + 2 optional, threshold 1-of-2** (3R + 2O).
- Attacker must compromise all 3 required DVNs and at least 1 of 2
  optionals to land a forged packet — 4 independent verifier compromises
  minimum.
- Operator diversity: different corporate operators, different infra
  providers, mix of commercial and community-adjacent.

Proposed operator set (final addresses pinned in `ConfigureLZConfig.s.sol`):

| Role | Candidates |
|---|---|
| Required (all three must sign) | LayerZero Labs, Google Cloud, Polyhedra *or* Nethermind |
| Optional (1-of-2 threshold) | BWare Labs, Stargate Labs *or* Horizen Labs |

### Block Confirmations

Per-chain `UlnConfig.confirmations`:

| Chain | Confirmations | ~Wall-clock |
|---|---|---|
| Ethereum L1 | 15 | ~3 min |
| Base | 10 | ~20 sec |
| Optimism | 10 | ~20 sec |
| Arbitrum | 10 | ~10 sec |
| Polygon zkEVM | 20 | ~1 min |
| BNB Chain | 15 | ~45 sec |

Polygon PoS is out of Phase 1 (weaker multi-sig bridge trust; re-evaluate
when AggLayer matures). Solana is out of scope for all phases until
further notice.

### Enforced Options

`setEnforcedOptions` must be populated per `msgType` per `eid` for every
OApp — protects against underpaid destination gas trapping messages.
Covered by the configure script.

### Emergency Pause

Every LZ-facing contract has a timelock-gated `pause()` / `unpause()`:

- `VPFIOFTAdapter` / `VPFIMirror` — pauses outbound `_debit` and inbound
  `_credit`.
- `VPFIBuyAdapter` — pauses user-initiated `buy()` and inbound response
  `_lzReceive`. Timed-out reclaims stay callable so stranded buyers can
  always recover funds.
- `VPFIBuyReceiver` — pauses inbound `_lzReceive` (Diamond debit + OFT
  send-back).
- `VaipakamRewardOApp` — pauses `sendChainReport`, `broadcastGlobal`, and
  `_lzReceive`.

Kelp's 46-minute pause blocked $200M of follow-up drain; the pause lever
is the difference between a contained incident and a catastrophic one.

### Rate Limits (`VPFIBuyAdapter`)

Defence-in-depth above the Diamond-side `globalCap` / `perWalletCap`:

- **Per-request cap**: 50k VPFI (configurable post-deploy).
- **Rolling 24h cap**: 500k VPFI (first-buy-anchored tumbling window;
  closes the midnight-burst window of fixed-clock limits).

Both initialized to `type(uint256).max` (disabled); governance must call
`setRateLimits(50_000e18, 500_000e18)` before routing real value.

### Monitoring

Off-chain watcher alerts expected:

- Packets received by our OApps with verifying DVN count < 2.
- OFT mint/burn imbalance across mirrors vs. adapter lock on Base.
- Large single-tx VPFI flow on a mirror that doesn't correlate with an
  OFT send on another chain.
- DVN / executor / endpoint availability of our configured operators.

---

## OFT Bridging Flow

**Outbound (Base → mirror chain)**

1. User approves the canonical `VPFIOFTAdapter` for `N` VPFI.
2. User calls `adapter.send(SendParam, MessagingFee, refundAddress)`.
3. Adapter `safeTransferFrom`s `N` VPFI from the user into the adapter
   (locks it).
4. LayerZero endpoint emits a packet addressed to the peer mirror on the
   destination chain.
5. DVNs verify, executor delivers.
6. Destination `VPFIMirror._credit` mints `N` VPFI to the recipient.

**Inbound (mirror chain → Base)**

1. User calls `mirror.send(...)` on the source mirror with `N` VPFI.
2. Mirror burns `N` locally.
3. LayerZero delivers the packet to the Base adapter.
4. Adapter `_credit`s `N` VPFI by unlocking (transferring) from its
   holdings to the recipient.

Mesh-wide supply invariant at any instant:

```
mirror_totalSupply[chain_1] + mirror_totalSupply[chain_2] + ... +
    canonical_balance_of(adapter) ==
    canonical_totalSupply  <=  TOTAL_SUPPLY_CAP (230M)
```

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
| `DeployDiamond.s.sol`              | Deploy diamond + 23 facets, run the initial cut                 |
| `DeployVPFICanonical.s.sol`        | Base-only: VPFIToken + adapter + bind to diamond                |
| `DeployVPFIMirror.s.sol`           | Mirror chain: VPFIMirror + bind to local diamond                |
| `WireVPFIPeers.s.sol`              | Owner-side OApp `setPeer` for one (local, remote) pair          |
| `RedeployFacets.s.sol`             | Redeploy specific facets and cut them in (surgical upgrade)     |
| `ReplaceStaleFacets.s.sol`         | Replace facets whose selectors have drifted                     |
| `UpgradeOracle.s.sol`              | Swap the OracleFacet implementation                             |
| `AddKeeperSelectors.s.sol`         | Grant keeper selector access                                    |
| `AddOracleAdmin.s.sol`             | Grant oracle-admin role                                         |
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
