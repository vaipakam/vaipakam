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
| **OfferAcceptFacet**   | Accept an offer → initiate the loan. **`chargeBorrowerLifAndDeliver` is NOT here** — #1835 moved it to `OfferAcceptFeeFacet` below, so a grep of this facet for the LIF charge comes back empty |
| **OfferAcceptFeeFacet** | The borrower-LIF charge + net-principal delivery `_acceptOffer` reaches via `crossFacetCall`. Split out of `OfferAcceptFacet` in #1835, which had reached 24,412 bytes — 164 under EIP-170, less than one cross-facet call, so every queued accept-path change was undeployable (the #1780 condition again). The seam was ALREADY a Diamond boundary: the charge has been `external` + `address(this)`-gated since it was written, run behind a self-call so its stack depth stays out of `_acceptOffer`'s at-budget viaIR frame. Selector unchanged by the move. **The two must be refreshed together** — one behaviour across a self-call, so refreshing either alone runs half the accept on pre-split code |
| **LoanFacet**          | Initiate loans, enforce HF >= 1.5 and LTV constraints                       |
| **RepayFacet**         | Full/partial repayment, NFT daily deductions, late fees                     |
| **DefaultedFacet**     | Time-based defaults (grace period expired)                                  |
| **RiskFacet**          | LTV/Health Factor calculation, HF-based liquidation via 0x swap             |
| **OracleFacet**        | Chainlink price feeds, v3-style concentrated-liquidity AMM liquidity checks |
| **VaultFactoryFacet** | Per-user UUPS vault proxy deployment                                       |
| **VaipakamNFTFacet**   | Mint/update/burn position NFTs (ERC721, on-chain metadata)                  |
| **ProfileFacet**       | User country (sanctions), KYC verification                                  |
| **AdminFacet**         | Treasury, 0x proxy, allowance target config                                 |

