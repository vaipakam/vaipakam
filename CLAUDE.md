# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Test Commands

All commands must be run from the `contracts/` directory:

```bash
# Build
forge build

# Run all tests
forge test

# Run a single test file
forge test --match-path test/RepayFacetTest.t.sol

# Run a single test function
forge test --match-test testRepayLoan

# Run tests with verbosity (traces on failure)
forge test -vvv

# Gas snapshots
forge snapshot

# Coverage
forge coverage
```

**Compiler:** Solidity 0.8.29 with `viaIR = true`, optimizer at 200 runs. Fuzz: 1000 runs, invariant: 100 runs.

## Architecture

This is a **decentralized P2P lending platform** using the **EIP-2535 Diamond Standard** (multi-facet proxy).

### Diamond Pattern

`VaipakamDiamond.sol` is the single entry point. All calls hit its `fallback()`, which routes to the correct facet by function selector. All facets share storage through `LibVaipakam.sol` at position `keccak256("vaipakam.storage")`.

Cross-facet calls use `address(this).call(abi.encodeWithSelector(...))` — this goes through the Diamond's fallback and routes to the target facet.

### Per-User Escrow

`VaipakamEscrowImplementation.sol` is a UUPS upgradeable implementation. `EscrowFactoryFacet` deploys one `ERC1967Proxy` per user (clone factory pattern). Each user's assets (ERC20/ERC721/ERC1155) are held in their own isolated escrow — no commingling.

### Core Facets & Loan Lifecycle

| Facet | Role |
|---|---|
| **OfferFacet** | Create/accept/cancel lending & borrowing offers |
| **LoanFacet** | Initiate loans, enforce HF >= 1.5 and LTV constraints |
| **RepayFacet** | Full/partial repayment, NFT daily deductions, late fees |
| **DefaultedFacet** | Time-based defaults (grace period expired) |
| **RiskFacet** | LTV/Health Factor calculation, HF-based liquidation via 0x swap |
| **OracleFacet** | Chainlink price feeds, Uniswap v3 liquidity checks |
| **EscrowFactoryFacet** | Per-user UUPS escrow proxy deployment |
| **VaipakamNFTFacet** | Mint/update/burn position NFTs (ERC721, on-chain metadata) |
| **ProfileFacet** | User country (sanctions), KYC verification |
| **AdminFacet** | Treasury, 0x proxy, allowance target config |

Placeholder facets (Phase 2): TreasuryFacet, PrecloseFacet, RefinanceFacet, EarlyWithdrawalFacet, PartialWithdrawalFacet.

### Liquid vs Illiquid Assets

- **Liquid**: Has Chainlink feed + Uniswap v3 pool + $1M volume → LTV/HF checks apply, 0x swap on liquidation
- **Illiquid**: NFTs or tokens without oracle → valued at $0, full collateral transfer on default, both parties must explicitly consent

### Two Liquidation Paths

1. **HF-based** (RiskFacet): HF < 1e18 → permissionless 0x swap, liquidator gets bonus
2. **Time-based** (DefaultedFacet): Grace period expired → liquid assets get swapped, illiquid get transferred directly to lender

### Key Constants (LibVaipakam.sol)

- `MIN_HEALTH_FACTOR = 1.5e18` — minimum HF at loan initiation
- `TREASURY_FEE_BPS = 100` — 1% treasury cut on interest
- `KYC_THRESHOLD_USD = 2000e18` — KYC required above this
- `RENTAL_BUFFER_BPS = 500` — 5% buffer on NFT rental prepayment
- `VOLATILITY_LTV_THRESHOLD_BPS = 11000` — 110% LTV collapse threshold

### Dependencies

- **OpenZeppelin Contracts Upgradeable** — UUPS, AccessControl, Pausable, ERC20/721/1155
- **Diamond-3** — IDiamondCut, IDiamondLoupe, IERC173
- **Chainlink** — Price feeds, Feed Registry
- Remappings in `contracts/remappings.txt`

## Test Structure

Tests are in `contracts/test/`. `HelperTest.sol` provides base utilities. `SetupTest.t.sol` provides shared setup (users, mocks, diamond deployment). Test files inherit from these.

Mock contracts in `contracts/test/mocks/`: `ERC20Mock`, `ERC4907Mock`, `ZeroExProxyMock`.

## Conventions

- Interest rates and fees use **basis points** (BPS, 1/10000)
- Health factor and USD values are scaled to **1e18**
- Facets use `ReentrancyGuard` and `Pausable` from OpenZeppelin
- Token operations use `SafeERC20`
- Custom errors (not require strings) for gas efficiency
- Events use indexed parameters for filtering
