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

| Facet                  | Role                                                                        |
| ---------------------- | --------------------------------------------------------------------------- |
| **OfferFacet**         | Create/accept/cancel lending & borrowing offers                             |
| **LoanFacet**          | Initiate loans, enforce HF >= 1.5 and LTV constraints                       |
| **RepayFacet**         | Full/partial repayment, NFT daily deductions, late fees                     |
| **DefaultedFacet**     | Time-based defaults (grace period expired)                                  |
| **RiskFacet**          | LTV/Health Factor calculation, HF-based liquidation via 0x swap             |
| **OracleFacet**        | Chainlink price feeds, v3-style concentrated-liquidity AMM liquidity checks |
| **EscrowFactoryFacet** | Per-user UUPS escrow proxy deployment                                       |
| **VaipakamNFTFacet**   | Mint/update/burn position NFTs (ERC721, on-chain metadata)                  |
| **ProfileFacet**       | User country (sanctions), KYC verification                                  |
| **AdminFacet**         | Treasury, 0x proxy, allowance target config                                 |

Placeholder facets (Phase 2): TreasuryFacet, PrecloseFacet, RefinanceFacet, EarlyWithdrawalFacet, PartialWithdrawalFacet.

### Liquid vs Illiquid Assets

- **Liquid**: Has Chainlink feed + v3-style concentrated-liquidity AMM pool + $1M volume → LTV/HF checks apply, 0x swap on liquidation
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

## Keeper-bot ABI sync (Phase 9.A)

The public reference keeper bot lives in a sibling repo
(`vaipakam-keeper-bot`). It reads a small Diamond surface
(`MetricsFacet.getActiveLoansCount` /
`getActiveLoansPaginated`, `RiskFacet.calculateHealthFactor` /
`triggerLiquidation`, `LoanFacet.getLoanDetails`) via per-facet
ABI JSONs checked into `keeper-bot/src/abis/`.

**When you change ANY of those selectors** (rename, add/remove
parameters, change return shape), run:

```bash
forge build   # build before inspecting
KEEPER_BOT_DIR=../../vaipakam-keeper-bot \
  bash contracts/script/exportAbis.sh
```

The script writes the regenerated JSONs into the keeper-bot
checkout. Then `cd` to that repo, run `npm run typecheck` to
confirm the bot still compiles against the new shape, review the
diff, and commit there with a message like
`"Sync ABIs with vaipakam@<commit-hash>"`. The script writes
`src/abis/_source.json` with the upstream commit hash so the
correlation is recorded.

Skipping this sync ships a public bot whose ABI doesn't match
deployed reality — the bot will revert in production with
opaque "function selector not found" failures. Treat this sync
the same way you'd treat a frontend ABI bump: part of the same
PR as the contract change.

## Frontend ABI sync

The frontend imports per-facet ABI JSONs from
`frontend/src/contracts/abis/`. Unlike the keeper-bot, the frontend
imports the **full** Diamond surface (currently 27 facets — see the
`FACETS=(...)` list in `contracts/script/exportFrontendAbis.sh`),
so essentially every facet edit needs a re-export.

**When you change ANY facet selector** (rename, add/remove
parameters, change struct shape, etc.), run:

```bash
forge build   # build before inspecting
bash contracts/script/exportFrontendAbis.sh
```

The script regenerates every JSON via `forge inspect <Facet> abi
--json`, writes `_source.json` with the contracts commit hash,
and prints the typecheck command. Run that next:

```bash
cd frontend && node_modules/.bin/tsc -b --noEmit
```

Review the diff (`git diff frontend/src/contracts/abis/`) and
commit alongside the contract change with a message like
`"Sync frontend ABIs with contracts@<hash>"`.

**Why this matters — failure mode is non-obvious**: if the
deployed contract drops a struct field but the frontend ABI keeps
it, the encoded calldata is one word too long. Base-Sepolia public
RPCs (publicnode, sepolia.base.org) wrap the resulting revert
during `eth_estimateGas` as the generic `"exceeds max transaction
gas limit"` — there's no hint that the real cause is an ABI
mismatch. Phase 6 hit exactly this when `keeperAccessEnabled` was
removed from `CreateOfferParams` server-side but stayed in the
frontend's `OfferFacet.json`. The sync script exists so the next
person doesn't lose an hour to that.

