# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project level instruction

- Currently developing a project called 'Vaipakam' (a Tamil name for 'Bank') which is a 'Decentralised P2P Lending, Borrowing and NFT Rental Platform'.
- Follow the coding standards, style conventions and develop code by following best practices approach and with proper nat comments
- Expects the code maintainability easier
- Expects decisions based on architecturally strong Layered & Modular Approach
- GitHub repo for this project is: https://github.com/vaipakam/vaipakam.
- Always look for a better approach and let the user know about it to decide

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

### Per-User Vault

`VaipakamVaultImplementation.sol` is a UUPS upgradeable implementation. `VaultFactoryFacet` deploys one `ERC1967Proxy` per user (clone factory pattern). Each user's assets (ERC20/ERC721/ERC1155) are held in their own isolated vault — no commingling.

### Core Facets & Loan Lifecycle

| Facet                  | Role                                                                        |
| ---------------------- | --------------------------------------------------------------------------- |
| **OfferCreateFacet**   | Create lending & borrowing offers (cancellation → OfferCancelFacet, range-matching → OfferMatchFacet) |
| **OfferAcceptFacet**   | Accept an offer → initiate the loan                                         |
| **LoanFacet**          | Initiate loans, enforce HF >= 1.5 and LTV constraints                       |
| **RepayFacet**         | Full/partial repayment, NFT daily deductions, late fees                     |
| **DefaultedFacet**     | Time-based defaults (grace period expired)                                  |
| **RiskFacet**          | LTV/Health Factor calculation, HF-based liquidation via 0x swap             |
| **OracleFacet**        | Chainlink price feeds, v3-style concentrated-liquidity AMM liquidity checks |
| **VaultFactoryFacet** | Per-user UUPS vault proxy deployment                                       |
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

## Deploy-sanity suite + `predeploy-check.sh`

`contracts/test/deploy/` holds the **deploy-sanity suite** — static
guardrails that catch deploy-breaking mistakes during a normal
`forge test` run instead of at `--broadcast` time:

- **`FacetSizeLimitTest`** (Issue #66) — every facet's runtime bytecode
  is within the EIP-170 24,576-byte limit.
- **`SelectorCoverageTest`** (Issue #71) — every external/public
  function compiled into a facet is cut into the Diamond by
  `DeployDiamond.s.sol`, and no two facet functions collide on a 4-byte
  selector.
- **`DiamondFacetNames.sol`** — the single shared list of cut facets
  both tests consume, so the suite's facet set cannot drift apart.

`contracts/script/predeploy-check.sh` is the **pre-deploy gate**: it runs
`forge build`, the deploy-sanity suite (or the full regression with
`--full`), lints the deploy shell scripts, and checks every committed
per-facet ABI matches `forge inspect`. It is wired as preflight step
`[1b]` inside `deploy-{chain,testnet,mainnet}.sh` (the mainnet script
passes `--full`), so a deploy cannot proceed past a failing check; it is
also runnable standalone (`bash script/predeploy-check.sh`).

**When you add a facet**: add it to `DiamondFacetNames.cutFacetNames()`
AND add its `_get<Facet>Selectors()` call to
`SelectorCoverageTest._populateRoutedSet()`. **When you add a function to
a facet**: add its selector to the matching `_get<Facet>Selectors()` in
`DeployDiamond.s.sol` (and `HelperTest.sol`) — `SelectorCoverageTest`
fails otherwise. A deeper deploy-*integration* test (runs `DeployDiamond`
and loupe-asserts the built Diamond) is tracked as Issue #72.

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
`packages/contracts/src/abis/`. Unlike the keeper-bot, the frontend
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

Review the diff (`git diff packages/contracts/src/abis/`) and
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
re-export barrel `packages/contracts/src/abis/index.ts` (the
script does NOT touch the barrel).

## Worker ABI consumption (Stage 3 split)

The Stage 3 source-tree refactor (see
`docs/DesignsAndPlans/Stage3WorkerSplitPlan.md`) split the historical
`ops/hf-watcher` monolith into three focused Cloudflare Workers under
`apps/{keeper,indexer,agent}`. All three Workers read per-facet ABIs
directly from `@vaipakam/contracts/abis` — the same single-source-of-
truth bundle the frontend reads. There is no Worker-specific ABI
export step any more; the historical
`contracts/script/exportWatcherAbis.sh` was deleted alongside
`ops/hf-watcher` itself.

When you add a new facet that any of the Workers needs to read:

1. Add the facet to the `FACETS=(...)` array in
   `contracts/script/exportFrontendAbis.sh`.
2. Wire it into the re-export barrel
   `packages/contracts/src/abis/index.ts`.
3. Import it in the Worker that needs it (e.g.
   `apps/indexer/src/diamondAbi.ts` for indexer-side reads).

The Workers all use the same `@vaipakam/contracts/abis` import
shape, so a single `pnpm --filter @vaipakam/{keeper,indexer,agent}
exec tsc -p . --noEmit` cycle catches any mismatch.

The historical "Watcher offer-decode drift" incident
([ReleaseNotes-2026-05-05.md](docs/ReleaseNotes/ReleaseNotes-2026-05-05.md))
where hand-typed `as const` tuples silently shifted field
positions can't recur — the Solidity compiler is the single source
of truth for every Worker's read-decode shape, and event routing
uses topic-hash matching (positional decode is never used for
events).

**Indexer event-coverage guardrail.** `apps/indexer`'s `EVENT_ABI` is
DERIVED from the compiled `DIAMOND_ABI_VIEM` (never hand-typed) so the
decode surface can't drift. On top of that,
`apps/indexer/scripts/check-event-coverage.mjs` (wired into
`pnpm --filter @vaipakam/indexer typecheck` and exposed as
`pnpm --filter @vaipakam/indexer check-event-coverage`) fails CI if any
contract event tagged `@custom:event-category state-change/loan-mutation`
or `state-change/offer-mutation` lacks a `log.eventName === '...'`
handler in `chainIndexer.ts` AND isn't in the script's
`DELIBERATELY_NOT_HANDLED` allowlist (each entry carries a one-line
reason). So when you add a new loan/offer state-change event to the
contracts, you must either handle it in the indexer or consciously
allowlist it — the May-2026 "every loan stuck active" bug (the indexer
missing the preclose/offset/refinance terminal events, plus drifted
arg counts on `LoanRepaid`/`LoanDefaulted`) can't recur silently.

## Cloudflare D1 schema discipline

The three plain Workers (`apps/indexer`, `apps/keeper`, `apps/agent`)
all bind to **one shared D1 database** — `vaipakam-archive`
(database_id `3cffebf5-b652-4da7-953c-9e1d143ad2fe`), the **staging**
database the Cloudflare staging deploy uses (see
[`docs/DesignsAndPlans/CloudflareStagingDeployPlan.md`](docs/DesignsAndPlans/CloudflareStagingDeployPlan.md)
§3 for the staging-vs-primary split). The schema is **owned by
`apps/indexer/migrations/`** — that's the single source of truth for
every table the live db holds. `apps/keeper` and `apps/agent`
intentionally have no `migrations/` directory of their own; they
read and write a subset of the shared tables via the same binding
(see the per-Worker READMEs for the exact write/read split).

**Rule**: every schema change — even for a table only `keeper` or
`agent` writes — lands as a new file under
`apps/indexer/migrations/NNNN_<slug>.sql`. Apply with
`wrangler d1 migrations apply vaipakam-archive --remote` from inside
`apps/indexer/`. Never `wrangler d1 execute --command "CREATE TABLE..."`
directly on the deployed db: that diverges the migrations record from
the live schema and breaks fresh-environment bootstrap.

The `ops/lz-watcher` Worker uses a **separate** D1 (`vaipakam-lz-alerts-db`,
schema in `ops/lz-watcher/migrations/`) for trust-boundary reasons —
its internal ops alerts must not co-locate with user-facing data. Don't
fold those tables into `vaipakam-archive`.

## Deployments sync (Stage 3 split — single target)

Every consumer in the monorepo — apps/{defi,www} for the React
surfaces, apps/{keeper,indexer,agent} for the Cloudflare Workers —
imports the consolidated `deployments.json` from
`@vaipakam/contracts/deployments`. One typed lookup
(`getDeployment(chainId)`), one provenance stamp, one source of
truth.

(Pre-Stage-3 the export script also wrote a duplicate copy into
`ops/hf-watcher/src/deployments.json`. After the Stage 3 Worker
split that dual-write target is gone — every Worker reads the
shared `@vaipakam/contracts` bundle directly.)

The merge step folds every per-chain
`contracts/deployments/<chain-slug>/addresses.json` (the canonical
artifact each deploy script writes) into the single object keyed
by `chainId`.

**When to run the sync** — after every contract deploy / redeploy on
any chain, or when a new `contracts/deployments/<slug>/` directory
appears:

```bash
bash contracts/script/exportFrontendDeployments.sh
pnpm --filter @vaipakam/defi exec tsc -b --noEmit
pnpm --filter @vaipakam/keeper exec tsc -p . --noEmit
pnpm --filter @vaipakam/indexer exec tsc -p . --noEmit
pnpm --filter @vaipakam/agent exec tsc -p . --noEmit
```

Each typecheck confirms the matching consumer still sees a
well-shaped `Deployment` for every chain it consults.

The typed loader lives in
[`packages/contracts/src/deployments.ts`](packages/contracts/src/deployments.ts).
Review the diff with
`git diff packages/contracts/src/deployments.json` and commit
alongside the contracts change.

**What still lives operator-side** — items that are NOT deployment
artifacts and stay in their respective env / config:

- Frontend `.env.local`: per-chain RPC URLs (with API key),
  WalletConnect project ID, default chain ID, log-chunk tuning,
  feature flags, push channel address, plus `VITE_INDEXER_ORIGIN`
  - `VITE_AGENT_ORIGIN` (the two Worker URLs the connected app
    reads).
- apps/agent `wrangler.jsonc:vars`: `FRONTEND_ORIGIN`,
  `TG_BOT_USERNAME`, `DIAG_*` knobs.
- apps/agent Cloudflare secrets (set via `wrangler secret put`):
  `RPC_*` URLs (carry API keys), `TG_BOT_TOKEN`,
  `PUSH_CHANNEL_PK`, aggregator API keys, `KEEPER_PRIVATE_KEY`.
- apps/keeper Cloudflare secrets: `KEEPER_PRIVATE_KEY` +
  `KEEPER_ENABLED`, `RPC_*`, `TG_BOT_TOKEN`, `PUSH_CHANNEL_PK`,
  `ZEROEX_API_KEY`, `ONEINCH_API_KEY`.
- apps/indexer Cloudflare secrets: `RPC_*` only (no signing keys).
- ops/* Cloudflare secrets: use `TG_OPS_BOT_TOKEN` (NOT
  `TG_BOT_TOKEN`) — see "Two Telegram bots" below.

**Two Telegram bots — by audience, never share tokens**:

- `TG_BOT_TOKEN` — user-facing bot. Used by `apps/keeper` (HF-band
  downgrade alerts) + `apps/agent` (Telegram link handshake +
  periodic-interest pre-notify). Posts to user-supplied chat IDs
  (`tg_chat_id` per subscription).
- `TG_OPS_BOT_TOKEN` — ops-internal bot. Used by `ops/lz-watcher`
  (LZ-mesh DVN drift / OFT imbalance / oversized-flow alerts) +
  `ops/offchain-data-archive` (nightly backup outcomes + weekly
  healthcheck verdicts). Posts to a single operator chat
  (`TG_OPS_CHAT_ID`).

Splitting bounds the blast radius of a token leak. A user-bot
compromise can't spoof ops alerts (the operator acts on detection
signals from those — backup failure, lane drift); an ops-bot
compromise can't reach the user-alert channels. When adding a new
Worker, pick the matching token based on **who reads the alert**,
not on convenience.

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

## Cross-Chain Security Policy (CCIP)

Vaipakam's cross-chain layer runs on **Chainlink CCIP** — T-068 migrated
it off LayerZero. CCIP's security is operated by Chainlink (a committing
DON, an executing DON, and an independent **Risk Management Network** with
a separate codebase + operators that re-verifies every message) and is
uniform for every integrator. There is **no DVN fleet to select or
configure** and no insecure default — the LayerZero "1-required /
0-optional DVN" footgun (the shape the April 2026 ~$292M Kelp bridge
exploit rode) does not exist here.

The cross-chain code lives in `contracts/src/crosschain/`:
- `ICrossChainMessenger` — the provider-agnostic port; domain contracts
  depend only on this, never on a CCIP library.
- `CcipMessenger` — the single CCIP-aware adapter.
- `VPFIMirrorToken` + the stock CCIP `LockReleaseTokenPool` /
  `BurnMintTokenPool` — VPFI as a Cross-Chain Token (CCT).
- `VpfiBuyAdapter` / `VpfiBuyReceiver` — the cross-chain fixed-rate buy
  flow (the two-step release is kept).
- `VaipakamRewardMessenger` — cross-chain reward accounting.

**Mainnet-deploy gates** — before routing real value:

1. CCIP lanes enabled and each `CcipMessenger`'s registry configured —
   chainId↔CCIP-selector, remote messengers, channel peers.
2. Per-lane CCIP **rate limits** set on every VPFI TokenPool via
   `VpfiPoolRateGovernor` (the bounds-checked `rateLimitAdmin`). Starting
   values: capacity 50,000 VPFI, refill ≈5.8 VPFI/s. The governor refuses
   to disable a lane's limit and range-bounds every value (ET-008).
3. The CCT admin (CCIP `TokenAdminRegistry`) and every cross-chain
   contract's owner = the admin multisig → governance timelock.

**Pause lever**: every cross-chain contract carries `GuardianPausable` —
guardian-or-owner `pause()`, owner-only `unpause()`, on both the send and
receive paths. A paused inbound reverts; CCIP records it as a failed
message, manually re-executable once unpaused, so nothing is lost.

**Chain scope (Phase 1)**: Ethereum, Base, Arbitrum, Optimism, BNB Chain.
zk-rollup chains and Solana are out of scope.

Full detail in
[`docs/DesignsAndPlans/LayerZeroToChainlinkCcipMigration.md`](docs/DesignsAndPlans/LayerZeroToChainlinkCcipMigration.md).

## VpfiBuyAdapter — payment-token mode by chain

The cross-chain VPFI buy adapter pulls funds from the user on the
source chain and forwards a BUY_REQUEST via Chainlink CCIP (post-
T-068, 2026-05-18) to the canonical Base receiver, which mints +
sends VPFI to the buyer.
The receiver quotes a single global wei-per-VPFI rate denominated in
**ETH-equivalent value** — not in the source chain's native gas. This
makes the payment-token mode a load-bearing per-chain config:

- **Native-gas mode** (`paymentToken == address(0)`): valid only on
  chains where 1 unit of native gas == 1 ETH for rate purposes. That
  set is Ethereum / Base / Arbitrum / Optimism / Polygon zkEVM and
  their public testnets (Sepolia / Base Sepolia / Arb Sepolia / OP
  Sepolia / Cardona). Buyer sends ETH as `msg.value`.
- **WETH-pull mode** (`paymentToken == <bridged WETH9>`): required on
  any chain where native gas isn't ETH-priced. That's **BNB Chain
  mainnet (chainId 56)** and **Polygon PoS mainnet (chainId 137)**
  if/when those land. Buyer must hold and approve a bridged-WETH
  ERC20; the adapter `safeTransferFrom`s the ETH-denominated amount.
  Native-gas mode on these chains would mean the user pays 1 BNB
  where the receiver expects 1 ETH worth of value — every buy
  mis-prices.
- **Testnet exemption**: BNB Smart Chain Testnet (chainId 97) and
  Polygon Amoy (chainId 80002) are intentionally NOT in the strict
  WETH-pull list. Their gas tokens have no real value and the
  testnet rate is symbolic, so native-gas mode is acceptable for
  dev-loop convenience. Mainnet equivalents must use WETH-pull.

**Deploy-time enforcement**:

`VpfiBuyAdapter.initialize` (and `setPaymentToken` rotation) runs
`_assertPaymentTokenSane(token)` before any state writes:
  - Non-zero `token` must have bytecode (`token.code.length > 0`)
    — catches an EOA address pasted into the env var.
  - `IERC20Metadata(token).decimals()` must succeed AND return
    exactly 18 — catches the most common honest-mistake misconfig
    (USDC's 6-dec address pasted where a bridged-WETH belongs)
    and the non-ERC20-contract case (`decimals()` reverts).

`DeployCrosschain.s.sol` itself reads `VPFI_BUY_PAYMENT_TOKEN` from
env (default `address(0)` = native gas) and forwards it to
`VpfiBuyAdapter.initialize` — it does **NOT** currently pre-flight
reject native-gas mode on the strict-WETH-pull chain set. The
chain-mode choice is therefore an **operator responsibility**:
operators must set `BNB_VPFI_BUY_PAYMENT_TOKEN` / `POLYGON_VPFI_BUY_PAYMENT_TOKEN`
to the chain's canonical bridged WETH9 on BNB Chain mainnet and
Polygon PoS mainnet, otherwise every buy on those chains misprices.
Adding a deploy-script pre-flight that rejects the wrong mode is a
small follow-up — tracked under the pre-audit-hardening card.

**What's NOT validated on-chain**: there's no on-chain registry that
says "this is the canonical bridged WETH9 on chain X". Confirming the
configured address really is the chain's published WETH9 (and not an
attacker-deployed mock that returns the right decimals) is an
**operational check**: the deploy script logs `name()`/`symbol()` for
human-eyeball confirmation, and the operator pastes the address from
the chain's canonical contracts list. Reference addresses for the
strict-WETH-pull chains:

- BNB Chain mainnet (56): canonical bridged WETH on BNB —
  `0x2170Ed0880ac9A755fd29B2688956BD959F933F8`. Confirm against
  bscscan + the chain's canonical bridged-asset registry before
  pasting into `BNB_VPFI_BUY_PAYMENT_TOKEN`.
- Polygon PoS mainnet (137): canonical WETH9 on Polygon —
  `0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619`. Confirm against
  polygonscan + the Polygon bridge contracts list before pasting
  into `POLYGON_VPFI_BUY_PAYMENT_TOKEN`.

Test coverage: `contracts/test/VpfiBuyFlowTest.t.sol` covers the
end-to-end buy flow (happy path, Diamond-rejects refund, forged-
delivery park, replayed-delivery park, recover-stuck-VPFI,
reclaim-timed-out-buy, per-request rate limit, pause-freezes-buy,
fee-surplus refund, two-step receiver retry) and the
`SetPaymentToken_RevertWhen_PendingBuysExist` pending-buy rotation
guard. The init-time `_assertPaymentTokenSane` revert paths
(`PaymentTokenNotContract`, decimals-mismatch, decimals-call-
reverts) and the `setPaymentToken` happy-path rotation are NOT yet
covered — adding those is tracked as a follow-up. When extending the
validation surface, add the new revert path to that test file.

## VPFI Fee Discounts — Time-Weighted + Claim-Based (Phase 5)

Both sides of the VPFI fee discount (lender yield-fee + borrower Loan
Initiation Fee) are **time-weighted** across a loan's lifetime and
**not** a point-in-time tier lookup. The lender discount reduces the
yield-fee treasury haircut at settlement; the borrower discount is
delivered as a VPFI **rebate** paid out alongside `claimAsBorrower`.

**Time-weighted accumulator (`LibVPFIDiscount.rollupUserDiscount`)**:
re-stamps the BPS at the **post-mutation** vault VPFI balance on
every change, so an unstake takes effect immediately for every open
loan's average. Pre-Phase-5 code stamped at pre-mutation balance,
which let a user keep a high-tier stamp after dropping to tier 0
until the next balance change — gaming vector. Always call rollup at
mutation sites passing the post-mutation balance; read-only snapshots
pass the live balance.

**Borrower LIF — Phase 5 flow**:

1. At `OfferFacet.acceptOffer` on the VPFI path: borrower pays the
   FULL 0.1% LIF equivalent in VPFI (not tier-discounted) from their
   vault into **Diamond custody** (not treasury). Amount recorded
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
(`createOffer`, `acceptOffer`, `getOrCreateUserVault`, VPFI
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
See [`docs/DesignsAndPlans/Roadmap.md`](docs/DesignsAndPlans/Roadmap.md) for the
fork plan.

The Sepolia test scripts (`SepoliaActiveLoan.s.sol`,
`SepoliaOpenOffers.s.sol`, `SepoliaPositiveFlows.s.sol`) call
`updateKYCTier(...)` / `setTradeAllowance(...)` defensively but those
calls are no-ops while enforcement is off and trade-pair checks are
unconditional. They can stay.

## graphify

This project has a graphify knowledge graph at graphify-out/.

Rules:

- Before answering architecture or codebase questions, read graphify-out/GRAPH_REPORT.md for god nodes and community structure
- If graphify-out/wiki/index.md exists, navigate it instead of reading raw files
- For cross-module "how does X relate to Y" questions, prefer `graphify query "<question>"`, `graphify path "<A>" "<B>"`, or `graphify explain "<concept>"` over grep — these traverse the graph's EXTRACTED + INFERRED edges instead of scanning files
- After modifying code files in this session, run `graphify update .` to keep the graph current (AST-only, no API cost)

## Executing forge

- When ever running forge build, forge script or forge test, run them in high priority
- [Run forge build / forge test in high priority](feedback_forge_high_priority.md) — prefix every forge build/test/script with `nice -n -10 ionice -c 2 -n 0`; viaIR runs are 5–15 min and 8 GB RSS, low priority causes 2–3× slowdowns under parallel desktop load

### Three `foundry.toml` profiles (Issue #185 + #296)

Three profiles live in `contracts/foundry.toml`:

- **`default`** — full coverage. Compiles `src/` + `test/` + `script/`,
  viaIR + optimizer (runs=200). Used by operator-local full-regression
  runs (via `bash script/run-regression.sh` — NOT the bare
  `forge test --no-match-path "test/invariants/*"`, which is non-sparse and
  can trip the viaIR whole-unit stack ceiling; see the "Local full regression"
  subsection below) and every mainnet-deploy path. Cold compile: 14-19 min, ~17.7 GB RSS
  on this codebase as of 2026-05-27 (over the 16 GB ubuntu-latest CI
  ceiling — NOT used by any GitHub Actions job for that reason).
- **`cifast`** — narrow scope for the per-PR-push CI lane. Compiles
  `src/` + `script/` + `test/deploy/**` + `test/scenarios/**` +
  `test/mocks/**` + `test/SetupTest.t.sol` + `test/HelperTest.sol` only.
  Same `viaIR + optimizer=200` settings as default. Used by EVERY
  forge-using job in `ci.yml` (contracts-fast, build-docs, slither).
  Cold compile: ~5 min, ~3.2 GB peak RSS. Skips the 94 non-positive
  top-level test files + invariants + fork tests — those run locally
  at end-of-step under the default profile.
- **`quick`** — fast inner-loop iteration. Compiles `src/` + `lib/`
  only (skips project `test/` and `script/`); viaIR + optimizer still
  ON (some src/ facets, e.g. `VaultFactoryFacet.sol:631`,
  structurally need viaIR to compile). Cold compile: ~44 s, ~677 MB
  RSS. Warm-cache + incremental: <1 s.

**When to use which:**

- Iterating on a contract change, want to know "does it compile?":
  `FOUNDRY_PROFILE=quick forge build` — ~44 s cold, <1 s warm.
- Running operator-local full regression: `bash script/run-regression.sh`
  (sparse compile — the bare `forge test --no-match-path "test/invariants/*"`
  can trip the viaIR ceiling; see "Local full regression" below). Scripts /
  predeploy-check / gas-snapshot diff: `forge build` / `forge script` —
  default profile.
- Running the invariant suite specifically (separate pass; full-
  regression command above excludes it): `forge test --match-path
  "test/invariants/*"` — default profile.
- Pre-PR sanity check (compile + targeted tests): default profile.
- CI (`ci.yml` + Slither + Build docs): runs under `cifast`. The
  `mainnet-gate.yml` workflow runs `predeploy-check.sh --full`
  under the default profile on `ubuntu-latest` and shares the
  16 GB ceiling — see ADR-0011 for the pre-release-track caveat.

**Do NOT use `FOUNDRY_PROFILE=quick` with `forge test`** — tests need
viaIR + optimizer parity with src/ to faithfully reproduce production
bytecode, AND the quick profile's `test/**` skip would empty test
discovery.

The high-priority `nice -n -10 ionice` prefix still applies to both
profiles — it's about scheduling priority, not the build itself.

### Local full regression — run it via `run-regression.sh` (sparse compile)

This codebase sits near the **viaIR whole-unit stack ceiling**. The bare
`forge test --no-match-path "test/invariants/*"` is **non-sparse**: it compiles
`src` + ALL `test` + ALL `script` in one `solc` unit, and the standalone deploy
scripts under `script/*.s.sol` push it over the edge — failing with
`Error: Variable size is N too deep in the stack` even when every test is
correct (a compilation-unit-size limit, not a code bug; see Issue #601 and the
#603 release note). CI sidesteps it via the narrower `cifast` lane. Run the full
**local** regression through the helper instead:

```bash
# from contracts/ (all build/test commands run there, per the top of this doc):
bash script/run-regression.sh              # full suite minus invariants
bash script/run-regression.sh --invariants # + the invariant suites
```

It runs `forge test --match-path 'test/*.t.sol' --no-match-path
'test/invariants/*'` (forcing `FOUNDRY_PROFILE=default`). Driving with
`--match-path` makes Foundry compile **sparsely** — only the matched files +
their dependency closure — so the standalone scripts that no test imports are
left out, and dropping that slice of IR keeps the unit under the ceiling. The
deploy logic still compiles where it matters (DeployDiamond.s.sol is pulled in
as a dependency of `test/deploy/DeployDiamondIntegrationTest`).

**Cannot miss a suite:** globset's `*` crosses `/` (see `contracts/foundry.toml`),
so `test/*.t.sol` recursively matches every current and future `*.t.sol`
anywhere under `test/` — a newly-added suite is picked up automatically; there
is no chunk list, folder layout, or allowlist to keep in sync. (Standalone
scripts' compile-correctness is covered separately by `forge build` /
predeploy-check.)

The principled cause-fix that keeps the unit small is to return **lean DTOs**
from paginated / array views (the #603 `OfferSummary`/`LoanSummary` pattern) —
never an array of a 40+-field struct, whose ABI coder inflates peak stack. If
the test slice alone ever trips the ceiling, fall back to splitting the run into
two `--match-path` globs (e.g. `test/[A-M]*.t.sol` + `test/[N-Z]*.t.sol` + the
subdirs), but that is not needed today.

## Task tracking — @vaipakam-labs GitHub Project is the live tracker

The single live tracker for in-flight and queued work is the GitHub
Project [`@vaipakam-labs`](https://github.com/users/vaipakam/projects/1).
Always treat it as the source of truth. The dated
`docs/internal/PendingTasks-yyyy-mm-dd.md` pattern is **retired**;
[`docs/internal/PendingTasks-2026-05-14.md`](docs/internal/PendingTasks-2026-05-14.md)
is frozen as the last one in that series and exists only as a
historical breadcrumb.

**Where each kind of artifact lives:**

| Artifact | Home | Why |
| --- | --- | --- |
| Active / queued work, prioritization, sprint assignment | `@vaipakam-labs` Project (Issues + Drafts) | One curated board; status / priority / size / module / iteration fields drive the cadence. |
| User's free-form thoughts and scratch notes | [`docs/internal/RoughNotes.md`](docs/internal/RoughNotes.md) | Owned by the user, not by me. I do not edit it. |
| User-facing follow-up list of ideas the user has tossed in | [`docs/ToDo.md`](docs/ToDo.md) | Open ET-### items are promoted to Project Issues; closed ones stay ticked for audit history. |
| Shipped work + functional narrative | `docs/ReleaseNotes/ReleaseNotes-yyyy-mm-dd.md` | Append per release per [`feedback_doc_convention.md`](/home/pranav/.claude/projects/-home-pranav-Codes-Vaipakam-vaipakam/memory/feedback_doc_convention.md). |
| Spec / design exploration | `docs/DesignsAndPlans/*.md` | Lives alongside the code; referenced from the Project card. |

**Project conventions (UI fields + labels both reinforce intent):**

- Labels are standardized in [`.github/LABELS.md`](.github/LABELS.md) —
  read it before applying any label. The doc names: default GitHub
  labels (`bug`, `enhancement`, `documentation`, `good first issue`,
  `help wanted`, `question`, `duplicate`, `invalid`, `wontfix`) and
  Vaipakam-specific labels (`security`, `audit`, `chore`, `refactor`,
  `infra`, `perf`, `testnet-rehearsal`, `mainnet-rollout`).
- Pick one primary type label per Issue: `bug` / `enhancement` /
  `documentation` / `chore` / `refactor` / `infra` / `perf`. Add
  `security` / `audit` / `testnet-rehearsal` / `mainnet-rollout` as
  cross-cutting overlays.
- Mirror label intent into the Project's custom fields (`Module`,
  `Priority`, `Size`, `Estimate`, `Iteration`) — labels are the
  cheap signal, fields drive the views.
- Issue Templates ([`.github/ISSUE_TEMPLATE/bug.yml`](.github/ISSUE_TEMPLATE/bug.yml)
  + [`.github/ISSUE_TEMPLATE/feature_request.yml`](.github/ISSUE_TEMPLATE/feature_request.yml))
  auto-apply the primary label and auto-assign `Raja4Shekar`. Blank
  issues are disabled via [`.github/ISSUE_TEMPLATE/config.yml`](.github/ISSUE_TEMPLATE/config.yml);
  security disclosures route to the IncidentRunbook, not public
  Issues.
- New Issues land on the Project automatically via the
  [`actions/add-to-project@v1.0.2`](.github/workflows/add-to-project.yml)
  workflow in each repo, using the `ADD_TO_PROJECT_PAT` secret. This
  is the multi-repo workaround for GitHub Projects' one-repo-per-UI-rule
  Auto-add limitation (per https://github.com/orgs/community/discussions/47803);
  the in-app Auto-add workflow stays disabled.

**Rules of engagement for me (the agent):**

1. When picking up new work, scan `@vaipakam-labs` first via
   `gh project item-list 1 --owner vaipakam --format json` (or the
   linked URL) before reading the legacy `PendingTasks-2026-05-14.md`
   /  `ToDo.md` files. Treat those files as read-only history except
   for ticking closed ET-### checkboxes when sweeping.
2. When the user surfaces a new idea, promote it to a Project Issue
   within the same session (or, at most, on the next pickup) using
   the appropriate Issue Template. Do not bury new ideas inside
   `RoughNotes.md` — that file is the user's, not mine.
3. When closing work, link the closing commit / PR to the Project
   Issue and let the Action close + move the card. Mirror the
   closure into `docs/ReleaseNotes/ReleaseNotes-yyyy-mm-dd.md` for
   the functional narrative — per the doc convention, no code in
   release notes.
4. When applying labels, pick from `.github/LABELS.md` exclusively.
   If a needed label is missing from that doc, add it there first
   (with a one-line "use for" entry), then apply.

## Release notes — per-PR fragments

Release notes use a **fragment** model so they merge atomically with the
work and never lag behind a merge.

- **Every behaviour-changing PR carries its own fragment** in its diff:
  a file `docs/ReleaseNotes/unreleased/<TASK-ID>-<slug>.md`, written in
  plain English (no code), describing what changed and why. Copy
  `docs/ReleaseNotes/unreleased/_TEMPLATE.md` as the starting point.
  This is part of the PR — not a post-merge step.
- **After the day's PRs merge**, fold the fragments into the dated file:
  `bash docs/ReleaseNotes/assemble.sh` (defaults to today UTC; pass a
  `YYYY-MM-DD` to override). It concatenates every pending fragment into
  `docs/ReleaseNotes/ReleaseNotes-<date>.md`, removes the fragments, and
  prints the commit steps. Review, add an intro paragraph, commit.
- A non-blocking CI check (`.github/workflows/release-notes-drift.yml`)
  warns in the Actions tab if a merge to `main` changed `contracts/src/`
  or `apps/` but added no `docs/ReleaseNotes/` entry.

This is the structural half of the post-merge definition-of-done: every
merge → release notes + tick the related `docs/ToDo.md` entry + the
`@vaipakam-labs` card moves to Done (automatic, via `Closes #<issue>` in
the PR body). Never batch the release-notes update.

## Functional specs — per-PR domain updates

`docs/FunctionalSpecs/` is the **code-free, implementation-independent**
specification of what the platform is **intended** to do — the test
oracle. **Load-bearing rule: it is sourced from the documents, never
transcribed from the contract code.** A spec derived from the code
cannot catch a bug — it would just confirm "the code does what the code
does" and lock real bugs in. The code is the thing *under test*, never
the *source* of the spec.

It is kept current the same way release notes are: **every
behaviour-changing PR updates the relevant
`docs/FunctionalSpecs/<domain>.md` in the same diff as its release-note
fragment** — not as a post-merge step (a separate step drifts).

- The release-note fragment is the *changelog* ("PR #N changed X"); the
  Functional Spec edit is the *intended-behaviour* view ("the platform
  is meant to do X"). The author **states the intent** they set out to
  build — never transcribes the code just written. If that code has a
  bug, the spec stays correct and the divergence audit catches it.
- Code-free — plain English, observable/testable behaviour. No Solidity,
  TypeScript, or ABIs.
- `docs/FunctionalSpecs/_CodeVsDocsAudit.md` records code-vs-spec
  divergences (candidate bugs / stale docs). Code-observed behaviour
  enters the spec **only** via an explicit human intent-decision — never
  silently.
- The drift check in `.github/workflows/release-notes-drift.yml` warns
  (non-blocking) if a merge changed `contracts/src/` or `apps/` but
  touched no `docs/FunctionalSpecs/` doc — same backstop the release-note
  fragments have.
- See [`docs/FunctionalSpecs/README.md`](docs/FunctionalSpecs/README.md)
  for the doc set, the domain slicing, the conflict-precedence rule, and
  the full rules.

Release notes, design docs (`docs/DesignsAndPlans/`), and functional
specs stay separate on purpose: changelog vs. design exploration vs.
intended-behaviour spec.

## Dependabot — off-chain only

Dependency-update automation is scoped on purpose (see `.github/dependabot.yml`):

- **Covered** — `github-actions` (CI action versions) and `npm` (the
  pnpm workspace: `apps/*` + `packages/*` — viem, wagmi, React, wrangler,
  transitive deps). Weekly, grouped, `infra`-labelled.
- **Deliberately NOT covered** — the on-chain Solidity dependencies
  under `contracts/lib/` (forge-std, openzeppelin-contracts-upgradeable,
  chainlink-local, diamond-3-hardhat). They are git submodules pinned to
  an AUDITED commit set; bumping one changes audited bytecode, so it must
  be a deliberate, reviewed, re-audited decision — never an automated PR.
  No `gitsubmodule` ecosystem is configured, precisely so Dependabot
  leaves the contract dependency set frozen.

Every `uses:` in `.github/workflows/` is pinned to a full commit SHA
(with a trailing `# vX` comment that Dependabot reads to offer bumps) —
a moved tag can't silently change CI behaviour.

Dependabot PRs are **never auto-merged** — each goes through the same
review + CI + Codex review as any other change; a Dependabot PR touching
anything the keeper / agent signing path depends on gets full scrutiny.