**Early-exit / settlement facets — all LIVE, none a placeholder** (#1657). An
earlier version of this table called these "Placeholder facets (Phase 2)". They
are not, and had not been for some time: each is cut into the Diamond by
`DeployDiamond.s.sol` (the test-side `DiamondFacetNames.cutFacetNames()`
mirrors that `cuts[]` array and is what the deploy-sanity suite checks against
— update the script when adding a facet, not only the mirror), each moves
funds, and several
carry invariants **this document states elsewhere**: the VPFI-LIF
settle/forfeit rules below name Preclose and Refinance as proper-settlement
terminal paths, and the retail-deploy section lists both among the Tier-1
entry points that revert for sanctioned callers. The retired line contradicted
its own document in two places.

"Placeholder" reads as *do not expect behaviour here*, which is the opposite of
true on a settlement path, and it cost real time in #1503.

| Facet                      | Role                                                                        |
| -------------------------- | --------------------------------------------------------------------------- |
| **PrecloseFacet**          | Borrower early close-out: `precloseDirect`, obligation handover to a replacement borrower (`transferObligationViaOffer`), and the offset route (`offsetWithNewOffer` → completion). Completion has TWO entries: `completeOffset` (external) and `completeOffsetInternal` — the `address(this)`-gated cross-facet entry `_acceptOffer`'s auto-link block invokes when a third party accepts the offset offer, skipping the outer `nonReentrant` because the accept already holds the diamond guard. Don't assume a manual second step |
| **RefinanceFacet**         | Move a borrower onto better terms — `refinanceLoan`, `refinanceLoanFromAccept`. NOT an in-place edit: the replacement loan is a **separate record** (`s.offerIdToLoanId[borrowerOfferId]` → a new `loanId`) created when the new lender accepted the offer, and the old loan is terminalized **Active → Repaid**. So a completed refinance leaves **two loan records and FOUR position NFTs**: every loan carries both a `lenderTokenId` and a `borrowerTokenId`, and the old pair is *status-updated* to `LoanRepaid` — **not burned** — so `ownerOf` still resolves and the old borrower NFT stays a redeemable receipt on the original position. Load-bearing for indexer state and the terminal-path invariants: an indexer that assumes one NFT per loan, or that a terminal loan's NFTs are gone, is wrong on both counts |
| **EarlyWithdrawalFacet**   | Lender exit, LISTED route only: `createLoanSaleOffer` (carries a MANDATORY finite expiry) → completion. Completion mirrors the offset route's shape: `completeLoanSale` (external) plus `completeLoanSaleInternal`, the `address(this)`-gated entry `_acceptOffer` invokes automatically after a buyer accepts the linked sale offer. **`sellLoanViaBuyOffer` is NOT here** — #1780 moved it to `EarlyWithdrawalDirectFacet` below, so a grep of this facet for the direct sale comes back empty |
| **EarlyWithdrawalDirectFacet** | Lender exit, DIRECT route: `sellLoanViaBuyOffer` — instant sale into a standing lender ("buy") offer in one transaction. Split out of `EarlyWithdrawalFacet` in #1780, which had reached 30 bytes under EIP-170 — less than one cross-facet call, so every queued fix to either route was undeployable. Same storage, same Diamond, same call surface for callers; only the runtime bytecode is separate. **The two must be refreshed together** — the redeploy scripts carry both, and refreshing one alone leaves the other on pre-split code. Both are sale hosts that reach `RiskPreviewFacet.saleAdmission` through `LibSaleSolvency`, so a curated refresh script touching either must also route that selector (#1649) |
| **PartialWithdrawalFacet** | Release surplus collateral while a loan is open — `calculateMaxWithdrawable`, `partialWithdrawCollateral` |
| **TreasuryFacet**          | Treasury operations (56 functions — claims, buyback intents, remittance absorption, asset conversion). Custody is **deployment-mode dependent**: `LibFacet.recordTreasuryAccrual` only credits `treasuryBalances` when `s.treasury == address(this)`, so on the documented mainnet topology (`TREASURY_ADDRESS` = an external multisig) fees leave immediately and the claim / conversion paths have nothing at the Diamond to act on. Those paths are for Diamond-as-treasury deployments |

Two of them do carry a genuine *future-scope* note in their own headers, which
is what the retired line probably grew out of: TreasuryFacet's "expand for
Phase 2 (governance distributions, reserves)" and PartialWithdrawalFacet's
"expand for Phase 2 (multi-collateral, governance-configurable threshold)".
Those describe work not yet done **on top of** shipped behaviour — they do not
make either facet a stub. Note also that "Phase 2" appears inside several
facets as *task* numbering (`T-092 Phase 2a`, `#671 phase 2`); that is
unrelated to delivery status.

### Liquid vs Illiquid Assets

- **Liquid**: Has Chainlink feed + v3/v2-style concentrated-liquidity AMM pool that passes the **slippage-at-floor** liquidity probe (a $5k trade at ≤2% slippage — NOT a "$1M volume" test, which was retired with the dead `MIN_LIQUIDITY_PAD`) → LTV/HF checks apply, adapter swap (0x/1inch via `LibSwap`) on liquidation
- **Illiquid**: NFTs or tokens without oracle → valued at $0, full collateral transfer on default, both parties must explicitly consent

### Two Liquidation Paths

1. **HF-based** (RiskFacet): HF < 1e18 → permissionless 0x swap, liquidator gets bonus
2. **Time-based** (DefaultedFacet): Grace period expired → liquid assets get swapped, illiquid get transferred directly to lender

### Key Constants (LibVaipakam.sol)

- `MIN_HEALTH_FACTOR = 1.5e18` — minimum HF at loan initiation
- `TREASURY_FEE_BPS = 200` — 2% treasury cut on interest (the rev-8 fee
  freeze, #1352; it was `100` = 1% before). Resolved **per loan** from
  `treasuryFeeBpsAtInit`, so a governance retune never re-prices an open
  loan. `LEGACY_TREASURY_FEE_BPS = 100` is the frozen fallback for
  pre-#957 loans that carry no stamp — do NOT "simplify" that fallback to
  the live knob, it would retroactively reprice every grandfathered loan
  from 1% → 2% at repay
- `LOAN_INITIATION_FEE_BPS = 20` — 0.2% of ERC-20 principal, charged once
  at accept (also the #1352 freeze; was `10` = 0.1%). Since #1352 it is
  charged in the **lending asset**, not VPFI — see the scope banner in
  "VPFI Fee Discounts" below
- `MAX_FEE_BPS = 5_000` (in `ConfigFacet`) — 50% ceiling for
  `treasuryFeeBps` / `loanInitiationFeeBps`; `MAX_FEE_DISCOUNT_BPS = 5000`
  — the uniform 50% clamp on any party's effective fee discount, which
  binds well below the 90% per-tier setter cap (`MAX_DISCOUNT_BPS`)
- `KYC_TIER0_THRESHOLD_NUMERAIRE = 1_000e18` / `KYC_TIER1_THRESHOLD_NUMERAIRE = 10_000e18` — two-tier KYC thresholds ($1k / $10k, numeraire-denominated). Enforcement is **dormant on the retail deploy** (see "Retail-deploy policy" below); there is no single `KYC_THRESHOLD_USD = 2000e18` constant (that value is stale)
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

`--full` **delegates to `run-regression.sh`** (#1620) — it does not carry
its own regression command. There is exactly one chunking implementation;
if the viaIR ceiling moves again, `run-regression.sh` is the only place to
fix, and both the mainnet preflight and the release-track
`mainnet-gate.yml` inherit the fix. Don't re-inline a `forge test` call
here: an un-chunked pass trips the ceiling as a COMPILE failure, which this
gate reports with the same "regression failed" wording as a red test — a
green-looking suite that never ran is the failure mode this delegation
exists to prevent.

**When you add a facet**, it must be registered in several places. This note
listed two until #1793; the omissions are where #1780's new facet actually went
missing. Paths are repo-root-relative.

**ALWAYS required** — skip one of these and the facet is absent from a deploy
path or a guardrail:

| Place | What it drives |
| --- | --- |
| `contracts/script/DeployDiamond.s.sol` | `cuts[]`, `_get<Facet>Selectors()`, **and a `Deployments.writeFacet(...)` line** |
| `contracts/script/RefreshAllFacetsInPlace.s.sol` | `_deployItems()`'s `items[]` **and** `EXPECTED_FACETS` |
| `contracts/test/deploy/DiamondFacetNames.sol` | `cutFacetNames()` — ground truth for the whole deploy-sanity suite |
| `contracts/test/deploy/SelectorCoverageTest.t.sol` | `_populateRoutedSet()` |
| `contracts/test/HelperTest.sol` | the test-side Diamond build |
| `contracts/test/SetupTest.t.sol` | shared test setup |
| `packages/contracts/src/deployments.ts` | a field on the `Deployment` type — mandatory as soon as `DeployDiamond` writes the new key |

**Conditional** — required only when the stated condition holds, so *not*
registering these can be correct:

| Place | Condition |
| --- | --- |
| `contracts/script/RedeployFacets.s.sol` | only if the facet belongs to one of that script's curated refresh families — it is a *curated* partial refresh, not an all-facets one |
| `contracts/script/lib/FacetSelectors.sol` **+ a matching case in `contracts/test/deploy/RedeploySelectorParityTest.t.sol`** | only when the facet ALREADY HAS a getter in `FacetSelectors` — that is the condition, not "the curated scripts cut it", which is true of far more facets than the library covers (`ReplaceStaleFacets` cuts `ConfigFacet`, `OfferAcceptFacet` and others through `DeployDiamond`'s inherited getters, and those need nothing here). A brand-new facet needs a getter only if you are adding it to a curated script's set. These are ONE step, not a step and its guard: the parity test enumerates each facet BY HAND, so adding a getter without adding its case compiles happily and leaves that selector list entirely unpinned. The same list must also be updated when a covered facet gains, loses or renames an external FUNCTION — see "When you add a function to a facet" below |
| `contracts/script/exportFrontendAbis.sh` (`FACETS=(...)`) | only if an app actually consumes the facet's ABI. Internal facets are deliberately excluded — `ReceiverFacet` is not in that array and should not be |
| `packages/contracts/src/abis/index.ts` | only alongside the entry above — the export script does **not** touch this barrel |

The last two are covered in more detail in "Frontend ABI sync" **below**.

**Two of these do not fail loudly, so do not rely on a red check:**

- **`RefreshAllFacetsInPlace`'s guard compares against itself.**
  `require(items.length == EXPECTED_FACETS, "...facet count drift vs
  DeployDiamond")` says "vs DeployDiamond" but checks the script's own
  constant — omit the facet from both lines and it passes, and the refresh then
  leaves that facet on stale bytecode.
  `contracts/test/deploy/RefreshScriptFacetParityTest` (#1793) is what makes
  this loud: it cross-checks the count against `cutFacetNames()`, asserts every
  `items[]` slot is actually populated (allocation is sized from the constant,
  so a forgotten assignment leaves a zero slot that every length check
  accepts), and compares the refresh's **selector set** against the Diamond the
  deploy script actually builds — so a same-count *swap* of one facet for
  another cannot pass either.
- **`DeployDiamond`'s `writeFacet` omission is invisible to `predeploy-check`.**
  Step 4b validates that every key *written* to the deployment artifact is typed
  on `Deployment`; it is structurally blind to a key never written, so the gate
  reports success. #1793 assumed one facet was in that state; building a check
  for it found **thirteen** — all already typed on `Deployment`, because
  `RefreshAllFacetsInPlace` writes all 73 keys through `items[i].key`, so only a
  never-refreshed chain was missing them. Those thirteen writes are now in the
  deploy script.

  **There is no automated guard against this recurring yet**, and that is a
  deliberate, recorded position rather than an oversight. A step-4c that read
  the deploy scripts as text was written and then withdrawn: review found
  thirteen distinct ways to get a registration past it, and each fix opened the
  next. Proving "this registration executes, under this identity, on every
  chain" is a question about scope, control flow and aliasing, and a shell
  parser reading lines of Solidity cannot answer it — it was reaching a green
  verdict it had not earned, which on a pre-deploy gate is worse than no gate.
  **#1800** replaces it with the assertion that needs no parsing: run the deploy
  with artifact writing on and require every address `facetAddresses()` reports
  to appear in the JSON it wrote. The refresh-key-identity check
  (`RefreshScriptFacetParityTest` documents it as out of its own scope) goes
  there too.

  Note also that this class of omission is an inconvenience rather than a lost
  address — the implementation stays recoverable on-chain via
  `DiamondLoupeFacet.facetAddress(bytes4)` / `facetAddresses()` from any known
  selector, and from broadcast logs.

**When you add a function to a facet**: add its selector to the matching
`_get<Facet>Selectors()` in `DeployDiamond.s.sol` (and `HelperTest.sol`) —
`SelectorCoverageTest` fails otherwise.

There is a **third** registration site, and only for some facets, which is why
it is easy to miss: `contracts/script/lib/FacetSelectors.sol` carries the FULL
external surface of the facets the curated redeploy scripts cut — the library's
getters are the list, so read them there rather than trusting a copy here.
Adding an external function to any of those facets means adding
its selector there too. `RedeploySelectorParityTest` pins each list to the
compiled ABI's `methodIdentifiers` **exactly** — same size, nothing missing,
nothing extra — so the omission fails the deploy-sanity suite rather than
passing silently. Facets outside that set need nothing here.

**Deleting or renaming a function needs more than deleting the line.** Dropping
a selector from the library turns the parity test green and simultaneously makes
the curated script blind to that selector — so its OLD route stays live on the
stale implementation, which is the split Diamond again by the opposite door. A
retired selector needs an explicit `FacetCutAction.Remove` leg, the way
`RedeployFacets` handles the retired `uint8` keeper signatures via
`_legacyProfileRemovedSelectors()`. The library update is necessary and not
sufficient.

**`RiskPreviewFacet` has a FOURTH copy of its surface**, and it is a shell
array: `contracts/script/rehearse-partial-refresh.sh` hard-codes
`RISK_PREVIEW_SELECTORS`, and `assert_risk_preview_routed` iterates only that
array. Its own comment claims it is "the same set the refresh scripts cut",
which is true only for as long as somebody keeps it so. Add the new selector
there too, or the rehearsal reports that *all* selectors share one host while
never having looked at the one you just added — a passing check that has stopped
checking the thing you changed.

(One exception, and it is in the test rather than the rule: `vaipakamNFT` is
pinned to the facet's ROUTED surface, which is its compiled ABI minus
`supportsInterface(bytes4)` — that selector is compiled into the facet but cut
to `DiamondLoupeFacet` instead.)

Why the list exists at all (findings #778 / #779): a `Replace` diamondCut must
carry a facet's WHOLE routed surface, because an ALREADY-ROUTED selector left
out of the cut stays pointed at the OLD implementation — a split Diamond running
two versions of one facet. The curated scripts used to hand-list partial subsets
and drift.

**A newly ADDED function fails differently, and the distinction matters when you
are reading a revert.** Its selector was never routed, so omitting it cannot
strand it on old bytecode; it stays unrouted and calls revert
`FunctionDoesNotExist` through the Diamond fallback. It also cannot go in a
`Replace` at all — `Replace` requires an existing route — which is why the
production scripts partition each list by live routing and put unrouted
selectors in an `Add` cut. Reserve "split Diamond" for the stale-selector case;
the new-function case is a hard revert, not a silent divergence.

**Which script reads which list is uneven, and worth knowing before trusting a
green parity test.** `RedeployFacets.s.sol` reads most of them;
`UpgradeOracleFacet.s.sol` reads `oracle`. But `offerPreview` has **no script
consumer at all** — it is read only by tests — and `ReplaceStaleFacets.s.sol`
does not import this library at all. Its Oracle, VaultFactory, RiskPreview and
OfferPreview cuts use `_getOracleSelectors()`, `_getVaultFactorySelectors()`,
`_getRiskPreviewFacetSelectors()` and `_getOfferPreviewSelectors()` inherited
from `DeployDiamond`, while their parity cases check the separate
`FacetSelectors` getters.

So for those four facets, updating `FacetSelectors` satisfies the parity test
while the `ReplaceStaleFacets` cut is still driven by `DeployDiamond`'s own
lists. **Update both, and do not read a green parity test as proof that a
`ReplaceStaleFacets` cut is complete.** `grep` for the getter to see who
actually consumes it rather than assuming the library is the single source
everywhere — it is for some of these facets and not for all.

The deploy-*integration* test that Issue #72 asked for **already exists** and
runs in the deploy-sanity suite:
`contracts/test/deploy/DeployDiamondIntegrationTest.t.sol` invokes the real
`DeployDiamond.runWith(...)` and loupe-asserts the built Diamond, including
per-selector ownership. This note previously said it was "tracked as Issue #72",
which presented a shipped CI guard as a coverage gap and pointed contributors at
duplicate work.

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
bash contracts/script/exportFrontendAbis.sh   # runs its own --skip test build
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

**`NNNN` must be unique** — enforced by
`apps/indexer/scripts/check-migration-prefixes.mjs` (wired into
`pnpm --filter @vaipakam/indexer typecheck`). D1 keys its applied record
on the FILENAME, so two files sharing a number both apply and nothing
looks wrong; what breaks is REPLAY ORDER on a fresh environment, which
sorts lexicographically by slug and need not match the order production
experienced. One historical collision (`0011`) is grandfathered in the
script with its reasoning — **do not renumber an already-applied
migration**, since that changes its `d1_migrations` key and re-runs it.

`ops/mesh-watcher` uses a **separate** D1 (`vaipakam-mesh-alerts-db`,
schema in `ops/mesh-watcher/migrations/`) for trust-boundary reasons —
its internal ops alerts must not co-locate with user-facing data. Don't
fold those tables into `vaipakam-archive`. (The retired `ops/lz-watcher`
followed the same rule with `vaipakam-lz-alerts-db`; both the Worker and
its source tree were removed in #1440, and the database is an operator
deletion gated on one clean nightly backup.)

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
pnpm --filter @vaipakam/app exec tsc -b --noEmit
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
- `TG_OPS_BOT_TOKEN` — ops-internal bot. Used by `ops/mesh-watcher`
  (VPFI recycling-mesh ledger invariants) + `ops/offchain-data-warm`
  (nightly backup outcomes + weekly healthcheck verdicts). Posts to a
  single operator chat (`TG_OPS_CHAT_ID`). The retired `ops/lz-watcher`
  used it too before #1440 removed that Worker and its source.

Splitting bounds the blast radius of a token leak. A user-bot
compromise can't spoof ops alerts (the operator acts on detection
signals from those — backup failure, lane drift); an ops-bot
compromise can't reach the user-alert channels. When adding a new
Worker, pick the matching token based on **who reads the alert**,
not on convenience.

**Omit-keys policy for chain shape variance**: canonical-VPFI chains
(Base / Base Sepolia) carry `vpfiOftAdapter` (the lock/release CCT
TokenPool — legacy "Oft" name, CCIP CCT post-T-068); mirror chains
(Sepolia, Arb Sepolia, etc.) carry `vpfiMirror` (burn/mint). Each
chain's stanza in the consolidated JSON only includes the keys that
apply to it — there are NO `0x0000…0000` sentinels for "doesn't apply
on this chain". Mixing zero-address sentinels into address slots is a
real DeFi bug class (`address(0)` already means real things in
Solidity: the ETH sentinel, default-treasury, burn). The TS
`Deployment` type marks non-universal fields as optional and consumers
narrow on the `isCanonicalVPFI` / `isCanonicalReward` booleans before
reading scoped fields. (The former `vpfiBuyReceiver` / `vpfiBuyAdapter`
keys and the `vpfiBuyPaymentToken` native-gas `0x0000…0000` sentinel
were **removed** with the #687-A fixed-rate-buy excision — they no
longer appear in any chain stanza; see the "VpfiBuyAdapter — REMOVED"
note below.)

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
- `VaipakamRewardMessenger` — cross-chain reward accounting.
- `RewardRemittanceReceiver` / `BuybackRemittanceReceiver` — the
  reward-budget and buyback remittance receive paths (the two
  cross-chain receivers that actually ship in `crosschain/`).

  > The `VpfiBuyAdapter` / `VpfiBuyReceiver` fixed-rate cross-chain buy
  > flow was **removed** in the #687-A legal-surface excision — it is no
  > longer in the tree. There is no protocol VPFI purchase surface. See
  > [`docs/DesignsAndPlans/VPFISecuritiesFeatureExcision.md`](docs/DesignsAndPlans/VPFISecuritiesFeatureExcision.md)
  > and TokenomicsTechSpec §8.

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

**Chain scope (Phase 1)**: Ethereum, Base, Polygon, Arbitrum, Optimism.
BNB Chain is **testnet-tier only** (a cross-chain mirror / rehearsal
network), NOT a Phase-1 mainnet target — the FunctionalSpecs
(`ProjectDetailsREADME.md`, `TokenomicsTechSpec.md` §~227) are the source
of truth for the mainnet set. zk-rollup chains and Solana are out of scope.

Full detail in
[`docs/DesignsAndPlans/LayerZeroToChainlinkCcipMigration.md`](docs/DesignsAndPlans/LayerZeroToChainlinkCcipMigration.md).

## VpfiBuyAdapter — REMOVED (#687-A legal-surface excision)

The cross-chain fixed-rate VPFI buy flow (`VpfiBuyAdapter` /
`VpfiBuyReceiver`, the per-chain native-gas-vs-WETH payment-token modes,
the `_assertPaymentTokenSane` deploy-time enforcement, and the
`*_VPFI_BUY_PAYMENT_TOKEN` operator config) was **removed** in the #687-A
legal-surface excision and is no longer in the tree. There is no protocol
VPFI purchase surface. Do not reason about a "fixed-rate buy" — that is
exactly the securities-shaped surface the excision removed for legal
reasons.

- Design record: [`docs/DesignsAndPlans/VPFISecuritiesFeatureExcision.md`](docs/DesignsAndPlans/VPFISecuritiesFeatureExcision.md)
- Spec: `docs/FunctionalSpecs/TokenomicsTechSpec.md` §8 (supersede banner)
- What remains cross-chain: the CCIP messenger, the VPFI CCT mirror token
  + `LockReleaseTokenPool`/`BurnMintTokenPool`, `VaipakamRewardMessenger`,
  and the `RewardRemittanceReceiver` / `BuybackRemittanceReceiver`
  remittance receivers (see the Cross-Chain Security Policy section above).

## VPFI Fee Discounts — Time-Weighted + Claim-Based (Phase 5)

> **⚠ SCOPE — the borrower half of this section is GRANDFATHERED-ONLY.**
> #1352 retired the peg-custody borrower path. **New loans take no VPFI
> into `vpfiHeld` custody and earn no rebate**: the borrower's hold-tier
> discount is applied **directly to the lending-asset LIF at acceptance**
> (HoldOnly), or, where the per-party Full tariff is enabled, the party's
> `C*` is charged into Diamond custody and credited to
> `RecycleSource.FullTariff`. Everything below about up-front VPFI
> collection, Diamond custody for the life of the loan, and the rebate at
> settlement describes **only loans already open on the retired path** —
> they still settle through the retained lifecycle, which is why the
> settle/forfeit invariants remain live. **Do not reconnect
> `tryApplyBorrowerLif` on the strength of this section.** The LENDER half
> (yield-fee discount) is unaffected and current. See #1352, #1555.

Both sides of the VPFI fee discount (lender yield-fee + borrower Loan
Initiation Fee) are **not** a point-in-time tier lookup — but the
time-weighting is in the **TIER**, not in a per-loan average.
**There is no averaging over a loan's own window; T-087 Sub 1.B
removed it** (#1981, owner decision 2026-08-31: the code is the
intended behaviour, the docs were stale). The lender discount reduces
the yield-fee treasury haircut at settlement; the borrower discount is
delivered as a VPFI **rebate** paid out alongside `claimAsBorrower` on
the grandfathered peg-custody path (see the scope banner above).

**What actually resolves a discount —
`VPFIDiscountAccumulatorFacet.effectiveTierAndBps`**, three gates, all
of which must pass:

1. **Minimum staked duration.** Zero tier until the CURRENT stake has
   been held `cfgTwaMinStakedDaysEffective()` days (`setTwaMinStakedDays`,
   bounded **2–14**, default **3**). A balance that returns to zero
   clears `currentStakeStartSec` and restarts the clock.
2. **Recency-weighted TWA** (`_computeTwa` over `s.dayBalances.dayClose`)
   → `rawTier`. The window is `cfgTwaWindowDaysEffective()`
   (`setTwaWindowDays`, bounded **14–30**, default **30** — the upper
   bound IS the ring buffer's 30 slots), and the last
   `cfgTwaRecentDaysEffective()` days (default 7) carry
   `cfgTwaRecentWeightEffective()`× weight (default 3, bounded 1–10).
   **The scan floor is raised to `currentStakeStartDayId`**, so
   pre-stake days never dilute a new staker's average.
3. **Min-tier-over-history clamp** (`_computeRingBufferMinTier`, over
   each day's `dayMin`, so a same-day dip counts) →
   `effTier = min(rawTier, minOverHistory)`. Note it uses a DIFFERENT
   knob and the OPPOSITE floor rule from step 2: the window is
   `minDays`, but it is WIDENED down to `currentStakeStartDayId` when
   the stake is older, then floored at `today - 29`. So in practice it
   scans the whole life of the current stake, capped at 30 days.

**Do not write "30 days" as a fixed figure** in any doc derived from
this. It is the DEFAULT and the CAP, not the rule — #1981's first pass
said it flatly across twenty locale files and had to correct itself.

This is STRICTER than the loan-window average it replaced: an average
can be pulled up by a late spike, a minimum cannot, and `dayMin`
captures a same-day dip that a close-of-day read would miss. So the
anti-gaming claim the old wording made is still true — via a different
mechanism.

**`rollupUserDiscount` is NOT vestigial — its consumer moved.** The
rollup writes `dayBalances` (`dayClose` + `dayMin`), `lastUpdateDayId`
and `currentStakeStartSec`, which is exactly what the three gates
above read. Keep calling it at mutation sites with the
**post-mutation** balance (pre-Phase-5 code stamped pre-mutation,
which let a user keep a high-tier stamp after dropping to tier 0 —
gaming vector); read-only snapshots pass the live balance.

**What IS vestigial**, and must not be relied on: the monotone
`cumulativeDiscountBpsSeconds` total, now read only by
`VPFIDiscountFacet`'s public getter and by no fee path; and the
per-loan `lenderDiscountAccAtInit` / `borrowerDiscountAccAtInit`
anchors, still populated at init but never read. An earlier version of
this section said "don't bypass" `borrowerDiscountAccAtInit` — that
invariant no longer exists.

**Naming caveat**: `LibVPFIDiscount.lenderHoldTierDiscountBps` /
`borrowerHoldTierDiscountBps` were called `lenderTimeWeightedDiscountBps`
/ `borrowerTimeWeightedDiscountBps` until #1981. The old names claimed
a per-loan averaging they had not performed since T-087 Sub 1.B, and
are the likeliest reason this whole section went stale — a reader
checking the name instead of the body would have concluded the docs
were right.

**Borrower LIF — Phase 5 flow**:

1. At `OfferFacet.acceptOffer` on the VPFI path: borrower pays the
   FULL LIF equivalent in VPFI (not tier-discounted) from their
   vault into **Diamond custody** (not treasury). Amount recorded
   in `s.borrowerLifRebate[loanId].vpfiHeld`. (The rate that path was
   built against was the pre-#1352 0.1%; grandfathered loans settle at
   whatever they stamped. The live rate is 0.2% and is **not** charged
   this way — see the scope banner above.)
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
- ~~Loan struct `borrowerDiscountAccAtInit` is snapshotted in
  `LoanFacet._snapshotBorrowerDiscount` at loan-init; don't bypass.~~
  **Retired (#1981)** — the anchor is still written but no fee path
  reads it, so this is no longer an invariant. Left struck through
  rather than deleted because it was stated as a mainnet invariant for
  long enough that a reader may remember it and wonder where it went.
  Do not restore it without also restoring the loan-window averaging
  T-087 Sub 1.B removed.
- The diamond holds the custody VPFI until terminal; no intermediate
  transfer. A leaked `vpfiHeld` (non-zero on a Settled loan) is a bug.

Full detail in [`docs/TokenomicsTechSpec.md`](docs/TokenomicsTechSpec.md)
§5.2b and the Phase 5 section of
[`docs/ReleaseNotes-2026-04-23-to-24.md`](docs/ReleaseNotes-2026-04-23-to-24.md).

## VPFI rewards/recycling copy rules — release-gate checklist (RL-6)

Every PR that adds or changes a **user-facing recycling/rewards surface**
(app copy, docs, notifications, marketing) must pass the four-item
checklist in
[`docs/DesignsAndPlans/VPFITokenomicsRedesignResearch.md`](docs/DesignsAndPlans/VPFITokenomicsRedesignResearch.md)
§A.4 before merge: rewards are **usage rebates / fee discounts /
program longevity** (never yield, APY, income, deflation, scarcity, or
price); sized by the **user's own activity** (never pro-rata-to-holding,
never a cash-equivalent **revenue share**, never a promised rate);
**no market touch / published price / purchase surface** implied; and
the flow presented as **deterministic bookkeeping over fees already
received** (no operator-discretion framing). Vault-
delivered rewards (RL-1) are "rewards land in your vault, ready to use" —
never auto-staking or compounding. Issuer representations are the
dominant factor under release 33-11412, so this checklist is part of the
release gate, not optional style guidance.

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

### Live testnet review is part of definition-of-done (user directive 2026-07-05)

Every user-facing change merged to a deployed surface (`apps/*`) gets a
LIVE review on the deployed testnet site **after the production deploy**.
Review the deployment you just made: until the #1854 cutover completes,
`app.vaipakam.com` is NOT bound, so the target is the `workers.dev` URL
`pnpm run deploy` prints. Do not review `alpha02.vaipakam.com` as a
stand-in — it serves the frozen `vaipakam-alpha02` Worker, not the
`vaipakam-app` one the deploy publishes, so a green review there says
nothing about what shipped. Once the hostname is bound it becomes the
target. Then — drive the actual
feature end-to-end with the dev test wallets (the scratchpad Playwright
driver), and confirm the observable behaviour, not just preview builds,
typecheck, or CI. Contract-consuming changes additionally verify against
the live Base Sepolia Diamond (fallback paths proven by blocking the
other source where applicable). Exception: behaviours with no production
trigger (e.g. deliberate-crash fallbacks) may be verified on a preview
build, with the exception stated in the PR.

### Connected-app verification coverage — matrix + tiers (user directive 2026-07-06)

Every behaviour-changing PR to `apps/app` updates
[`apps/app/e2e/COVERAGE.md`](apps/app/e2e/COVERAGE.md) in the
same diff — the same per-PR discipline as release-note fragments and
functional specs. Two tiers:

- **CI-Anvil (default)**: a Playwright spec under `apps/app/e2e/tests/`,
  run automatically on every PR by the `fork-tier scenarios` job.
- **Live-only** (stated reason required — deployed Worker, Telegram,
  third-party API, real build env): a committed driver under
  `apps/app/e2e/live/`, run post-deploy per the live-review DoD and
  as a batch via `e2e/live/run-live-batch.mjs` before testnet releases.

The non-blocking `app-coverage-drift` workflow warns on merges that
change `apps/app/src/` without touching the e2e surface. Never park
live-review tooling in the session scratchpad — commit the drive with
the PR (or its follow-up) so the next regression doesn't rebuild it.

### Per-PR verification is TARGETED — full regression is a pre-deploy gate only

This is a standing workflow rule (do not run the full regression as a per-PR
gate):

- **Per change / per PR:** run only the **targeted** tests for the change —
  the new/edited `*.t.sol` + the directly-touched facets' suites + the
  deploy-sanity suite (`test/deploy/*`) when selectors/sizes change — via
  `forge test --match-path ...`. For the inner loop use
  `FOUNDRY_PROFILE=quick forge build`.
- **For the ABI re-export build, use `forge build --skip test`** — NOT a bare
  `forge build`. The bare build compiles the test-inclusive whole unit and
  trips the viaIR stack ceiling (the `BUILD FAILED` / "Variable size … too
  deep" #601/#603 issue); `--skip test` compiles `src/`+`script/` only, which
  is all `forge inspect` / the ABI export needs.
- **The full regression (`run-regression.sh`) runs ONLY before a testnet
  deployment — and ONLY in batches** (chunked `--match-path` globs, e.g.
  `test/[A-M]*.t.sol` then `test/[N-Z]*.t.sol` + the subdirs), never one
  monolithic run. It is never a per-PR gate. (User directive 2026-06-19,
  reaffirmed same day.)

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
  Same `viaIR + optimizer=200` settings as default. Used by
  `ci.yml`'s contracts-fast + slither jobs (build-docs runs its
  `forge doc --build` under `quick` instead — #1493).
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
- CI (`ci.yml` + Slither): runs under `cifast`. The Build docs job's
  `forge doc --build` runs under `quick` instead (#1493): forge doc
  performs its own solc pass over the active profile's source glob
  (it never reuses `out/`), and cifast's per-file test-skip
  enumeration lets newly added test suites drift back into that
  compile — quick's `test/**`/`script/**` globs can't. The
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

It runs the suite in **compile-bounded CHUNKS**, forcing
`FOUNDRY_PROFILE=default`. A single sparse `forge test --match-path
'test/*.t.sol'` pass used to be enough — matched files + their dependency
closure only, leaving out the standalone scripts no test imports — but ordinary
feature growth (#591) re-crossed the ceiling for even that, so the script now
splits the run so each `forge test` invocation stays under it:

- **Top-level suites** — `find test -maxdepth 1` enumerates them, and they run
  `CHUNK_SIZE` at a time (default 25) as brace globs of exact stems
  (`test/{A,B,…}.t.sol`). Brace globs of stems, not a `test/*.t.sol` glob:
  globset's `*` crosses `/`, so that pattern would recurse into the subdirs
  and defeat the split.
- **Subdirectory suites** — one pass per `SUBDIRS` entry (`scenarios deploy
  fork seaport token`), chunked `SUBDIR_CHUNK_SIZE` at a time (default 3;
  `fork` alone crossed the ceiling in a single glob by 2026-07-13).
- **`fork` files self-gate** on the RPC each needs — `FORK_URL_BASE_SEPOLIA`
  for the Seaport sources, `FORK_URL_MAINNET` for the rest — and are dropped
  when unset, so a no-URL pre-deploy gate stays green.

Foundry caches `src/` across invocations, so only the first chunk pays the full
src compile; the rest add just their own test files. Same total compile, in
ceiling-safe units. If a chunk ever trips, tune down with `CHUNK_SIZE=N` /
`SUBDIR_CHUNK_SIZE=N` rather than editing the script. Deploy logic still
compiles where it matters (DeployDiamond.s.sol is pulled in as a dependency of
`test/deploy/DeployDiamondIntegrationTest`); standalone scripts'
compile-correctness is covered separately by `forge build` / predeploy-check.

**Cannot miss a suite — but `SUBDIRS` IS a list to keep in sync.** Chunk
membership is derived from `find`, so a newly added `*.t.sol` in an
already-covered location is picked up automatically. A new *subdirectory* is
not: add it to `SUBDIRS`. An exhaustiveness guard cross-checks every
non-invariant test file against the covered set and **aborts the run** if one
is uncovered, so the failure is loud rather than a silently skipped suite — but
it fails the regression, so fix it by adding the subdir.

`predeploy-check.sh --full` delegates here (#1620), so the mainnet preflight and
the release-track `mainnet-gate.yml` inherit all of the above — including the
exhaustiveness guard.

The principled cause-fix that keeps each unit small is to return **lean DTOs**
from paginated / array views (the #603 `OfferSummary`/`LoanSummary` pattern) —
never an array of a 40+-field struct, whose ABI coder inflates peak stack.
Chunking bounds the symptom; lean DTOs are what stop the ceiling being
re-crossed.

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

## Codex PR-review policy (user directive 2026-07-05)

Codex is **NOT auto-invoked** on PR open or on pushes to a PR. It runs
ONLY when its trigger words appear in the PR description or a PR
comment (e.g. an `@codex review` comment). Apply this loop on every PR:

- **Docs-only PRs**: **merge after 2 Codex review rounds** (user
  directive 2026-08-07, verbatim "merge after 2 rounds as these are
  docs only PR, we can go for full convergence on codex findings for
  PR with code" — superseding the 2026-07-10 "up to 5 rounds"
  directive, which had itself superseded an earlier 2-round wording).
  Run round 1 → triage/fix every finding → round 2 → triage/fix →
  merge, regardless of whether round 2 was clean; merge earlier if a
  round converges (zero P1/P2). The cap bounds ROUNDS, not diligence —
  every finding still gets the accept-fix / refute / defer triage
  gate. Skipping entirely remains OK for trivial mechanical edits —
  say so in the thread.
- **Coding PRs**: keep triggering rounds until findings **converge**,
  allowing up to 10 rounds after the last SURFACE CHANGE in the code
  as a hard backstop. Only a substantive code change resets the
  count; replies, thread resolutions, and comment-only / docs-only
  tweaks do NOT (amended 2026-07-05, superseding the earlier
  "after the last diff push" wording). Re-trigger after every fix
  push.
- **Converged, operationally** (amendment 2026-07-05b): a round with
  ZERO P1/P2 findings (Codex's own severity badges). A P3-only round
  counts as clean — fix or defer P3s at the agent's judgment without
  restarting the loop.
- **Triage gate — every finding gets exactly one of** (2026-07-05b):
  1. *Accept + fix* in the PR (mechanical, minimal — no opportunistic
     refactors mid-loop; a real refactor legitimately resets the
     surface-change window).
  2. *Refute with evidence* in the thread (quote the code/behaviour
     that disproves it), then resolve.
  3. *Defer to a follow-up issue* — reply "Deferred to #NNN", open the
     issue (it lands on the @vaipakam-labs board via the auto-add
     workflow), resolve the thread. Only accepted fixes may grow the
     PR diff; deferral exists precisely so the diff stops feeding the
     next round.
- **High-risk PRs** (contracts, fund-moving paths): run an
  independent adversarial self-review BEFORE Codex round 1 so the
  loop starts from a cleaner base. Not required for app/test-infra
  PRs.
- Merge gate: **coding PRs** only after a converged round AND green CI;
  **docs-only PRs** after the 2-round cap above (converged or not) AND
  green CI. All review conversations must be resolved before merge
  (repo rule) in both cases.

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
  `docs/ReleaseNotes/ReleaseNotes-<date>.md`, removes **the ones it
  consumed**, and prints the commit steps. Review, add an intro paragraph,
  commit. It does NOT clear the whole backlog — fragments belonging to
  other UTC days are named and left pending for their own run.
  **The date is the fragment's UTC merge day, not the local one** — at
  `+05:30` a merge after 18:30 UTC reads as tomorrow locally, which has
  misfiled fragments twice. A run therefore takes only the fragments
  belonging to its day and names the ones it held back; clear a
  multi-day backlog by running it once per day. `--allow-mixed-dates`
  takes everything when folding is deliberate, an uncommitted fragment
  is always taken (it has no day yet), and in a shallow clone only the
  fragments whose add-commit resolves to the boundary itself are refused,
  by name — one added after the boundary has a real add-commit and is
  dated normally, so CI's shallow checkouts are fine and the override is
  not the answer to them. **The assembler is
  [`assemble.py`](docs/ReleaseNotes/assemble.py) and needs Python 3.10+**
  (#1877); `assemble.sh` is a thin entry point that picks an interpreter and
  passes the arguments through, and it uses no Bash-4 feature, so stock macOS
  Bash 3.2 runs it. `docs/ReleaseNotes/assemble.test.sh` covers all of it and
  DOES still want Bash 4 — a contributor requirement, not an operator one —
  run it after touching the assembler.
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
