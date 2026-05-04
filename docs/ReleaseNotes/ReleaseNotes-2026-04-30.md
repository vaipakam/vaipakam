# Release Notes — 2026-04-30

Functional record of everything delivered on 2026-04-30, written
as plain-English user-facing / operator-facing descriptions —
no code. Continues from
[`ReleaseNotes-2026-04-29.md`](./ReleaseNotes-2026-04-29.md).

Coverage at a glance: a **fresh testnet redeploy** across Base
Sepolia (canonical) + Sepolia (mirror) + BNB Smart Chain Testnet
(mirror), bringing all three chains' on-chain state in line with
the current codebase (~31 commits ahead of the 2026-04-22
deployments); three **deploy-script patches** caught during a
pre-deploy sanity audit (a missing `legalFacet` write to
`addresses.json`, two configure-scripts running without ADMIN
role-gate pre-flight checks); a **stuck-tx recovery** on BNB
Testnet where forge defaulted to a 1-wei gas price the network
silently dropped; **cross-chain peer wiring** of the OFT mesh +
fixed-rate buy mesh + reward-aggregation mesh across all three
chains (12 `setPeer` calls); a clean **positive-flow E2E** of all
15 lifecycle scenarios on Base Sepolia (204 txs / 204 receipts);
and **partial-flow E2Es** on Sepolia + BNB Testnet that leave
each chain in a frontend-testable midpoint state (open offers,
active loans, repaid-but-unclaimed loans, NFT-collateral and
rental-NFT loans).

## Testnet redeploy — fresh canonical + mirrors

The on-chain Diamonds on the three Phase 1 testnets had drifted
~31 commits behind master since the 2026-04-22 deployment. Recent
landed work that wasn't reflected on chain included the partial-
repay opt-in flag (added new fields to `Offer` and `Loan`
storage), the position-NFT name change ("Vaipakam NFT" / `VAIPAK`),
the Tellor + API3 + DIA secondary oracle quorum (Pyth removed),
the 4-DEX swap failover with `LibSwap`, the Phase 5 borrower-LIF
VPFI rebate path, the Phase 6 keeper per-action authorization
model, the Phase 8b Permit2 plumbing on `acceptOffer` /
`createOffer`, the LegalFacet (ToS gate), the governance-config
sweep (`getProtocolConfigBundle` + `getProtocolConstants`), the
LZGuardianPausable mixin on the 5 OApps, and the
`OfferCanceledDetails` companion event added 2026-04-29.

A clean redeploy was the right move (rather than upgrading
existing storage in place) because some of those changes
included struct-shape edits that Diamond-cut migration would
have had to handle field-by-field. With nothing on those
testnets that needed preserving, fresh addresses gave the
cleanest path.

Sequence per chain (in order):

1. `DeployDiamond.s.sol` — 31 facets, escrow impl, ERC-173
   ownership handover from deployer to admin.
2. `DeployVPFICanonical.s.sol` (Base only) / `DeployVPFIMirror.s.sol`
   (mirrors) — VPFIToken proxy + OFT Adapter (Base) or Mirror
   (others), `setVPFIToken` + `setCanonicalVPFIChain` on the
   Diamond.
3. `DeployVPFIBuyReceiver.s.sol` (Base only) /
   `DeployVPFIBuyAdapter.s.sol` (mirrors) — fixed-rate VPFI buy
   plumbing.
4. `DeployRewardOAppCreate2.s.sol` — CREATE2-deterministic
   bootstrap pattern so the Reward OApp proxy lands at the same
   address on all three chains (`0x5f0Fb9F1...c52E`).
5. `DeployTestnetLiquidityMocks.s.sol` — mUSDC + mWBTC ERC-20s,
   mock Chainlink registry + per-asset feeds, mock Uniswap V3
   factory + pools above the $1M depth threshold so both mocks
   classify as Liquid; oracle wiring on the Diamond +
   `updateRiskParams` for both assets and the chain's WETH.
6. `ConfigureVPFIBuy.s.sol` (Base only) — buy-rate and caps.
7. `ConfigureRewardReporter.s.sol` — local + base EIDs, reward
   OApp pointer, canonical flag.

Final addresses recorded in `contracts/deployments/<chain>/addresses.json`
on each chain. The Diamond and impl addresses changed on every
chain; the Reward OApp proxy address is identical across all
three by design.

| Chain | Diamond | VPFI Token / Mirror |
|---|---|---|
| Base Sepolia (84532) | 0x76C39e552f08556D6287A67A1e2B2D82F4E76c66 | 0xc9e4e60551e9D1AE460B7343Ad070ab2FcaF83E7 (canonical) |
| Sepolia (11155111) | 0x381BA2f7959613294Cf432063fe3C33CB68625AD | 0x1992C3038D2312dCc6fB51071509a272450d6A66 (mirror) |
| BNB Testnet (97) | 0xe46F8AE352bc28998083A2EC8Cf379063A73BEf7 | 0x771248712d35c54261C2A9441f3cAc7f9ad57839 (mirror) |

VPFI Reward OApp proxy: `0x5f0Fb9F11c11AA939518f45b6BC610336156c52E`
on all three chains (CREATE2 deterministic).

## Deploy-script patches

A pre-deploy audit pass turned up three operational gaps. All
three landed before any RPC traffic so the new deploys ran
clean.

### `DeployDiamond.s.sol` — `legalFacet` missing from artifact