**Adding a new facet to the frontend**: append the contract name
to the `FACETS=(...)` array in
`contracts/script/exportFrontendAbis.sh` AND wire it into the
re-export barrel `frontend/src/contracts/abis/index.ts` (the
script does NOT touch the barrel).

## Deployments sync (frontend + hf-watcher)

Both the frontend AND the hf-watcher Worker import a single
consolidated `deployments.json` keyed by `chainId`, generated by
merging every `contracts/deployments/<chain-slug>/addresses.json`
(the canonical artifact each deploy script writes) into one file.
This replaced two parallel patterns:
- frontend's `VITE_<CHAIN>_DIAMOND_ADDRESS` /
  `VITE_<CHAIN>_ESCROW_IMPL` / `VITE_<CHAIN>_*_FACET_ADDRESS` env-var
  fan-out in `.env.local`
- watcher's empty `DIAMOND_ADDR_*` placeholders in `wrangler.jsonc:vars`

Both consumers now pick up live addresses on the next build after
the export script runs — no hand-editing of env files / wrangler
config required.

**When to run the sync** — after every contract deploy / redeploy on
any chain, or when a new `contracts/deployments/<slug>/` directory
appears:

```bash
bash contracts/script/exportFrontendDeployments.sh
cd frontend && node_modules/.bin/tsc -b --noEmit
cd ../ops/hf-watcher && npx tsc -p . --noEmit
```

The script auto-detects the watcher's directory via the sibling
layout (`vaipakam/ops/hf-watcher`) and writes to both targets when
present. Pass `WATCHER_DIR=` (empty) to skip the watcher target
explicitly. Each target gets its own `_deployments_source.json`
provenance stamp so a deployed bundle can be correlated to a
specific contracts commit.

The typed loaders live in
[`frontend/src/contracts/deployments.ts`](frontend/src/contracts/deployments.ts)
and
[`ops/hf-watcher/src/deployments.ts`](ops/hf-watcher/src/deployments.ts) —
both expose `getDeployment(chainId)` against the same `Deployment`
shape, with consumer-specific subsets of the optional facets.

Review the diff with
`git diff frontend/src/contracts/deployments.json ops/hf-watcher/src/deployments.json`
and commit alongside the contracts change.

**What still lives operator-side** — items that are NOT deployment
artifacts and stay in their respective env / config:
- Frontend `.env.local`: per-chain RPC URLs (with API key),
  WalletConnect project ID, default chain ID, log-chunk tuning,
  feature flags, push channel address.
- Watcher `wrangler.jsonc:vars`: `FRONTEND_ORIGIN`,
  `TG_BOT_USERNAME`, `DIAG_*` knobs.
- Watcher Cloudflare secrets (set via `wrangler secret put`):
  `RPC_*` URLs (carry API keys), `TG_BOT_TOKEN`,
  `PUSH_CHANNEL_PK`, aggregator API keys, keeper private key.

**Omit-keys policy for chain shape variance**: canonical-VPFI chains
(Base / Base Sepolia) carry `vpfiOftAdapter` + `vpfiBuyReceiver`;
mirror chains (Sepolia, Arb Sepolia, etc.) carry `vpfiMirror` +
`vpfiBuyAdapter`. Each chain's stanza in the consolidated JSON
only includes the keys that apply to it — there are NO
`0x0000…0000` sentinels for "doesn't apply on this chain". Mixing
zero-address sentinels into address slots is a real DeFi bug class
(`address(0)` already means real things in Solidity: the ETH
sentinel, default-treasury, burn). The TS `Deployment` type marks
non-universal fields as optional and consumers narrow on the
`isCanonicalVPFI` / `isCanonicalReward` booleans before reading
scoped fields. Exception: `vpfiBuyPaymentToken` carries
`0x0000…0000` to mean "pay in native gas" — that's a meaningful
runtime sentinel, not a missing field, and the consumer maps zero
→ null at the boundary.

## Cross-Chain Security Policy (DVN + Pause)

Every LayerZero OApp / OFT in this repo (`VPFIOFTAdapter`, `VPFIMirror`,
`VPFIBuyAdapter`, `VPFIBuyReceiver`, `VaipakamRewardOApp`) ships with the
LayerZero defaults, which are **1-required / 0-optional DVN** — the
single-verifier shape that the April 2026 cross-chain bridge exploit
rode. A mainnet deploy that inherits those defaults is **not**
acceptable.