The diamond-cut step of `DeployDiamond` adds 30 facets via the
cuts array (DiamondCutFacet is added by the diamond's
constructor). The script then writes each facet's address into
`addresses.json` via `Deployments.writeFacet(...)` so downstream
config / verification scripts can look up impl addresses without
querying the diamond loupe. The block of `writeFacet` calls had
30 entries — but `LegalFacet` (added in the Phase 4.1 ToS gate
work) wasn't among them. The facet was deployed and cut into the
diamond correctly; only the artifact write was missing, so
`addresses.json.facets.legalFacet` came back `null` after every
deploy.

Today's blast radius was zero (no script or frontend reads
`legalFacet` from the artifact yet — the frontend talks through
the diamond proxy), but the gap would have shipped silently and
broken any future tooling that did. One line added; verified by
the redeploy on each of the three testnets writing all 31 facet
addresses.

### `ConfigureOracle.s.sol` — wrong key + missing role pre-flight

Two issues on the same script:

1. The script's docstring said *"broadcast by a holder of
   ADMIN_ROLE"* but the code read `vm.envUint("PRIVATE_KEY")` —
   the deployer key. After `DeployDiamond`'s ownership handover,
   the deployer holds nothing; the broadcasted txs would revert
   with `LibDiamond` ownership errors and `AccessControl`
   role-missing errors that surface as the generic "execution
   reverted" RPC response. Fixed: read `ADMIN_PRIVATE_KEY`
   instead.
2. No pre-flight check on the broadcaster's role. The
   `OracleAdminFacet` setters use `LibDiamond.enforceIsContractOwner`
   (ERC-173 owner) and the `AdminFacet` setters use
   `onlyRole(ADMIN_ROLE)`. If either gate fails the tx reverts
   with a useless surface. Added a pre-broadcast block that:
   - reads `IERC173(diamond).owner()` and reverts with
     `"ConfigureOracle: broadcaster <0x...> is not Diamond owner <0x...>"`
     if mismatched;
   - reads `AccessControlFacet(diamond).hasRole(ADMIN_ROLE, broadcaster)`
     and reverts with a similarly explicit message if false.

### `ConfigureVPFIBuy.s.sol` — ADMIN_ROLE pre-flight

Same shape as the second `ConfigureOracle` fix. The script broadcasts
4 setter calls on `VPFIDiscountFacet`, all of which enforce
`onlyRole(ADMIN_ROLE)`. The pre-flight block now reads
`hasRole(ADMIN_ROLE, broadcaster)` before `vm.startBroadcast` and
reverts with an explicit message if missing.

## BNB Testnet — stuck-tx recovery + 5 gwei deploys

Forge's gas-price auto-detection on BNB Smart Chain Testnet
returned 1 wei for the first `DeployVPFIBuyAdapter` run, which
the network silently swallowed (no error, no eviction, no
mining). The tx sat in mempool for 25+ minutes, blocking the
deployer's nonce-126 slot.

Recovery sequence:

1. Killed the forge process holding the mempool slot.
2. Sent a 0-value self-tx at the stuck nonce with 5 gwei gas to
   evict the original.
3. Re-ran every subsequent BNB deploy script with
   `--with-gas-price 5gwei` (forge flag) — clean from there.

Same 1-wei-gas symptom hit a follow-up `DeployRewardOAppCreate2`
run despite the explicit gas flag (the script's CREATE2 path has
a separate codepath that re-derives gas internally). Re-ran with
the same flag and confirmed the proxy actually had bytecode at
the expected CREATE2 address before continuing.

The cross-chain peer wiring step then ran into the same shape
once more (one of the 12 `setPeer` calls on BNB Testnet got
stuck in mempool at low gas). Recovered by sending the
`setPeer(uint32,bytes32)` call directly via `cast send` at 20
gwei, with the `--nonce <stuck-nonce>` flag forcing replacement.
All 12 peer wirings verified after recovery via
`peers(uint32) → bytes32` reads on each OApp.

Operational note for future BNB Testnet runs: always pass
`--with-gas-price 5gwei` to forge, and have a `cast send …
--gas-price 20gwei --nonce <N>` recovery one-liner ready in case
forge's auto-detection misses again. The other two testnets
(Base Sepolia, Sepolia) auto-detect gas correctly.

## Cross-chain peer wiring — 12 setPeer calls

After all three chains were independently deployed, the OApp
peers needed wiring across the mesh. Mesh shapes:

- **VPFI OFT** (Base canonical adapter ↔ Sepolia + BNB mirrors)
  — hub-and-spoke: each mirror peers with the canonical adapter,
  no mirror-to-mirror peering. 4 wirings (2 bidirectional pairs).
- **Fixed-rate buy** (Base BuyReceiver ↔ Sepolia + BNB
  BuyAdapters) — same hub-and-spoke shape. 4 wirings.
- **Reward aggregation** (Base RewardOApp ↔ Sepolia + BNB
  RewardOApps) — hub-and-spoke through Base since reports flow
  mirror→canonical and broadcasts flow canonical→mirror. 4
  wirings.

All 12 wirings completed. Verification: `peers(remoteEid)` reads
on every OApp on every chain returned the expected counterparty
address (right-padded to bytes32). The BNB→Base reward peer
needed a manual `cast send` recovery (per the stuck-tx note
above); the other 11 went through the script cleanly.

## Positive flow E2E — Base Sepolia

`SepoliaPositiveFlows.s.sol` (despite the name, chain-agnostic)
ran on Base Sepolia covering all 15 lifecycle scenarios:

1-8. Liquid ERC-20 lending — create offer, accept, partial
     repay, full repay, default, fallback collateral split,
     claim, terminal-state event verification.
9.   Illiquid ERC-20 collateral — full-collateral transfer on
     default (no DEX swap path).
10.  ERC-721 collateral.
11.  ERC-1155 collateral.
12.  ERC-721 rental — borrower as renter, daily prepay deductions.
13.  ERC-1155 rental.
14.  Illiquid lending + illiquid collateral — both legs require
     dual fallback consent.
15.  Illiquid lending + liquid collateral.

Result: 204 transactions / 204 receipts, all green. Estimated
gas 71.5M, actual cost ~0.0008 ETH on Base Sepolia. The fresh
diamond + mock liquidity infrastructure exercised every lifecycle
write at least once; the per-loan invariants (settlement
breakdown, treasury accrual, claim payload shape) all matched
expectations.

## Partial flow E2Es — Sepolia + BNB Testnet

`BaseSepoliaPartialFlows.s.sol` (chain-agnostic) ran on Sepolia
and BNB Testnet. Unlike the positive flow which exercises every
lifecycle to terminal state, the partial flow intentionally
stops each scenario at a UI-testable midpoint so the frontend
team can drive the remaining steps through the wallet:

- **A.** Open lender offer (ERC-20 + liquid collateral) — accept
  via the borrower UI.
- **B.** Open borrower offer — accept via the lender UI.
- **C.** Active liquid loan — repay / add collateral / preclose
  via the borrower UI; observe HF / LTV from either side.
- **D.** Repaid-but-unclaimed loan — drives the Claim Center on
  both sides.
- **E.** Active ERC-721-collateral loan — exercises the NFT-
  collateral surfaces.
- **F.** Active ERC-721 rental loan — exercises the rental
  position UI.

Both chains ended with all six states populated, ready for
manual UI walkthroughs.

## Test-wallet funding — BNB Testnet

The lender / borrower / new-lender / new-borrower test wallets
on BNB Testnet had zero balance going into today's runs (only
the canonical `LENDER_ADDRESS` had been pre-funded). The deployer
transferred 0.05 BNB to each of the three zero-balance test
wallets so the partial-flow script could broadcast tx from each
identity. Sepolia and Base Sepolia test wallets already had
adequate balance from prior runs.

## Frontend address sync (pending)

The new on-chain addresses need to land in
`frontend/src/contracts/config.ts` so the connected-wallet flow
hits the freshly-deployed Diamond on each chain. Per the
project's frontend-ABI-sync workflow in `CLAUDE.md`, this also
requires running `bash contracts/script/exportFrontendAbis.sh`
to capture any ABI deltas from the 31 commits of contract
changes since the last frontend sync. Coordinated frontend
deploy after the address sweep + ABI re-export + `tsc -b` clean.

## Range Orders Phase 1 — feature branch landed

Per the locked design at
[`docs/RangeOffersDesign.md`](./RangeOffersDesign.md), the
Range Orders + lender-side partial fills + bot-driven matching
work landed today on a dedicated **`feat/range-orders-phase1`**
branch. Main remains at `cac7487` (last stable, currently
deployed to Cloudflare + the three testnets from earlier today)
so any minor production fixes can land on `main` without
mingling with the new feature work. Merge to `main` is held
pending the testnet bake — every new mechanic ships behind a
master kill-switch that defaults `false` on a fresh deploy, so
the new code is dormant until governance flips it on after the
~2-week bake the design plan calls for.

The work split across five PRs (each landing as a discrete commit
on the feature branch). All five passed the same forge regression
baseline as `main`: **1402 / 1407 tests, 0 failed, 5 skipped**
(the 5 skips are fork-gated Permit2 tests requiring
`FORK_URL_MAINNET`).

### PR1 — Storage + types + master kill-switch flags

Foundational additive change: every new field is **append-only**
to existing structs so legacy single-value offers stay byte-
identical at runtime through an auto-collapse mechanic. Three
new fields on `Offer` (`amountMax`, `amountFilled`,
`interestRateBpsMax`, `createdAt`), one on `Loan` (`matcher`),
two on `CreateOfferParams` (`amountMax`, `interestRateBpsMax`),
three on `ProtocolConfig` (the master kill-switch flags
`rangeAmountEnabled` / `rangeRateEnabled` / `partialFillEnabled`,
all default `false`). Three new constants
(`MIN_OFFER_CANCEL_DELAY = 5 minutes`, `LIF_MATCHER_FEE_BPS =
100`, `MAX_INTEREST_BPS = 10_000`).

The `OfferCanceledDetails` event picked up the three new range
fields so cancelled-offer hydration still has the full term
tuple. New events (`OfferMatched`, `OfferClosed`) declared.
Eleven new error types declared on `OfferFacet` covering range-
invariant violations, system-derived bound failures, master-flag
gates, matching-core preview reverts, cancel cooldown.

`ConfigFacet` gained three setters
(`setRangeAmountEnabled` / `setRangeRateEnabled` /
`setPartialFillEnabled`, all `onlyRole(ADMIN_ROLE)`) plus a
`getMasterFlags()` view, and `getProtocolConfigBundle()` was
extended with the three flags so the frontend `useProtocolConfig`
hook surfaces them alongside the existing fee BPS bundle.

`OfferFacet._writeOfferPrincipalFields` stamps `createdAt`,
auto-collapses `amountMax == 0 → amount` (and the same for the
rate pair), validates range invariants, and enforces the master-
flag gates so a range-shaped offer reverts cleanly when the
flag's off.

Bulk update across 33 test/script files added
`amountMax: 0, interestRateBpsMax: 0` to every existing
`CreateOfferParams` literal. Auto-collapse made every test
behaviour-identical without any per-test-case logic changes.

### PR2 — `LibRiskMath` + side-specific bound enforcement

New pure library `LibRiskMath` exposes
`minCollateralForLending(amountMax, principalAsset, collateralAsset)`
and `maxLendingForCollateral(collateralAmount, principalAsset,
collateralAsset)`. Both solve `HF = 1.5e18` analytically using
the same Chainlink-feed conversion as
`RiskFacet._computeUsdValues` so create-time bounds match the
runtime HF gate semantics 1:1. Skips when collateral asset has
no registered risk params (treats missing-params as "fall through
to runtime gate").

`OfferFacet.createOffer` validates the side-specific bounds:

- **Lender offer**: required `collateralAmount >=
  minCollateralForLending(amountMax)` — lender's posted
  collateral floor is sized to the worst-case lending amount, so
  partial fills at any size land HF ≥ 1.5.
- **Borrower offer**: `amountMax <=
  maxLendingForCollateral(collateralAmount)` — borrower's
  willingness to receive can't exceed the collateral they posted.

Both checks are **gated on `rangeAmountEnabled`** so the create-
time bound only fires when range mode is actually permitted —
single-value offers (the default-flag-off path) fall through to
the runtime HF gate at `LoanFacet.initiateLoan` exactly as
before. The lender ERC-20 pull at create-time was updated to
use `params.amountMax` (auto-collapsed to `params.amount` for
legacy callers); same for the Permit2 path's `_creatorPullAmount`.

### PR3-A — `LibOfferMatch` + matchOffers entry + 1% LIF matcher kickback

New library `LibOfferMatch` carries:

- **`previewMatch(lenderOfferId, borrowerOfferId)` view** — runs
  the validity matrix from design §4.1 + computes midpoint terms
  from §4.2 + a synthetic HF check via `LibRiskMath`. Returns a
  structured `MatchResult` so off-chain matching bots can filter
  candidate pairs without paying for reverting txs.
- **`assertAssetContinuity(loan, offer)`** — single source of
  truth for the per-asset invariants (lendingAsset /
  collateralAsset / collateralAssetType / prepayAsset) consumed
  by Preclose + Refinance in PR4.
- **`matcherShareOf(totalFee)` pure helper** — the 1% slice math
  used by both LIF settlement paths.
- **`splitLifToMatcher(asset, totalFee, lender, matcher)`** —
  routes the matcher's slice from lender escrow to matcher
  address (kept for the future `executeMatch` body in PR3-B
  variants).

`OfferFacet` gained two external entries:

- **`previewMatch(lenderOfferId, borrowerOfferId)` view** — bot-
  facing wrapper around `LibOfferMatch.previewMatch`.
- **`matchOffers(lenderOfferId, borrowerOfferId)`** — main
  matching entry; gated on `partialFillEnabled` master flag
  (default off), so reverts cleanly with `FunctionDisabled(3)`
  in Phase 1 dormant state. Body landed in PR3-B (below).

The **1% LIF matcher kickback** went live on the legacy single-
value `acceptOffer` path immediately:

- **Lender-asset path** (most accepts): the existing LIF-to-
  treasury transfer split into 99% to treasury + 1% to
  `msg.sender`. Inline at the LIF site so a single LIF flow
  never lands 100% in either bucket.
- **VPFI path** (Phase 5 borrower-LIF rebate): the matcher slice
  is deferred to terminal in
  `LibVPFIDiscount.settleBorrowerLifProper` (1% of treasury share
  at proper close) and `LibVPFIDiscount.forfeitBorrowerLif` (1%
  of full forfeit at default / HF-liquidation). Matcher address
  read from the new `Loan.matcher` field which `_acceptOffer`
  stamps with `msg.sender` post-init.

Four existing tests updated for the new 99/1 split semantics.
Zero behavioural regressions.

### PR4 — Preclose + Refinance consume `LibOfferMatch.assertAssetContinuity`

`PrecloseFacet.transferObligationViaOffer` and
`RefinanceFacet.refinanceLoan` had identical inline asset-
continuity check blocks (4 lines each). Both now call
`LibOfferMatch.assertAssetContinuity(loan, offer)` and surface
their facet-specific reverts (`InvalidOfferTerms` /
`InvalidRefinanceOffer`) on failure — each suite's typed-revert
expectations preserved.

The flow-specific amount checks became range-aware:

- **Preclose**: `offer.amount <= loan.principal <= offer.amountMax`
  (the borrower's range must accommodate the existing loan's
  exact principal — preclose is a transfer-of-obligation, not a
  fresh fill).
- **Refinance**: `offer.amount <= oldLoan.principal <=
  offer.amountMax` (the borrower's range must accommodate the
  loan being refinanced).

With auto-collapse (`amountMax == 0` → treated as `amount`),
legacy single-value offers fall through to the original equality
checks unchanged.

The smaller flows confirmed the right shape for the
`executeMatch` core: **per-offer state mutations** (validity +
amountFilled increment + dust-close + accepted flag) belong in
the shared core; **escrow flows + loan-state mutations** stay
flow-specific because they vary widely.

### PR5 — Cancel cooldown + partial-fill cancel semantics

`OfferFacet.cancelOffer` gained three Range-Orders-aware
behaviours:

- **Cancel cooldown** — when `amountFilled == 0` AND
  `partialFillEnabled` is on, `cancelOffer` reverts
  `CancelCooldownActive()` until 5 minutes after the offer's
  `createdAt`. Blunts the cancel-front-run vector on the matching
  path (an attacker watching `matchOffers` in mempool can't race
  a cancel in to reclaim escrowed assets before the match
  lands). Gated on the master flag — when matching is dormant
  there's no front-run vector, so the cooldown stays off and
  every existing create-then-cancel test flow stays byte-
  identical.
- **Range-aware refund** — lender ERC-20 cancels refund
  `(amountMax - amountFilled)`, not `offer.amount`. Auto-collapse
  preserves backcompat: legacy single-value offers satisfy
  `amountMax == amount && amountFilled == 0`, so the refund
  equals `amount` exactly.
- **Storage preservation on partial-filled cancel** — when
  `amountFilled > 0`, `cancelOffer` skips
  `delete s.offers[offerId]` and instead flips
  `accepted = true`. The N existing loans spawned by prior
  matches still reference the offer's terms via `Loan.offerId`,
  so the storage slot must stay readable. Zero-fill cancels
  delete normally and free the slot for gas refund.

A new `OfferClosed(offerId, reason)` event fires on every cancel
(reason = `Cancelled`) alongside the legacy `OfferCanceled` /
`OfferCanceledDetails`, so the unified-reason discriminator
groups every terminal class consistently for indexers.

### PR3-B — true `matchOffers` body + matchOverride slot

The deferred half of PR3 — the actual match-execution body —
landed by introducing a `MatchOverride` per-tx storage slot
that lets `matchOffers` inject **both** the midpoint match terms
(amount / rateBps / collateralAmount, consumed by
`LoanFacet._copyFinancialFields`) **and** the address-resolution
override (counterparty / matcher, consumed by
`OfferFacet._acceptOffer`). The storage slot has a clean
active-flag pattern: set at the top of `matchOffers`, read by
both downstream consumers when active (else they fall through to
legacy `msg.sender` / offer-field paths), cleared post-match.

The two address-resolution fields land independently, addressing
a bug in the first cut: when `matchOffers` runs, `msg.sender` is
the matcher (a bot or relayer) — not the actual counterparty to
the offer being processed. The legacy `acceptOffer` path reads
`acceptor = msg.sender` for sanctions / country / KYC screening
AND for lender/borrower role resolution. Without an override,
those checks would target the bot's wallet and the principal +
LIF would be pulled from the bot's escrow instead of the actual
lender's.

- **`counterparty`**: carries the lender-offer creator's address
  into `_acceptOffer`, which reads it in place of `msg.sender`
  whenever the override is active.
- **`matcher`**: receives the 1% LIF kickback. On the legacy
  path matcher = `msg.sender` (same person who triggered the
  match). Under matchOffers, matcher = `msg.sender` of the outer
  matchOffers call frame, propagated through to the LIF
  kickback site inside `_acceptOffer` and stamped on
  `loan.matcher` for VPFI-path terminal kickbacks.

`matchOffers` now has its full body:

1. Validate via `LibOfferMatch.previewMatch`; map structured
   errors to typed reverts.
2. Set `s.matchOverride = (matchAmount, matchRateBps,
   reqCollateral, lenderOffer.creator, msg.sender, active=true)`.
3. Reuse `_acceptOffer`'s escrow + LIF + NFT-mint + initiateLoan
   plumbing by invoking it on the BORROWER offer. Picking the
   borrower offer (rather than the lender offer) means:
   - `offer.offerType == Borrower`, so the borrower-collateral
     pull block in `_acceptOffer` naturally short-circuits (the
     borrower's collateral was pre-escrowed at borrower-offer
     create time — exactly the case the existing comment
     "already in escrow for Borrower offers" describes).
   - `offer.creator == borrower`, so the loan correctly records
     the borrower-offer's creator as the borrower.
   - `offer.accepted = true` flips the borrower offer to
     terminal — exactly what's needed since borrower-side is
     single-fill in Phase 1.
   - The lender's escrow path is correctly reached because
     `lender = acceptor = matchOverride.counterparty` (the
     lender-offer creator) inside `_acceptOffer`.
4. Clear `s.matchOverride` to prevent same-tx leakage.
5. Increment `lenderOffer.amountFilled += matchAmount`.
6. **Auto-close on dust**: if remaining capacity falls below the
   lender's per-match minimum (`L.amount`), refund the dust to
   the lender's escrow + flip `accepted = true` + emit
   `OfferClosed(reason)` (FullyFilled when remaining hit 0
   exactly, Dust otherwise).
7. Emit `OfferMatched` with the matched terms + the lender's
   post-match remaining + the synchronous LIF kickback amount.

### Master kill-switch posture on a fresh deploy

All three flags default `false`. With matching dormant:

- `createOffer` enforces `amountMax == amount` and
  `interestRateBpsMax == interestRateBps` (collapsed range only).
- `matchOffers` reverts immediately with `FunctionDisabled(3)`.
- The cancel cooldown is inactive — `cancelOffer` works exactly
  as before.
- The `Loan.matcher` field still stamps on every accepted offer
  (legacy path) and the 1% LIF kickback to `msg.sender` still
  fires — these don't depend on the master flags.

Governance flips a flag → relevant Range Orders mechanic comes
online. Each flag can be flipped independently for staged
enablement (e.g., enable amount-range but not partial-fills to
get range-orders without multi-match support).

### Verification

- `forge build --silent` clean across all five PR landings.
- `forge test --no-match-path "test/invariants/*"` →
  **1402/1407 passing, 0 failed, 5 skipped** at every PR
  checkpoint. The 5 skips are the fork-gated Permit2 tests
  requiring `FORK_URL_MAINNET`.
- Frontend ABIs re-exported after each contract-touching PR;
  `tsc -b --noEmit` clean.

### Outstanding

- Testnet redeploy of the feat-branch contracts (deferred —
  `main` is what the testnets currently run; merge gates
  redeploy).
- Matcher kickback BPS hardcoded as a constant — flagged as a
  Phase 2 governance-economics item per the original plan
  ("dial up to 5-10% if community bot operators need a stronger
  incentive"). **Addressed 2026-05-01** — see
  [`ReleaseNotes-2026-05-01.md`](./ReleaseNotes-2026-05-01.md).
- `OfferFacet` runtime bytecode exceeds the EIP-170 24576-byte
  ceiling (~28KB after Range Orders Phase 1 work). Anvil
  bootstrap currently relies on `--code-size-limit 50000` to
  deploy; mainnet has no such override. **Tracked for a split**
  — see the 2026-05-01 release notes.

## Range Orders Phase 1 — post-PR follow-ups

A second batch of work landed on `feat/range-orders-phase1`
after the five core PRs. Each item closed a concrete loose end
discovered during smoke-testing the matching flow end-to-end on
a local anvil node. None changed the protocol's load-bearing
behaviour — they're correctness fixes, UX polish, and operator
ergonomics.

### Borrower excess-collateral refund (Option A)

Range Orders pro-rate the lender's posted collateral against the
matched amount: a 1000 mUSDC match against a lender who locked
2000 mUSDC requires only half the lender's collateral coverage,
not all of it. The borrower may have posted more collateral than
that pro-rated requirement (over-collateralised when creating
their offer). Phase 1 borrower offers are single-fill, so the
excess can never be reused for another match — it would sit
trapped in escrow.

Fixed: `matchOffers` now refunds the difference
(`borrowerOffer.collateralAmount − pro-rated requirement`) to
the borrower's wallet inside the same transaction, immediately
after the loan is initiated. ERC-20 collateral only — NFT
collateral is whole-or-nothing and can never have a fractional
overage. The result is a single, simple invariant across both
sides: escrow only ever holds collateral or principal that's
actively committed to a live offer or loan. Lender side already
worked this way (dust-close on partial-fill remainder); now
borrower side mirrors it.

Verified end-to-end on anvil: 0.05 mWBTC excess (0.15 posted
minus 0.10 pro-rated requirement) lands in the borrower's
wallet inside the `matchOffers` tx.

### Position NFT metadata — Tier 1 (correctness + live state)

The `tokenURI` rendered by `VaipakamNFTFacet` was reading
`offer.amount` for the principal display. After the Range
Orders refactor that field is the lender's range minimum, not
the realised loan principal — so a partial-fill loan's NFT
showed "500 mUSDC" when the actual matched amount was 1000.
Fixed by introducing a single live-state read view:

- New `MetricsFacet.getNFTPositionSummary(tokenId)` returns a
  structured summary: realised loan terms (matched amount /
  rate / collateral, not the offer's range), plus live escrow
  state, plus claim availability, plus VPFI rebate state for
  borrower-side LIF positions, plus token symbols + decimals
  resolved via `IERC20Metadata` with safe try/catch fallbacks.
- `tokenURI` rewired to consume that summary. Now renders:
  - Symbols not hex addresses ("mUSDC", "mWBTC") for both
    lending and collateral assets.
  - Decimal-formatted amounts ("1000 mUSDC", "0.1 mWBTC") not
    raw wei.
  - Interest rate as `boost_percentage` display type (5.00 with
    OpenSea rendering it as "5.00%") rather than raw BPS (500).
  - Duration as `display_type: number`.
  - "Locked Collateral" trait — what's actually in escrow
    against this loan right now (0.1 mWBTC for the example
    above, "Already claimed" once claimed at terminal).
  - "Claimable Now" trait — what the holder can call
    `claimAsLender` / `claimAsBorrower` for. None for live
    loans, populated at terminal.
  - "VPFI Rebate Pending" — borrower-side custody slice that
    settles via `LibVPFIDiscount.settleBorrowerLifProper` at
    proper close.
  - "Created At" trait — `display_type: date` so OpenSea
    localises the offer-creation timestamp.
  - Both an "Loan State" trait (the on-chain loan-status enum)
    and the existing NFT-lifecycle "Status" trait, since they
    can drift (a loan can be Repaid while the lender NFT is
    still Active pre-claim).

Verified end-to-end on anvil: `tokenURI(3)` for a freshly
matched lender NFT renders "1000 mUSDC" principal at "5%" with
"0.1 mWBTC" collateral and "0.1 mWBTC" locked, all dynamically
pulled from `loan` storage.

### Position NFT metadata — Tier 2 (marketplace polish)

Two OpenSea-spec fields added to `tokenURI`'s JSON:

- **`background_color`**: six-character hex picked by
  side + terminal state. Lender (active) renders forest-green
  `2f855a`, borrower (active) steel-blue `2b6cb0`,
  defaulted/liquidated muted-red `c53030`, repaid/closed slate
  `4a5568`. Marketplace grid views differentiate lender from
  borrower from defaulted at a glance.
- **`external_url`**: admin-set base URL emitted with a
  position-aware query (`?loan=<id>&side=<…>` for matched
  loans, `?token=<id>` for offer-only NFTs). Marketplaces
  render a "View on Vaipakam" deep-link from OpenSea straight
  into the dApp's dashboard. New admin setter
  `setExternalUrlBase(string)` stores the per-chain base in
  `LibERC721` storage; empty string omits the field from the
  JSON entirely.

### Status-keyed image URI scheme

The previous four-slot scheme (`lenderActive`, `lenderClosed`,
`borrowerActive`, `borrowerClosed`) collapsed every terminal
state into a single "closed" image — a defaulted lender NFT
looked identical to a fully-repaid one. Replaced by a granular
status-keyed mapping:

- `statusImageURIs[LoanPositionStatus][isLender]` — one image
  per (status, side) pair. Each of the eight position-status
  enum values (None, OfferCreated, LoanInitiated, LoanRepaid,
  LoanDefaulted, LoanLiquidated, LoanClosed,
  LoanFallbackPending) can carry distinct artwork for both
  sides.
- `defaultLenderImage` / `defaultBorrowerImage` — per-side
  fallbacks when no status-specific override is configured.

Lookup chain in `tokenURI`:
1. Exact `(status, isLender)` override.
2. Per-side default.
3. Collection-level `contractImageURI`.
4. Empty string.

New admin setters: `setImageURIForStatus(status, isLender, uri)`
(granular, single-state), `setDefaultImage(isLender, uri)`
(per-side fallback). A read-back view
`getImageURIFor(status, isLender)` lets the frontend admin
dashboard preview the resolved URL before broadcasting an
override. All admin-gated; ADMIN_ROLE is governance-transferable
without any contract change.

Companion script: `ConfigureNFTImageURIs.s.sol` — a one-shot
post-deploy URL rotation tool that reads from env vars (one per
side per status, plus `NFT_DEFAULT_IMAGE_LENDER` /
`NFT_DEFAULT_IMAGE_BORROWER` and `NFT_EXTERNAL_URL_BASE`) and
calls the relevant setters in a single transaction. Idempotent
and partial — only env vars that are populated trigger their
setter, so a designer shipping just the "defaulted" art doesn't
overwrite the other states.

### Bot detector — `offerMatcher.ts`

Reference matching detector in `vaipakam-keeper-bot/src/detectors/
offerMatcher.ts`. Per-tick logic:

1. Read `getActiveOffersCount` (O(1)) and short-circuit on zero.
2. Page through `getActiveOffersPaginated` to gather every live
   offer id.
3. Hydrate each offer via `getOffer(id)` and partition into
   lender / borrower buckets keyed by the cheap continuity tuple
   `(lendingAsset, collateralAsset, assetType,
   collateralAssetType, durationDays)`. Buckets that lack offers
   on both sides can never produce a valid match and are
   skipped — cuts the cartesian to a per-bucket nested loop.
4. For each candidate pair within a bucket, call `previewMatch`.
   Skip on any structured error code; submit `matchOffers` on
   `Ok`. First-come-first-served.
5. Per-tick caps: 2000 preview calls, 25 submits. Per-tick
   dedupe via `${lenderId}:${borrowerId}` set so a partial fill
   can't be re-attempted in the same tick.

Master kill-switch behaviour: when `partialFillEnabled` is off
on chain, `matchOffers` reverts with `FunctionDisabled(3)`. The
detector logs that revert once per chain at INFO and keeps
polling — when governance flips the flag the very next tick
succeeds, no bot restart needed.

Wired into the bot's existing per-chain `tickChain` immediately
after the liquidation pass, so a freshly liquidated loan never
blocks a lender offer's matching capacity in the same tick.
Wrapped in try/catch — a matcher crash never aborts the
liquidation sweep.

ABI export: `contracts/script/exportAbis.sh` extended with
`OfferFacet` so the bot picks up `previewMatch` + `matchOffers`
ABIs from the same export pipeline as the existing
`MetricsFacet` / `RiskFacet` / `LoanFacet` ones.

### MetricsFacet — `getActiveOffersPaginated`

New view, symmetric with the existing `getActiveLoansPaginated`
but for offers. Asset-agnostic (existing `getActiveOffersByAsset`
filters by asset). Consumed by the bot's enumeration loop above;
also useful for any UI that wants to render the order book
without an event scan.

### Frontend — Range Orders UI behind master flags

`useProtocolConfig` extended to surface the three master flags
(`rangeAmountEnabled`, `rangeRateEnabled`, `partialFillEnabled`)
from `getProtocolConfigBundle`. Create-Offer form gates new
controls on those:

- Min/Max amount inputs replace the single Amount input when
  `rangeAmountEnabled` AND the user is in Advanced mode.
  Otherwise the existing single-value flow stays byte-identical.
- Min/Max interest-rate inputs do the same when
  `rangeRateEnabled`.
- Lender's classic ERC-20 approval and Permit2 sign now cover
  the upper bound (`amountMax` when range mode is active, else
  `amount`). Without this, lender range offers would revert at
  the escrow pull because the contract pulls `params.amountMax`
  but the wallet only approved `amount`.
- New form-state fields `amountMax` + `interestRateMax` carry
  empty string when not populated; `toCreateOfferPayload`
  converts blank to `0n` / `0` (the contract's auto-collapse
  semantics — single-value offer).
- Validation guards: `amountMax >= amount` and
  `interestRateMax >= interestRate` when populated.

Plus a live wallet-balance pre-check: as the user types the
amount, a 250ms-debounced `useEffect` resolves
`IERC20Metadata.balanceOf(walletAddress)` for the relevant
asset (lending for lender-side, collateral for borrower-side)
and renders an inline "Insufficient X balance — wallet holds Y,
offer requires Z" hint with both quantities decimal-formatted
and labelled with the token symbol. Submit handler still
re-checks on broadcast as a final guard.

### Frontend — false-success bug fix on reverted txs

`useDiamond.wait()` and `useERC20.wait()` previously resolved
on any tx inclusion regardless of receipt status. A reverted
tx (status 0) looked identical to a successful one — the page
showed "Offer Created Successfully" while the on-chain state
never changed. Both helpers now throw on `receipt.status !==
'success'`, which propagates through every page using the
common `try { await tx.wait(); …setStep("success") } catch`
shape. Catches reverted approvals, reverted creates, reverted
liquidations — surfaces the actual on-chain failure to the
user instead of a green checkmark.

### Frontend NFT Verifier — Tier 1 traits surfaced

The verifier's "Live" card now reads the new metadata traits
and renders them in the structured details column: Loan State,
Locked in Escrow, Claimable Now (color-coded green when
populated), VPFI Rebate Pending, and Created (Unix timestamp
rendered via `Date#toLocaleString`). All four fields hide when
their value is empty so older-facet NFTs without the new
traits render gracefully against the old shape.

### Anvil playground scaffolding

End-to-end smoke-test infrastructure for the matching flow on a
local foundry node. Three new artifacts in
`contracts/script/`:

- `BootstrapAnvil.s.sol` — flips the three Range Orders master
  flags ON via `ConfigFacet`, gated to `block.chainid == 31337`.
  Verifies via `getProtocolConfigBundle` readback so a silently
  failed setter can't pass.
- `SeedAnvilOffers.s.sol` — creates one matchable lender +
  borrower offer pair using the mock USDC / mock WBTC
  liquidity. Lender posts a range (500–2000 mUSDC at
  4–6% APR), borrower posts a single-fill 1000 mUSDC
  request at 4.5–5.5% APR. Midpoint match: 1000 mUSDC at 5%
  with 0.1 mWBTC pro-rated collateral against $60k/BTC mock
  prices — HF ≈ 6, well above the 1.5 floor.
- `anvil-bootstrap.sh` — orchestrator. Pre-flight-checks anvil
  RPC reachability and chain id (refuses to run unless 31337),
  then chains: `DeployDiamond` → `DeployTestnetLiquidityMocks`
  (extended to support 31337 with an inline mock WETH) →
  Multicall3 etch → `BootstrapAnvil` → `SeedAnvilOffers`. Prints
  the bot's launch command at the end with the freshly-deployed
  Diamond address baked in.

Plus a `Multicall3Mock` contract under `contracts/test/mocks/`
that the bootstrap deploys and `anvil_setCode`-etches to the
canonical `0xcA11…cA11` address. Without this, the frontend's
`lib/multicall.ts` (which calls `aggregate3` at the canonical
address) reverts with "no data" on every dashboard read because
fresh anvil nodes don't pre-deploy the canonical Multicall3.

`Deployments` library + `DeployTestnetLiquidityMocks` taught
about chain 31337 (`anvil` slug, `ANVIL_` env prefix, sentinel
LZ EID 31337 since no real LZ traffic on a local node).
`DeployDiamond._getMetricsSelectors` /
`_getOfferSelectors` / `_getConfigSelectors` were extended to
include selectors that the Range Orders work added but didn't
have a fresh-deploy registration: `getActiveOffersPaginated`,
`previewMatch`, `matchOffers`, `setRangeAmountEnabled`,
`setRangeRateEnabled`, `setPartialFillEnabled`, `getMasterFlags`.

### Critical bug fix surfaced by the smoke test

The smoke test caught a load-bearing bug that the unit-test
suite did not: `_acceptOffer` resolved an override-aware
`acceptor` for sanctions / country / KYC / role checks but
passed `msg.sender` to `LoanFacet.initiateLoan` for the loan's
`acceptor` argument. Under `matchOffers` `msg.sender` is the
bot, not the actual counterparty — so the resulting loan
recorded the bot as the lender (when the borrower offer was
processed via override). Fixed by threading the resolved
`acceptor` through to `initiateLoan`. Refactored matcher
resolution to inline storage reads to stay under viaIR's
stack-too-deep budget (the local `matcher` variable was the
straw that broke the camel's back).

### Verification

- `forge build` clean across all post-PR commits.
- `forge test --no-match-path "test/invariants/*"` →
  **1402/1407 passing, 0 failed, 5 skipped** at every checkpoint
  through the post-PR follow-ups. The 5 skips remain the
  fork-gated Permit2 tests requiring `FORK_URL_MAINNET`.
- Anvil end-to-end smoke test: bootstrap → bot fires
  `matchOffers` within one tick → loan created with correct
  lender + borrower (verified via `getLoanDetails`) → 0.05 mWBTC
  excess refund landed in borrower wallet → `tokenURI(3)`
  decoded JSON shows symbols + decimal-formatted amounts +
  display_type annotations + locked-collateral trait + created
  timestamp.
- Frontend `tsc -b --noEmit` clean across every UI change.

## Documentation convention

Same as carried forward from prior files: every completed phase
gets a functional, plain-English write-up under
`docs/ReleaseNotes-…md`. No code. Function names, tables, and
exact selectors live in the codebase; this file describes
behaviour to a non-engineer reader (auditor, partner team,
regulator).