**Mainnet-deploy gate** — before routing real value, all of the below must
be true:

1. `ConfigureLZConfig.s.sol` has run against every (OApp, eid) pair. This
   sets the DVN set, confirmations, libraries, and enforced options.
2. `VPFIBuyAdapter.setRateLimits(50_000e18, 500_000e18)` has been called.
   Defaults are `type(uint256).max` (disabled) at deploy time.
3. `LZConfig.t.sol` passes — it asserts every OApp × eid reflects the
   policy and fails the build otherwise.

**DVN policy**: **3 required + 2 optional, threshold 1-of-2.** Required:
LayerZero Labs + Google Cloud + Polyhedra or Nethermind. Optional:
BWare Labs + Stargate/Horizen. Operator diversity is load-bearing
— different corporate operators, different infra.

**Chain scope (Phase 1)**: Ethereum, Base, Arbitrum, Optimism, Polygon
zkEVM, BNB Chain. Polygon PoS is out of Phase 1 (weaker bridge trust).
Solana is out of scope for all phases until further notice.

**Confirmations**: Ethereum 15 / Base 10 / OP 10 / Arb 10 / zkEVM 20 /
BNB 15. Higher numbers are acceptable; lower numbers require justification.

**Pause lever**: every LZ-facing contract exposes owner-gated `pause()` /
`unpause()` on both send and receive paths. Use in the first minutes of
a suspected incident; a precedent in the April 2026 cross-chain bridge
incident (a 46-minute pause) blocked ~$200M of follow-up drain.

Full detail in [`contracts/README.md`](contracts/README.md) under
"Cross-Chain Security".

## VPFI Fee Discounts — Time-Weighted + Claim-Based (Phase 5)

Both sides of the VPFI fee discount (lender yield-fee + borrower Loan
Initiation Fee) are **time-weighted** across a loan's lifetime and
**not** a point-in-time tier lookup. The lender discount reduces the
yield-fee treasury haircut at settlement; the borrower discount is
delivered as a VPFI **rebate** paid out alongside `claimAsBorrower`.

**Time-weighted accumulator (`LibVPFIDiscount.rollupUserDiscount`)**:
re-stamps the BPS at the **post-mutation** escrow VPFI balance on
every change, so an unstake takes effect immediately for every open
loan's average. Pre-Phase-5 code stamped at pre-mutation balance,
which let a user keep a high-tier stamp after dropping to tier 0
until the next balance change — gaming vector. Always call rollup at
mutation sites passing the post-mutation balance; read-only snapshots
pass the live balance.

**Borrower LIF — Phase 5 flow**:

1. At `OfferFacet.acceptOffer` on the VPFI path: borrower pays the
   FULL 0.1% LIF equivalent in VPFI (not tier-discounted) from their
   escrow into **Diamond custody** (not treasury). Amount recorded
   in `s.borrowerLifRebate[loanId].vpfiHeld`.
2. At proper settlement (`RepayFacet` terminal, `PrecloseFacet`
   direct + offset, `RefinanceFacet`):
   `LibVPFIDiscount.settleBorrowerLifProper(loan)` splits `vpfiHeld`
   into a borrower rebate (`vpfiHeld × avgBps / BPS`) and a treasury
   share; stores rebate in `s.borrowerLifRebate[loanId].rebateAmount`
   and forwards the treasury share.
3. At default / HF-liquidation (`DefaultedFacet.markDefaulted`,
   `RiskFacet` HF-terminal): `LibVPFIDiscount.forfeitBorrowerLif(loan)`
   forwards the full held amount to treasury; no rebate.
4. At claim (`ClaimFacet.claimAsBorrower`): pays out the rebate in
   VPFI atomically with the normal collateral claim.

**Mainnet invariants to preserve**:

- Every proper-close terminal path MUST call
  `LibVPFIDiscount.settleBorrowerLifProper(loan)`.
- Every default / liquidation terminal path MUST call
  `LibVPFIDiscount.forfeitBorrowerLif(loan)`.
- Loan struct `borrowerDiscountAccAtInit` is snapshotted in
  `LoanFacet._snapshotBorrowerDiscount` at loan-init; don't bypass.
- The diamond holds the custody VPFI until terminal; no intermediate
  transfer. A leaked `vpfiHeld` (non-zero on a Settled loan) is a bug.

Full detail in [`docs/TokenomicsTechSpec.md`](docs/TokenomicsTechSpec.md)
§5.2b and the Phase 5 section of
[`docs/ReleaseNotes-2026-04-23-to-24.md`](docs/ReleaseNotes-2026-04-23-to-24.md).

## Retail-deploy policy — sanctions ON; KYC / country-pair OFF

The retail Vaipakam deploy is permissionless for KYC and country-pair
trade restrictions, but **does** screen wallets against an on-chain
sanctions oracle (Chainalysis-style). Don't conflate the three —
sanctions screening protects the protocol from OFAC-listed addresses;
KYC and country gating are the industrial-fork knobs that stay dormant.

**Sanctions oracle — REQUIRED on retail post-deploy:**

`ProfileFacet.setSanctionsOracle(<chainalysis-oracle>)` MUST be called
on the retail deploy once the oracle's address is known on-chain. While
unset (`address(0)`), `LibVaipakam.isSanctionedAddress(...)` returns
`false` for every address (intentional fail-open during the deploy
window). Once set, the Tier-1 entry points
(`createOffer`, `acceptOffer`, `getOrCreateUserEscrow`, VPFI
deposit/buy/withdraw, `triggerLiquidation`, EarlyWithdrawal,
PrecloseFacet, RefinanceFacet, ClaimFacet) revert
`SanctionedAddress(who)` for flagged callers, while Tier-2 close-out
paths (`repayLoan`, `markDefaulted`, time-based liquidation) stay open
so the unflagged counterparty can be made whole. The `_assertNotSanctioned`
helper in `LibVaipakam` is the canonical gate — when adding a new
state-creating or fund-receiving facet method, decide Tier-1 or Tier-2
and gate accordingly.

**Two runtime knobs that must never be flipped on the retail deploy:**

1. `AdminFacet.setKYCEnforcement(true)` — flips
   `s.kycEnforcementEnabled`. While `false` (the post-deploy default),
   `ProfileFacet.meetsKYCRequirement` and `isKYCVerified` short-circuit
   to `true` so OfferFacet / LibCompliance / RiskFacet / DefaultedFacet
   call sites never block.
2. `LibVaipakam.canTradeBetween(...)` — pure-true on retail; consults
   no storage. **Do not** replace it with the gated implementation.
   The default-DENY gated branch lives separately as
   `LibVaipakam._canTradeBetweenStorageGated(...)` (storage-driven, used
   only by the industrial fork and exercised in `CountryPairGatedTest`).
   The two helpers coexist on purpose so the industrial fork can flip
   pair-based restrictions on without a storage migration. The
   symmetric `setTradeAllowance` setter is shared — its writes populate
   the gated mapping, but retail's `canTradeBetween` ignores it
   entirely.

**Don't:**

- Add `setKYCEnforcement(true)` to any retail deploy or post-deploy
  script.
- Change `canTradeBetween` to consult the `allowedTrades` mapping.
  Switch the call sites that need gating to
  `_canTradeBetweenStorageGated` directly instead.
- Mention KYC, identity verification, or country gating on the website
  / whitepaper / overview / user guide / marketing copy. The retail
  product is KYC-free and country-pair-free end-state, not
  "permissionless for now."
- Put detailed sanctions wording in publicly visible copy. ToS keeps
  ONE defensive bullet under "Prohibited use." The full three-line
  message ("listed by oracle / new positions blocked / close-outs
  stay open / contact Chainalysis") is shown ONLY when a flagged
  wallet connects (in-app `SanctionsBanner`) and in contract revert
  messages — never on marketing surfaces.

**Why the OFF gates are still in the code:** the industrial-user
variant is a separate deploy on a separate fork that re-uses the
same contracts with KYC + country-pair flipped on. Don't delete the
gates from the source; just don't enable them on the retail deploy.
See [`docs/internal/Roadmap.md`](docs/internal/Roadmap.md) for the
fork plan.

The Sepolia test scripts (`SepoliaActiveLoan.s.sol`,
`SepoliaOpenOffers.s.sol`, `SepoliaPositiveFlows.s.sol`) call
`updateKYCTier(...)` / `setTradeAllowance(...)` defensively but those
calls are no-ops while enforcement is off and trade-pair checks are
unconditional. They can stay.
