# Release Notes — 2026-05-25

Twenty-two threads in this batch — the long tail of two cleanup arcs
closes (LayerZero → CCIP doc debt and forge-lint debt) alongside a
substantial offer-system feature landing and broad UI/UX polish.

The **LayerZero → CCIP wrap-up** finishes in four threads: #127
(contracts README rewrite), #230 + #113 (SECURITY.md cross-chain
rewrite), #236 (residual `contracts/src/` wording sweep), and
#200 + #201 (guardian-pause coverage on `VPFIMirrorToken` and
ADR-0004 qualified to match what's actually shipped). **Forge-lint
cleanup** closes the matching lint debt that accumulated alongside
the migration (#89, three threads — Batches 1-4, the A.1 + A.2 +
SafeCast.toInt256 bundle, and A.4 + the `setRewardOApp` →
`setRewardMessenger` rename).

**Offer-system enhancements** comprise five new behaviours: #125
(DEX-style fill-mode flavours), #193 (in-place offer modification),
#195 (good-till-time offer expiry), #196 (`previewAccept` dry-run
for direct-accept), and #194 (self-trade prevention on
direct-accept + `matchOffers`). #235 extends #194 into the keeper
bot with a self-trade pre-filter + classifier log.

**UI/UX polish** spans #166 (the UX-direction ADR documenting where
to follow DEX/CEX conventions vs. where lending-native shapes need
their own language), #215 (the shared `RiskCallout` component
canonicalising state-mutating-confirm risk shapes), #216 (the
shared BPS helper + `GasChip` component), the repo-wide #227
Escrow → Vault rename matching user-facing language, and #241's
cooldown + GTT countdown UX on the own-offers list. **Test
infrastructure** tightens with #168 (Track A scaffolding fold —
`PauseGatingTest` + `KYCTierEnforcementIntegration` onto
`SetupTest`) and #229's confirmation that `SetupTest` is now a
strict superset of production.

**Off-chain reliability** picks up the Stage A backup thread —
`ops/offchain-data-archive` Cloudflare Worker live, with nightly
D1 + R2 exports to Backblaze B2 on a separate billing boundary,
client-side AES-256-GCM encrypted with the key kept offline.
Finally, **#274** ships the Codex review trigger automation —
auto-forwards `@codex review <mode> [profile]` triggers placed in
PR descriptions into PR-thread comments so Codex's comment-driven
automation actually fires, gated by `author_association` to prevent
public-repo cost-DoS and dedupe-keyed on `(trigger, head-SHA)` to
re-fire-on-new-commits without same-commit duplicates. #274 is the
signed re-submission of #273; #273's unsigned commits hit the
`required_signatures` rule, and the local cherry-pick recipe is
now the documented pattern for Claude-GitHub-App-originated PRs
going forward.

## Thread — DEX-style offer fill-mode flavours (PR #__, Closes #125)

Vaipakam offers were implicitly partial-fillable since Range Orders
Phase 1: any match in `[amount, amountMax]` was legal, with the
remainder staying on the book. This thread adds the standard DEX
vocabulary on top — two new fill-mode flavours that a creator can
opt into at offer-create time without disturbing the default Partial
behaviour.

The new shape is a single `Offer.fillMode` enum
(`Partial` / `Aon` / `Ioc`):

- **`Partial`** is the default and the zero-init storage sentinel
  — every legacy offer and every legacy `CreateOfferParams`
  construction site reads as `Partial` without code changes.
- **`Aon`** ("All-or-Nothing") admits exactly one full-size fill,
  sized to `offer.amount`. The create-time invariant `amount ==
  amountMax` keeps the AON-required fill size unambiguous; the
  match-time gate in `LibOfferMatch.previewMatch` rejects any
  partial match against an AON side with a typed
  `AonRequiresFullFill(offerId, required, provided)` revert that a
  matcher's revert decoder can render directly.
- **`Ioc`** ("Immediate-or-Cancel") is partial-fillable inside a
  required time window (`expiresAt > 0`) and lapses into the same
  permissionless-clear path #195 introduced for GTT offers once the
  window elapses. Contract-side, IOC is a metadata wrapper over
  `expiresAt` plus the `fillMode` discrimination flag — no new
  enforcement mechanism, since #195's lazy-expiry gate already
  handles "past the deadline, refuse the offer."

`FOK`, `POST`, and `Iceberg` were considered and either rejected or
deferred. POST is a no-op for Vaipakam — every offer is structurally a
maker on this protocol (acceptors are users or the matcher bot, never
other offers), so POST-only would add a confusing UI option doing
nothing. FOK is strictly stricter than AON ("same block or revert")
which is a poor fit for P2P lending's slower match cadence; AON
serves the same user intent without the tx-ordering brittleness.
Iceberg defers post-mainnet — it adds non-trivial state for a
demand signal that hasn't materialised yet. The enum is append-only
so all three can land in follow-ups without breaking storage.

The companion `OfferCreatedDetails` event carries `fillMode` so
indexers and frontend cache merges can render the offer's mode chip
("AON" / "IOC, 60s left") directly from the event payload — no
follow-up `getOffer` view-call. Bulk-updated 220 `CreateOfferParams`
construction sites in tests + scripts to ship the explicit `Partial`
field; behavioural regression stays bit-for-bit identical because
`Partial` IS the zero-init default.

Out of scope and tracked separately:

- The "Fill mode" dropdown on the CreateOffer form + tooltips —
  follow-up UI card under `#166`.
- FOK / Iceberg / TWAP — append the enum + add the match-time branch
  whenever a user signal warrants it; non-breaking additions.

## Rewrite contracts/README.md cross-chain sections (LayerZero → CCIP) (Issue #127)

The auto-generated docs site at `https://vaipakam.github.io/vaipakam/`
uses `contracts/README.md` as its home page (`forge doc` copies the
project README into the mdbook tree). Until this release, the
README's cross-chain sections still described the pre-T-068
LayerZero OFT V2 surface — file listing referenced `VPFIMirror.sol`
+ `VPFIOFTAdapter.sol`, the topology diagram showed LayerZero
messages with DVN-verification, the deployment guide pointed at
`DeployVPFICanonical` + `DeployVPFIMirror` + `WireVPFIPeers` (all
deleted in T-068's Phase 5), the env-var table listed `LZ_ENDPOINT`
+ `LOCAL_OAPP` + `REMOTE_EID`, and the bridging-flow section walked
through the adapter `send` → DVN → executor → `_credit` pattern.

A "Known doc drift" note at the top of the file warned auditors that
the body was stale. The note was a stopgap; this release retires it
and rewrites the body so it matches what the code actually does.

What changed in `contracts/README.md`:

- **Repository Layout** — `token/` now lists `VPFIToken.sol` +
  `VaipakamVestingWallet.sol`. The pre-T-068 `VPFIMirror.sol` and
  `VPFIOFTAdapter.sol` are gone. A new `crosschain/` directory
  block lists every contract under `src/crosschain/`:
  `ICrossChainMessenger`, `CcipMessenger`, `GuardianPausable`,
  `VPFIMirrorToken`, `VpfiPoolRateGovernor`, `VpfiBuyAdapter`,
  `VpfiBuyReceiver`, `IVpfiBuyCcipMessages`,
  `VaipakamRewardMessenger`.
- **VPFI Cross-Chain Topology** — the topology paragraph + ASCII
  diagram now describes the CCIP CCT shape: `VPFIToken` paired with
  a `LockReleaseTokenPool` on Base; `VPFIMirrorToken` paired with a
  `BurnMintTokenPool` on every mirror chain; the CCIP committing /
  executing DONs plus the Risk Management Network in the
  inter-chain transport. The "Key properties" list adds the
  one-transport-aware-contract pattern (domain code depends only on
  `ICrossChainMessenger`), the per-lane rate-limit policy via
  `VpfiPoolRateGovernor`, and the `GuardianPausable` pause base.
- **Deployment Guide / env variables** — `LZ_ENDPOINT`,
  `LOCAL_OAPP`, `REMOTE_EID`, `REMOTE_PEER` are gone. The env-var
  table now groups required keys per script with the values each
  script actually reads (verified against `DeployCrosschain.s.sol`
  and `ConfigureCcip.s.sol`):
    - `DeployCrosschain` requires `DEPLOYER_PRIVATE_KEY`,
      `ADMIN_ADDRESS`, `CCIP_ROUTER`, `CCIP_RMN_PROXY`; mirror
      chains additionally need `BASE_CHAIN_ID` + `TREASURY_ADDRESS`;
      optional `VPFI_BUY_PAYMENT_TOKEN` / `VPFI_BUY_REFUND_TIMEOUT` /
      `CCIP_DEST_GAS_LIMIT`. Reads the diamond + canonical
      `VPFIToken` from the per-chain `deployments/<chain>/addresses.json`
      artifact, NOT from env.
    - `ConfigureCcip` requires `ADMIN_PRIVATE_KEY`,
      `CCIP_TOKEN_ADMIN_REGISTRY`, `CCIP_REGISTRY_MODULE_OWNER_CUSTOM`,
      `CCIP_LANE_CHAIN_IDS`; mirror chains additionally need
      `BASE_CHAIN_ID`; optional `CCIP_GUARDIAN` / `CCIP_RATE_CAPACITY`
      / `CCIP_RATE_REFILL`. Reads every deployed-contract address
      from the artifact `DeployCrosschain` wrote.
- **Step 2** (formerly "Canonical VPFI deploy", "Mirror deploy",
  "Wire the OFT peer mesh" as three separate steps) is now a
  single "Deploy the cross-chain layer" step that points at
  `DeployCrosschain.s.sol`. The script auto-forks on
  canonical-vs-mirror by `block.chainid`, so the same broadcast
  deploys the right contracts on every chain — the canonical
  chain pool is `LockReleaseTokenPool` over the pre-existing
  canonical `VPFIToken` (read from the deployments artifact),
  plus `VpfiBuyReceiver`; every mirror gets a fresh
  `VPFIMirrorToken` + `BurnMintTokenPool` + `VpfiBuyAdapter`;
  every chain gets `CcipMessenger`, `VpfiPoolRateGovernor`, and
  `VaipakamRewardMessenger`. Addresses use regular
  `new ERC1967Proxy(...)` deployment — non-deterministic. The
  per-chain `deployments/<chain>/addresses.json` is the canonical
  record of every deployed address.
  `VPFITokenFacet.setVPFIToken(...)` and `setCanonicalVPFIChain(...)`
  are operator actions outside this script.
- **Step 3** (formerly Step 4, "Wire the OFT peer mesh") is now
  "Configure CCIP lanes + token pools" and points at
  `ConfigureCcip.s.sol`. The script wires chain selectors,
  remote-messenger peers, the `vpfi-buy` + `vpfi-reward`
  channels, per-lane rate limits via `VpfiPoolRateGovernor`, and
  the `setBroadcastDestinations` list on the canonical reward
  messenger. The `CCIP_GUARDIAN` value (when set) lands on the
  `CcipMessenger`, `VaipakamRewardMessenger`, and local buy contract
  — **not** on `VPFIMirrorToken`, which the operator sets manually
  if matching the same guardian is desired. `TokenAdminRegistry`
  pool registration runs in the same script **only when the
  broadcasting admin is the token's `owner()`**; on canonical chains
  where the `VPFIToken` owner has already been moved to a
  timelock/multisig, the registration block is skipped with a
  console message and the token owner runs
  `registerAdminViaOwner` → `acceptAdminRole` → `setPool` as a
  separate, owner-broadcast transaction (the cutover runbook
  covers it). An anvil-rehearsal note points at the Foundry test
  `contracts/test/CcipDeploymentRehearsalTest.t.sol` for the local
  end-to-end pre-flight (run via `forge test --match-path
  'test/CcipDeploymentRehearsalTest.t.sol'`).
- **Step 4** (formerly Step 5) "Rotate `minter` to the diamond"
  is renumbered; the procedure is unchanged.
- **OFT Bridging Flow** → **VPFI Cross-Chain Token (CCT) Bridging
  Flow** — the outbound + inbound walkthroughs describe the
  Router-mediated CCIP path (lock on Base, mint on mirror,
  symmetric inbound), the committing DON + RMN verification + the
  executing DON delivery, and the in-flight-message supply
  invariant. A new "Failure model" paragraph documents that a
  paused contract's inbound CCIP message reverts and CCIP records
  it as a re-executable failed message — nothing is lost.
- **Script Reference** — `DeployVPFICanonical.s.sol`,
  `DeployVPFIMirror.s.sol`, `WireVPFIPeers.s.sol` are removed
  (the underlying scripts were deleted in T-068's Phase 5).
  Added: `DeployCrosschain`, `ConfigureCcip`,
  `ConfigureRewardReporter`, `ConfigureVPFIBuy`. The anvil
  rehearsal is the Foundry test
  `contracts/test/CcipDeploymentRehearsalTest.t.sol` rather than
  a script, so it's referenced from Step 3's prose only — not
  added to the Script Reference table.
- **Cross-Chain Security (CCIP)** section is unchanged — it was
  already CCIP-accurate. The historical contrast with LayerZero
  (the DVN-footgun explanation, the April 2026 ~$292M Kelp
  bridge exploit reference) stays because it's the load-bearing
  rationale for choosing CCIP, not a description of how the
  protocol runs.

The intro paragraph is trimmed — the historical "T-068 migrated this
from LayerZero to CCIP — April 2026" parenthetical is removed in
favour of a forward-looking framing. Detailed migration rationale
stays accessible via the ADR-0004 and migration-plan links retained
in the security section.

The "Known doc drift" warning at the top of the file is now removed.
Visitors to `https://vaipakam.github.io/vaipakam/` see a README that
describes the running protocol.

Closes #127.

## UX direction ADR — DEX/CEX conventions where they map, lending-native where they don't (Issue #166)

DeFi onboarding pain mostly comes from "the words / shapes I'm used to
from Uniswap / 1inch / Binance suddenly don't mean what I think they
mean." Vaipakam should reuse user muscle memory where the semantics
actually match — and consciously diverge, with clear naming and
tooltips, only where lending primitives have no DEX analog.

This release publishes
[`docs/DesignsAndPlans/UxDirectionDexCexHybrid.md`](../../DesignsAndPlans/UxDirectionDexCexHybrid.md)
— the design pass that names every Tier-A vocabulary borrow (where the
DEX/CEX wording AND idiom is adopted 1:1) and every Tier-B retention
(where the lending-native name stays but the visual idiom is borrowed
so the surface feels familiar). The ADR catalogues:

- **Tier A (13 entries)** — range/limit-order entry shape, fill modes,
  order expiry, in-place modification, slippage tolerance, basis-points
  display, base/quote pair selector, gas/network-fee disclosure,
  order-book idioms on `OfferBook`, notional/quantity toggle, "You
  sell / You buy" notation on confirm modals, risk-disclosure idiom,
  KYC-tier-up inline callout.
- **Tier B (10 entries)** — Health Factor + LTV, liquidation grace +
  time-based default, offer accept, collateral add/withdraw/partial,
  loan settlement / preclose / refinance, liquidation auction / dust
  close, early-withdrawal haircut, internal-liquidation match (if
  shipped), NFT rental prepay + buffer, claim.
- **Page-by-page checklist** — every retail-user-facing
  `apps/defi/src/pages/*.tsx` surface gets a current-state-to-
  target-state row naming exactly which Tier-A borrows and Tier-B
  retentions apply, and what concretely changes per page. The
  shared routing shell (`AppLayout.tsx`), admin / utility pages
  (`AdminDashboard`, `VaultAssets`, `VaultRecover`, `NftVerifier`,
  `DataRights`, `PublicDashboard`) are gathered in an explicit
  out-of-scope row — chrome and operator surfaces don't need the
  retail-DEX visual idioms this ADR scopes.
- **Sub-cards to file** — implementation cards grouped by user
  journey (order-entry / active-loan / post-loan / cross-cutting /
  conditional / adjacent). Standalone-page reworks get strictly
  1:1 cards (including dedicated cards for `Refinance.tsx`,
  `BorrowerPreclose.tsx`, and `LenderEarlyWithdrawal.tsx` rather
  than rolling them under the LoanDetails parent). Two deliberate
  paired-flow bundles share a single card each — `AddCollateral`
  + `PartialWithdraw` (sub-card 5e) and `KeeperSettings` + `Alerts`
  (sub-card 12) — because each pair shares a single panel slot and
  the same preview component, so a single card is the smaller
  deviation than splitting a shared-component implementation
  across two tickets.
  These cards land in the same wave as this ADR merge so each rework
  has a single source of truth for "what's the target state".
- **Out of scope** — the rejected vocabulary borrows ("margin ratio"
  instead of HF, "stop-loss" instead of liquidation, "funding rate" on
  the interest-rate field, etc.) are explicitly recorded so the design
  doesn't drift back toward the cargo-cult version.

The ADR respects the retail-deploy policy throughout — sanctions /
KYC / country-pair gates stay narrow on user-facing copy, never appear
on marketing or first-impression surfaces, and the runtime gates stay
disabled on retail per CLAUDE.md. The KYC-tier-up callout shape
(Tier A.13) exists for the industrial-deploy fork where the runtime
gates ARE on.

Implementation is sub-card work. This release publishes the design
chokepoint that prevents the cargo-cult version of the cross-DEX
visual lift.

Closes #166.

## Test-scaffolding fold — PauseGatingTest + KYCTierEnforcementIntegration onto SetupTest (#168 Track A, subset)

The cold-cache `forge build` for this repo is 15-25 minutes and 8 GB RSS,
driven mostly by the viaIR + optimizer pipeline expanding every
diamond-cut helper a test file constructs. Issue #168 audited that
compile surface and called out a duplication pattern: a long tail of
test files each declare a private `_cut(...)` helper that re-stamps the
production facet list, and the resulting `setUp` is byte-for-byte a
slimmed copy of `SetupTest.setupHelper()`. Each file that folds onto
`SetupTest` drops that duplicated cut bytecode from its own compile
unit and shares the single `SetupTest` compilation with every other
fold sibling.

A per-file cut audit (recorded on the Issue) narrowed Track A to the
files where the absolute LOC drop actually moves the cold-build needle:
`PauseGatingTest.t.sol` (31 tests, was cutting 18 facets in its own
setUp) and `KYCTierEnforcementIntegration.t.sol` (6 tests, 11 facets).
This release ships both folds. The other Track A candidates
(`DepthTieredLtvTest`, `PerAssetPauseTest`,
`AccessControlTransferAdminTest`) were dropped from this subset because
their bespoke setUps either cut a small enough facet set that the fold
gain is marginal, or they install KYC / pause / access-control state
that conflicts with `SetupTest`'s post-init defaults in ways that
require more setUp-overrides than the fold removes. `OfferFacetTest`
(3.7 kLOC, 21 facets) is the biggest single win on the table but stays
its own focused PR — its bespoke setUp wires up enough special-purpose
test state that the safe fold needs its own session.

Folding `PauseGatingTest` surfaced a second, more interesting drift:
`SetupTest`'s diamond was cutting 24 facets in its cut[] list, while
production cuts 36 (per `DiamondFacetNames.cutFacetNames()`, which
returns `string[36]`), plus `DiamondCutFacet` installed via the
diamond constructor identically in both production and tests. The
four facets the fold *needed* — `PrecloseFacet`, `RefinanceFacet`,
`EarlyWithdrawalFacet`, `PartialWithdrawalFacet` — were exactly the
ones every loan-mutation-past-creation test had to roll its own setUp
for. This release narrows that drift (24 → 28) using the same
strict-additive pattern the #173 work used to close the
`OfferMatchFacet` drift: every existing consumer keeps the same
diamond shape plus four newly-routed facets, and the pause-gating
regression guard's 9 previously-unreachable test cases
(`test_pause_precloseDirect`, `transferObligationViaOffer`,
`offsetWithNewOffer`, `completeOffset`, `refinanceLoan`,
`sellLoanViaBuyOffer`, `createLoanSaleOffer`, `completeLoanSale`,
`partialWithdrawCollateral`) now actually exercise the
`whenNotPaused` modifier they claim to guard. Closing this *specific*
drift was the load-bearing change for the fold — without it the
PauseGating fold would have hidden the same test-vs-prod blind spot
it was trying to remove.

The remaining 9-facet gap between `SetupTest` (28 cut[] entries: 27
production-overlap + 1 test-only `TestMutatorFacet`) and production
(36 cut[] entries, plus `DiamondCutFacet` in both via the constructor)
is the same class of drift — `DiamondLoupeFacet`, `OwnershipFacet`,
`OracleAdminFacet`, `LegalFacet`, `VPFIDiscountFacet`,
`InteractionRewardsFacet`, `RewardAggregatorFacet`,
`RewardReporterFacet`, `StakingRewardsFacet` are all still unrouted
in the test diamond. Closing that gap is tracked as a separate
focused refactor in issue #229; doing it inside this PR would inflate
the scope from "fold two tests" to "rebuild SetupTest", and several of
those facets need post-init wiring (CCIP messenger mocks, channel
registration, role grants) that warrants its own verification pass.

Test results: every existing SetupTest consumer (34+ files, 2031 test
cases) stays green; PauseGatingTest 31/31 passing; KYC integration 6/6
passing; full non-invariant regression 2031/0/1 (the single skip is
the long-standing pre-Phase-1 sanctions case). No production code
touched in this PR — this is a test-suite refactor against the
ambient code surface.

Closes #168 (Track A subset). The remaining Track A candidates plus
the `OfferFacetTest` fold stay on the Issue under follow-up cards;
Track B (coverage redundancy audit) stays as filed.

## Thread — In-place offer modification (PR #__, Closes #193)

Vaipakam offers have always required `cancelOffer` + `createOffer` to
change their terms. That's two transactions, two gas charges, two
vault round-trips, and a window where the offer is off-book. This
thread adds in-place modification so a creator can adjust their open
offer's principal range, rate range, or collateral range without
ever taking it off the book.

The shape is a new `OfferMutateFacet` carved into its own facet
mirroring the OfferCancel / OfferMatch precedent (one facet per
lifecycle concern, EIP-170 budget tracking stays clean). It hosts
three per-field setters and one combined atomic helper:

- `setOfferAmount(offerId, newAmount, newAmountMax)` — principal
  range. Lender ERC-20 offers pull / refund the delta in
  `lendingAsset`. Borrower NFT-rental offers pull / refund the
  prepay delta in `prepayAsset` (the prepay formula
  `amount × durationDays × (1 + bufferBps)` keys on `amount`, so a
  rate change moves the vaulted prepay). Other shapes update
  storage with no vault movement.
- `setOfferRate(offerId, newRateBps, newRateBpsMax)` — rate range.
  Never moves vaulted funds; rate is offer-terms metadata.
- `setOfferCollateral(offerId, newCollateralAmount, newCollateralAmountMax)`
  — collateral range. Borrower ERC-20 offers pull / refund the delta
  in `collateralAsset`. Borrower NFT-rental offers revert
  `CollateralMutationUnsupportedForShape` because that shape vaults
  prepay (in `prepayAsset`), not collateral; allowing storage writes
  without the corresponding escrow movement would create a divergence
  between the offer's stated collateral and what the matching path
  would expect.
- `modifyOffer(offerId, OfferModifyParams)` — combined atomic helper.
  Validates the union of per-setter invariants and settles the union
  of deltas in a single transaction. Emits one `OfferModified` event
  with the post-image of all six fields, so indexers see one mutation
  instead of three.

Invariants enforced on every entry point:

- Only the offer creator can modify their own offer
  (`NotOfferCreator`).
- Already-accepted offers are terminal — modification reverts
  `OfferAlreadyAccepted`, same as cancel.
- The post-mutation offer satisfies the same range invariants
  `createOffer` enforces (`amount > 0`, `amountMax >= amount`,
  `interestRateBpsMax >= interestRateBps`, etc.). The revert types
  are re-used directly from `OfferCreateFacet` so the create and
  modify surfaces speak the same revert ABI.
- Partial-fill bound: `amountMax >= amountFilled` and
  `collateralAmountMax >= collateralAmountFilled`. The portion
  already committed to live loans cannot be shrunk away — those
  loans reference the offer's terms; collapsing the cap below
  what's already filled would orphan real obligations.
- Per-asset pause + sanctions screening on the creator, same as the
  create path.

LIF is NOT charged on a modify — LIF is a loan-init fee, not an
offer-mutation fee. The matcher-fee kickback math also stays
unchanged; modify operates on offers, not loans.

The companion `OfferModified` event carries the full post-image so
indexer / frontend cache merges update from the event payload alone
— no follow-up `getOffer` view-call needed. The "before" snapshot is
intentionally omitted (recoverable from the indexer's prior
`OfferCreated` / `OfferModified` row).

Operational note: the borrower NFT-rental amount-delta math uses the
**current** `rentalBufferBps` for both sides of the diff. A
governance bufferBps change between create and modify would leave a
tiny refund / pull mismatch versus the actually-vaulted prepay,
proportional to the buffer delta. Buffer changes are rare governance
events; the design accepts this drift rather than snapshotting
bufferBps on every offer.

Out of scope and tracked separately:

- The order-book UI for the modify interaction (pencil-icon on the
  user's own-offer rows) — tracked under `#166` as the UX surface.
- The `MIN_OFFER_CANCEL_DELAY` cooldown countdown chip — tracked
  under `#241` (the cooldown predates this thread; surfacing it is
  orthogonal to modify-in-place).
- A GTC user-cancel treasury fee — explicitly rejected in the design
  discussion. Gas alone (create + cancel = ~$0.50-1.00 on Base L2)
  is already a meaningful spam disincentive; adding a protocol fee
  would just stack on top without changing the spam equilibrium.
  The existing `MIN_OFFER_CANCEL_DELAY` cooldown (5 min when
  `partialFillEnabled` is on) covers front-run defence.

## Self-trade prevention on direct-accept + matchOffers (Issue #194)

A single address can no longer occupy both sides of a loan at initiation. The protocol rejects any acceptance whose resulting loan would have the same address as both lender and borrower, with a typed `SelfTradeForbidden(address party)` revert that names the colliding address. The check covers every accept path — direct `acceptOffer` and bot-driven `matchOffers` — through a single load-bearing gate in `_acceptOffer` that fires after role resolution and before any state mutation.

Bots running the public `previewMatch` API see the same condition surfaced as a structured `MatchError.SelfTrade` classifier (a new variant on the existing enum), so they short-circuit before submitting a transaction that would revert. The classifier is a UX nicety on top of the contract gate, not a separate enforcement point — the contract revert is the authority.

The policy closes three risk vectors the card called out: a user paying themselves the matcher kickback portion of the Loan Initiation Fee (free yield on a low-gas chain), a user pumping their share of the cross-chain reward denominator with manufactured activity, and the protocol's active-loan analytics being polluted by positions a single user already owns. Legitimate position-mutation flows go through `PrecloseFacet` (preclose / offset / transfer-obligation) and `RefinanceFacet`, which are dedicated entry points and unaffected by this change.

The full policy rationale — including the two rejected branches (Allow-but-tax the matcher kickback, Allow unchanged) and why Branch A (Enforce) was chosen — is recorded in `docs/DesignsAndPlans/SelfTradePreventionADR.md`. The Functional Spec (`docs/FunctionalSpecs/ProjectDetailsREADME.md` §5) records the new invariant: "no single address may occupy both sides of a loan at initiation."

Scope notes:

- Multi-account self-dealing — a user with two wallets W1 and W2 posting offers from each — is out of reach for a contract-side gate (the protocol has no on-chain identity layer beyond `address`). The invariant is about the loan's two sides collapsing onto a single address; Sybil-style wallet pairs are an off-chain analytics concern.
- Approved-keeper self-trade still fires the revert. If a user authorizes a keeper to act on their behalf and that keeper matches the user's lender and borrower offers, the resulting loan still has `lender == borrower == userAddress`. Keepers don't bypass the gate.

Test coverage in `contracts/test/SelfTradePreventionTest.t.sol`: five cases — direct-accept of own lender offer, direct-accept of own borrower offer, matchOffers between two same-creator offers (third-party submitter; revert still fires), `previewMatch` surfaces the classifier without reverting, plus a happy-path negative-control with two distinct creators to catch any regression that inverts the gate. Full regression at 2046 / 0 / 0 (5 new tests, 2041 baseline pre-#194).

Wiring:

- `OfferAcceptFacet` declares the new `SelfTradeForbidden(address)` error; its ABI gains the selector via the standard frontend + bot ABI re-export.
- `LibOfferMatch.MatchError` gains the `SelfTrade` variant; `previewMatch` returns it early when `L.creator == B.creator`.
- `OfferMatchFacet.matchOffers` re-raises `SelfTradeForbidden` from the classifier so the matchOffers caller sees the same revert ABI the direct-accept path returns.

The bot-side matcher (`apps/keeper/src/matcher.ts`, public reference `vaipakam-keeper-bot/src/detectors/offerMatcher.ts`) should add `MatchError.SelfTrade` to its preview-result switch alongside the other typed errors it already short-circuits on. Until that update lands, bots will still submit the matchOffers transaction and burn gas on the revert — a follow-up to harden the off-chain matchers against the new classifier is tracked outside this card.

Closes #194.

## Thread — GTT / offer-expiry support (PR #__, Closes #195)

Vaipakam offers have been purely Good-Till-Cancelled (GTC) since day
one: an offer lives in the order book until its creator calls
`cancelOffer`. This thread adds optional **Good-Till-Time** semantics
without changing the GTC default. Creators can now post an offer with
an absolute unix-seconds deadline; once the wall-clock passes the
deadline, the offer can no longer be accepted or matched, and the
permissionless lazy-clear path lets anyone tidy up the storage row
(refund flows to the creator regardless of who calls it).

The shape is intentionally minimal:

- `Offer.expiresAt` (`uint64`) packs into the same storage slot as
  the existing `createdAt`, so the storage layout grows without
  consuming a new slot. Every legacy storage row reads
  `expiresAt == 0` — the GTC sentinel — so pre-#195 offers behave
  exactly as before.
- `CreateOfferParams.expiresAt` is the create-time input. `0` keeps
  the GTC default; any non-zero value must lie strictly after now
  and within a one-year horizon cap (`MAX_OFFER_EXPIRY_HORIZON`).
  Out-of-bound values revert `OfferExpiryInPast` or
  `OfferExpiryAboveCap(provided, cap)`.
- Lazy enforcement: every consumer that binds an offer to a loan —
  `_acceptOffer`, `LibOfferMatch.previewMatch`,
  `OfferMatchFacet.matchOffers` — runs `LibVaipakam.isOfferExpired`
  before any state mutation and reverts `OfferExpired(offerId,
  expiresAt)`. The matching `MatchError.OfferExpired` classifier
  surfaces through `previewMatch` so bots can short-circuit at
  preview-time. `previewAccept` gains the same classifier on
  `AcceptError.OfferExpired` so the connected app can render an
  "expired" badge and disable the Accept button without an extra
  RPC roundtrip.
- `cancelOffer`'s access gate widens: the creator can still cancel
  their own offer unconditionally, AND any caller can cancel an
  offer whose deadline has elapsed. The cleaner pays gas; the
  refund routes to `offer.creator` (never `msg.sender`), so the
  permissionless path can't be used to drain another user's vault.
  The cancel-cooldown bypass for expired offers preserves the
  consistency invariant ("an expired offer is always cleanable")
  even when `partialFillEnabled` is on.

`OfferCreatedDetails` carries `expiresAt` on the companion event so
indexers and the frontend cache can render the GTT decoration
("expires in 3h 12m"; "expired — anyone can clean up") directly from
the event payload — no follow-up `getOffer` view-call.

Why we picked lazy enforcement over a keeper sweep: EIP-3529 caps
gas refunds at 1/5 of the transaction gas, so a protocol-run sweep
would burn ~5× the value of the refunds it captures. Lazy
enforcement + permissionless explicit clear gets correctness without
that economic loss — and avoids the operational burden of running
yet another keeper bot. The full alternatives table lives in
`docs/DesignsAndPlans/OfferExpiryGTTDesign.md`.

Out of scope and tracked separately: other fill modes
(AON / IOC / FOK / POST — `#125`); auto-renew / TWAP-style time-priced
offers; the optional treasury retention on GTC user-cancel for
spam-defense, deferred to `#193`'s in-place-modification thread
because the cancel-vs-modify ratio only becomes meaningful once
modification exists.

## previewAccept(offerId, acceptor) — contract-side dry-run for direct-accept (Issue #196)

The Range-Orders matching path already exposed `OfferMatchFacet.previewMatch(lenderOfferId, borrowerOfferId)` so a keeper bot or the frontend could ask the protocol "what loan would land here?" before submitting a match. The direct-accept path — `OfferAcceptFacet.acceptOffer(offerId, true)` — had no such surface. The frontend's AcceptOffer modal and the indexer / keeper that project the would-be loan had to duplicate the protocol's role-aware mapping (lender direct-accept reads the lender's max + floor rate; borrower direct-accept reads the borrower's floor + ceiling rate; NFT rentals stay single-value) plus run a separate computation for the 0.1% Loan Initiation Fee with VPFI-discount short-circuit. That duplication is exactly the class of drift the May-2026 watcher offer-decode incident exposed.

This release adds **`previewAccept(uint256 offerId, address acceptor) → AcceptPreview`** as a pure view on `OfferAcceptFacet`. One `eth_call` returns the projection (`effectivePrincipal`, `interestRateBps`, `collateralAmount`, `lifEstimate`, `collateralResidualRefund`) plus a typed `AcceptError` enum classifying any would-be revert — `OfferAlreadyAccepted`, `SanctionedAcceptor`, `SanctionedCreator`, `AssetPaused`, `CountriesNotCompatible`, `RiskAndTermsConsentRequired`, `KYCRequired`. The only path that reverts instead of surfacing through `errorCode` is `InvalidOffer` (non-existent slot), mirroring `acceptOffer`'s top-of-function behaviour.

The load-bearing design choice: happy-path projection fields stay populated even when `errorCode != None`, so the frontend can render meaningful copy like "tier-up to unlock this offer at 10k principal, 300 bps" alongside the `KYCRequired` error, instead of the bland "KYC required" the protocol used to surface. Pause and country-pair errors are recoverable too — the operator unpausing the asset or the user's country changing flips the offer back to acceptable.

The LIF estimate mirrors the VPFI-discount probe `_acceptOffer` itself runs before pulling VPFI: tier ≥ 1, consent flipped, vault holds ≥ the full LIF-equivalent VPFI, and the borrower-side oracle route resolves. When the probe says the discount would apply, `lifEstimate = 0`; otherwise it's the 0.1% of `effectivePrincipal`. NFT-rental offers always project `lifEstimate = 0` because the LIF path is guarded behind `assetType == ERC20`.

Coverage:

- **Happy-path pins** — four scenarios mirror the load-bearing assertions in `AcceptRangedOfferTest`: lender-ranged offer accepted by borrower (principal = `amountMax`, rate = `interestRateBps`); borrower-ranged offer accepted by lender (principal = `amount`, rate = `interestRateBpsMax`); borrower-ranged-collateral with `collateralAmountMax > collateralAmount` (residual refund populated); single-value (non-ranged) lender offer. Each test computes the preview first, runs the real `acceptOffer`, and asserts the loan shape matches the projection field-for-field. If `previewAccept` drifts from `_acceptOffer`'s mapping, these pins fail.
- **Error-code walks** — one test per `AcceptError` variant: `OfferAlreadyAccepted` (accept once, preview again — surfaces error and still populates the projection so the indexer can render historical offers); `KYCRequired` (drop borrower to Tier-0 with enforcement on, project a Tier-2-threshold offer — happy-path fields stay populated for the tier-up nudge); `AssetPaused` (pause the lending leg); `SanctionedAcceptor` and `SanctionedCreator` (mock the sanctions oracle to flag each side independently). Plus the `InvalidOffer` revert test.

Wiring:

- `OfferAcceptFacet` selector list extended from 3 to 4 in `DeployDiamond.s.sol` (cut #18 of 36 on the production diamond) and in `HelperTest.sol` (the SetupTest scaffolding).
- ABI re-export: `packages/contracts/src/abis/OfferAcceptFacet.json` carries the new selector, the `AcceptPreview` tuple and the `AcceptError` enum. The sibling reference bot's `src/abis/` syncs from the same export script.
- The `SelectorCoverageTest` deploy-sanity guard automatically catches a missed wiring step, so the selector list is provably consistent across `DeployDiamond` and `HelperTest`.

No state-changing change to existing code paths — every legacy `acceptOffer` flow is byte-identical. This release adds a new external view and the two structural types it returns.

Closes #196. Frontend consumer wiring (`useAcceptPreview(offerId)` hook + integration into the `OfferDetails` / `AcceptOffer` modal) lands in its own follow-up PR.

## Thread — CCIP guardian-pause coverage (PR #__, Closes #200 + #201)

Two code-vs-docs gaps surfaced during the PR #198 README doc-
verification pass converge to one resolution.

ADR-0004 ("CCIP over LayerZero") used to claim **"every cross-chain
contract carries `GuardianPausable`"**, but the rate-limit admin
`VpfiPoolRateGovernor` deliberately doesn't extend the pause base —
it has no runtime send / receive path of its own, and its setters
are already owner-gated through `Ownable2Step`, so pausing it during
a cross-chain incident wouldn't be load-bearing. Meanwhile,
`ConfigureCcip._setGuardians` wired the guardian on the messenger,
reward messenger, and local buy contract — but not on
`VPFIMirrorToken`, which DOES extend `GuardianPausable` and very
much wants the incident-response fast-pause path on mirror chains.
Operators were left to remember the manual `setGuardian` step, which
is exactly the kind of footgun the deploy script exists to remove.

The fix lands in both directions:

- **ADR-0004 wording qualified** to "every cross-chain contract
  *with a runtime send / receive path*" and the contracts that carry
  `GuardianPausable` are enumerated by name (`CcipMessenger`,
  `VaipakamRewardMessenger`, `VpfiBuyAdapter`, `VpfiBuyReceiver`, and
  the mirror-chain `VPFIMirrorToken`). `VpfiPoolRateGovernor` is
  named as the intentional exception with the reasoning above.
- **`ConfigureCcip._setGuardians` extended** to wire the guardian on
  `VPFIMirrorToken` on mirror chains. The canonical `VPFIToken`
  (Base) doesn't get the call — it's the long-lived OFT-shaped
  token, paused via its own AccessControl path, not the cross-chain
  guardian.

Both findings move from open-divergence to resolved in
`docs/FunctionalSpecs/_CodeVsDocsAudit.md`. Mainnet operators no
longer need to remember the manual mirror-token-guardian step;
auditors reading ADR-0004 see the universal-coverage claim qualified
to match what's actually shipped.

Closes #200, #201.

## Shared RiskCallout component — the canonical state-mutating-confirm risk shape (Issue #215)

Per the UX direction ADR landed via PR #201 (`docs/DesignsAndPlans/UxDirectionDexCexHybrid.md`, Tier A.12), the canonical visual idiom for "this state-mutating action carries risk; confirm you understand" is a single shape — a coloured-band wrapper around localised risk disclosures with an inline consent checkbox, modelled on the DEX "slippage too high, increase tolerance" inline-warning convention.

Pre-#215, four pages (`CreateOffer`, `OfferBook`, `BorrowerPreclose`, `LenderEarlyWithdrawal`) each duplicated the same nine-line pattern — `<RiskDisclosures />` followed by a `<label className="checkbox-row">` wrapping `<input type="checkbox">` and `<RiskConsentLabel/>`. The duplication meant each consumer page could drift independently in spacing, behaviour, or accessibility wiring.

This release adds the shared `RiskCallout` component
(`apps/defi/src/components/app/RiskCallout.tsx`) plus its stylesheet
and a Vitest unit suite. The component composes the existing
`RiskDisclosures` body for the localised copy and `RiskConsentLabel`
for the consent text — so this PR adds the canonical wrapper around
existing pieces rather than duplicating any translation strings or
disclosure logic.

Consumers migrate from the nine-line pattern to a single
`<RiskCallout consent={...} onConsentChange={...} />` call in the
per-page rework cards that depend on this one (#204 CreateOffer,
#206 OfferDetails, #210 Refinance, #211 BorrowerPreclose,
#212 LenderEarlyWithdrawal, #218 BuyVPFI). This PR ships the
component alone with no consumer migrations — each consuming
sub-card lands its own minimal diff that swaps the duplicated
block for `RiskCallout`.

Accessibility shape recorded in the component's JSDoc and exercised
by the test suite: the wrapper carries `role="region"` with an
`aria-labelledby` pointing at a visually-hidden heading inside the
band, the checkbox uses `htmlFor` / `id` pairing rather than nesting
inside the label, and the input carries `aria-required="true"` to
announce the consent gate to screen readers.

The component also exposes an `extra` slot so per-flow risk details
(an early-withdrawal haircut chip, a refinance preview line, a buy-
flow cross-chain disclosure) can render INSIDE the colour band
between the disclosures body and the consent row — keeping the
per-flow content close to the consent gate it pertains to, without
forcing the shared component to know about every flow's specifics.

Tests: 10 unit cases covering consent state both directions, the
disabled state, the aria-required wiring, the labelled-region
contract, the extra-slot rendering, className passthrough, and
unique-id generation across multiple co-mounted instances. The test
mocks `react-i18next` so the suite stays focused on the component's
own behaviour; the localised disclosure content is exercised by
`RiskDisclosures`'s own coverage.

Closes #215. Unblocks the six consuming sub-cards (#204, #206, #210, #211, #212, #218) per the #166 ADR's dependency graph.

## Shared BPS helper + GasChip component (Issue #216)

Per the UX direction ADR Tier A.6 + A.8 (`docs/DesignsAndPlans/UxDirectionDexCexHybrid.md`, merged via PR #201), every rate / fee surface in `apps/defi` should render a percent display with a basis-points qualifier on hover, and every state-mutating confirm modal should disclose an estimated network fee in a uniform visual shape pinned above the primary CTA. Pre-#216 those two needs were met by ad-hoc inline expressions scattered across five pages (`Dashboard`, `LenderEarlyWithdrawal`, `NftVerifier`, `PublicDashboard`, `OfferBook` — for the BPS side) and two surfaces (`LiquidateButton`, Permit2 preview — for the gas side), each in its own visual treatment.

This release adds the two cross-cutting unblockers the #166 ADR called out as sub-card 8:

- **`apps/defi/src/lib/bpsFormat.ts`** — pure-function `formatBps(bps, opts)` returning `{ display, tooltip }` (e.g. `"5.05 %"` + `"5.05 % (505 bps)"`). Configurable precision (default 2, with documented per-surface overrides — HF / LTV chips at 1, fee rows at 2, tier-comparison tables at 3) and an opt-out for surfaces where the BPS qualifier would confuse a non-DeFi reader. Convenience wrappers `bpsToDisplay` / `bpsToTooltip` for surfaces that only need one side. Handles negative, zero, NaN, and Infinity inputs explicitly.
- **`apps/defi/src/components/app/BpsValue.tsx`** — thin React wrapper that renders a `<span>` with the display in the visible slot and the tooltip text in `title=`. Composable: `<BpsValue bps={505} />` replaces every ad-hoc `${(bps / 100).toFixed(2)} %` expression.
- **`apps/defi/src/components/app/GasChip.tsx`** — pure-presentational network-fee chip. Takes pre-computed `gasUnits` + `gasPriceWei` + `nativePriceUsd` props and renders `"0.00063 ETH (~ $1.89)"`. Auto-shows an em-dash placeholder when the estimate is in flight so the consuming modal layout doesn't flicker. The chip deliberately makes NO RPC calls — the consuming page owns the estimate fetch + the refresh-pre-sign policy.
- **`apps/defi/src/components/app/GasChip.css`** — neutral grey chip with `tabular-nums` digit metric so consecutive renders during refresh-pre-sign don't cause the chip width to dance.

Tests: 11 cases for `formatBps` (typical / sub-1% / zero / negative / custom precision / withBpsHint / NaN / Infinity / convenience wrappers), 7 cases for `BpsValue` (display / tooltip / precision / withTitle / className / NaN placeholder), 11 cases for `GasChip` (native amount + USD qualifier + non-18-dec / pending states / non-finite price guard / accessibility / className / trailing-zero trimming).

NO consumer migrations in this release — each of the ~10 consuming sub-cards (most #166 sub-cards consume one or both) lands its own minimal diff that swaps the ad-hoc pattern for `<BpsValue/>` / `<GasChip/>`. This card ships the components alone.

Accessibility:

- `BpsValue` exposes the BPS qualifier via the standard `title=` attribute (native tooltip on hover; AT picks it up via the accessible-name fallback chain).
- `GasChip` exposes the chip as `role="status"` with an `aria-label` (default `Estimated network fee`; consumers can override for cross-chain or CCIP-fee surfaces).

Closes #216. Unblocks the remaining #166 sub-cards (#204, #206, #207, #208, #210, #211, #212, #218, #219) — every one of them consumes one or both of these components.

## Repo-wide rename — Escrow → Vault (Issue #227)

This release renames every "Escrow" / "escrow" reference across the entire
repo to "Vault" / "vault". The change is purely a naming clarification — the
on-chain semantics, fund flows, access control, and per-user isolation are
unchanged. What changed is the surface vocabulary:

- The per-user UUPS proxy that holds a user's assets used to be referred to
  as an "escrow"; from this release on, it is a "Vault" — the established
  DeFi-native term (Yearn, Curve, Morpho, and Aave all use "Vault" for
  per-user or per-position asset containers).
- The deploying facet renamed from `EscrowFactoryFacet` to `VaultFactoryFacet`;
  its shared implementation from `VaipakamEscrowImplementation` to
  `VaipakamVaultImplementation`; the cross-facet helper library from
  `LibUserEscrow` to `LibUserVault`. Every external function, event, error,
  storage slot, and ERC-7201 namespace tracks the same rename.

The motivation is a legal-implications cleanup. "Escrow" carries
regulated-fiduciary-holder connotations under several jurisdictions
(state-by-state US escrow agent statutes; UK Financial Services and Markets
Act references; EU MiCA's "custody" wrapper) — connotations Vaipakam does not
want to anchor to as a permissionless DeFi protocol. The on-chain object
isn't a regulated escrow; it's an isolated per-user vault under the user's
own beneficial ownership. The rename brings the surface vocabulary in line
with that reality before mainnet cutover, while the legal-cost-of-change is
still zero.

Pre-mainnet timing matters: ERC-7201 storage namespaces derive deterministic
storage slots from their string identifier
(`keccak256(abi.encode(uint256(keccak256(name)) - 1)) & ~bytes32(uint256(0xff))`),
so renaming `vaipakam.userEscrow*` to `vaipakam.userVault*` shifts every slot
that holds per-user vault state. Post-mainnet, that shift would orphan every
user deposit; pre-mainnet, with no deposits in flight, the shift is a no-op
for users. Function selectors and event topics also derive from the name
hash, so the rename invalidates every external selector / topic — the ABI
re-export (a separate sync step) regenerates them, and every consumer
(frontend, indexer, keeper, sibling reference bot) updates atomically with
this release.

What the release covers, top-down:

- **Smart contracts (`contracts/src/`)** — 7 file renames, ~110 source-file
  in-place updates. Facets, libraries, interfaces, the UUPS implementation,
  every external function name, event, error, storage variable, and
  ERC-7201 namespace.
- **Contract tests (`contracts/test/`)** — 4 file renames, every test fixture
  and assertion updated. The deploy-sanity guardrails (`FacetSizeLimitTest`,
  `SelectorCoverageTest`) pick the new symbol set up via `DiamondFacetNames`,
  which now lists `VaultFactoryFacet` in place of `EscrowFactoryFacet`.
- **Deploy scripts (`contracts/script/`)** — every deploy / flow script
  references the renamed facet; `exportAbis.sh` and `exportFrontendAbis.sh`
  list the new facet names.
- **Indexer (`apps/indexer/`)** — the event-routing decode shape, sourced
  from the compiled Diamond ABI, picks the new event names up automatically;
  the `check-event-coverage.mjs` CI guardrail's allowlist comments are
  rephrased. No SQL migration was needed — the audit found no `escrow_address`
  column in the migration history.
- **Frontend (`apps/defi/`)** — every component, page, hook, library helper,
  test, and i18n key (English source-of-truth) updated. The 9 non-English
  locales got mechanical English-string substitutions; a translator-review
  follow-up card will route those to native speakers to confirm whether
  "vault" should translate differently than "escrow" in each language.
- **Marketing site (`apps/www/`)** — 21 files mechanically renamed AND
  flagged for legal-counsel review before merge. Highest-priority review
  targets: `TermsPage.tsx` (Terms of Service), `Whitepaper.en.md`,
  `Security.tsx` (security narrative). Reviewer should treat each flagged
  file as a potential blocker — any phrasing that reads as a "regulatory
  description of fund-holding" needs human sign-off before merge.
- **Documentation (`docs/`)** — every FunctionalSpec, ADR, DesignsAndPlan,
  runbook, and historical doc that references escrow renamed. ADR-0008
  (renamed file `0008-per-user-vault-factory.md`) carries an explicit
  "2026-05-22 rename note" header callout explaining the historical "escrow"
  usage and why it changed. `docs/GLOSSARY.md` gains a "Vault (formerly
  Escrow)" entry pointing back at ADR-0008.
- **Cross-cutting docs** — top-level `AGENTS.md`, `CLAUDE.md`, `README.md`,
  `SECURITY.md`, `CHANGELOG.md` all updated.
- **Packages (`packages/contracts/`, `packages/lib/`)** — ABI JSON path
  rename (`EscrowFactoryFacet.json` → `VaultFactoryFacet.json`) plus barrel
  re-export updates. The authoritative ABI re-export (regenerating every
  JSON from the compiled facets) runs as a separate verification step at
  the end of the PR.
- **Sibling reference bot (`vaipakam-keeper-bot`)** — coordinated companion
  PR updates the bot's TS code to consume the renamed symbols and the
  regenerated ABIs. Both PRs land in lockstep so the public reference bot
  doesn't lag the monorepo.

What is intentionally NOT included:

- Historical release notes (`docs/ReleaseNotes/ReleaseNotes-*.md`) stay
  verbatim. They describe what shipped under the old name; rewriting them
  would be revisionism.
- Translator review of the 9 non-English `apps/defi` locales — separate
  follow-up card; the mechanical English-string substitution here is a
  starting point, not a finished translation.
- Brand collateral (logo / favicon / OG image alt text) — separate UX card
  if/when those reference escrow.

Closes #227.

## SetupTest is now a strict superset of production (Issue #229)

PR #228 (#168 Track A subset) extended `SetupTest.t.sol`'s diamond cut from 24 → 28 facets so the `PauseGatingTest` fold could exercise selectors that production routes but the test diamond was silently missing. The fold surfaced a real test-vs-prod blind spot — 9 PauseGating cases had been silently asserting `FunctionDoesNotExist()` instead of `EnforcedPause()` because the test diamond didn't route the relevant facets. PR #228 closed four of those drift cases (`PrecloseFacet`, `RefinanceFacet`, `EarlyWithdrawalFacet`, `PartialWithdrawalFacet`); Codex reviewing that PR flagged the remaining 9-facet gap and filed this card to close it.

This release brings SetupTest's cut from 28 → 37 — matching every facet in `DiamondFacetNames.cutFacetNames()` plus `TestMutatorFacet` (intentionally retained on top of the production superset for the direct-write hooks invariant tests depend on). After this PR, SetupTest is a strict superset of production: every selector in the production diamond is reachable through SetupTest's `setupHelper()`, and a test that asserts `FunctionDoesNotExist()` against a production-routed selector now correctly fails.

The 9 newly-routed facets, slotted into `cuts[28..36]`:

- **`DiamondLoupeFacet`** — `facets()`, `facetAddress()`, `facetFunctionSelectors()` diamond-inspection surface.
- **`OwnershipFacet`** — ERC-173 ownership reads.
- **`OracleAdminFacet`** — the full 34-selector admin set (Chainlink registry / Tellor / API3 / DIA / Pyth / sequencer / Phase 3-4 peer-protocol and tier-reference-asset registries). Several test files previously did their own subset cut here; with the full set now routed by SetupTest, those local subsets become redundant and are stripped.
- **`LegalFacet`** — the 5-selector ToS-acceptance gate; sanctions oracle defaults to `address(0)` (fail-open per the retail-deploy policy in CLAUDE.md), so no post-init wiring is needed for tests.
- **`VPFIDiscountFacet`** — borrower-LIF discount surface; reads from shared storage with safe zero defaults.
- **`StakingRewardsFacet`** — VPFI staking surface.
- **`InteractionRewardsFacet`** — interaction-rewards reporting hooks.
- **`RewardAggregatorFacet`** — cross-chain reward aggregation.
- **`RewardReporterFacet`** — cross-chain reward REPORT/BROADCAST.

None of the 9 require post-init wiring; their state is either read on demand from shared storage with zero defaults that are valid for happy-path consumers, or admin-gated and accessible because the deployer already holds every role via `initializeAccessControl()` inside `setupHelper()`.

Two new selector-helper functions were added to `HelperTest.sol`: `getOracleAdminFacetSelectors()` (34 selectors, mirroring `_getOracleAdminSelectors` in `DeployDiamond.s.sol`) and `getLegalFacetSelectors()` (5 selectors, mirroring `_getLegalSelectors`). The other 7 selector helpers already existed in `HelperTest.sol` from earlier work; they just weren't being consumed by the SetupTest cut list.

Sixteen test files had previously done their own local `new XxxFacet()` + local `diamondCut(...)` block in `setUp()` precisely BECAUSE SetupTest's cut was missing those facets — each carried a comment along the lines of "SetupTest does not include it." With #229's superset closure, those local cuts would double-cut over SetupTest's pre-cut and revert (`LibDiamondCut: Can't add function that already exists`). All sixteen are de-duplicated in this release: the local declarations, constructions, and cut blocks are removed; the inherited SetupTest fields are used instead. The cleanup is uniform — every removed block carries a `// #229 — ...` comment pointing at the new home of the cut.

Full regression at **2046 / 0 / 0** (no skips this round), matching the pre-#229 baseline test count. The drift fix is structurally invisible to consumers — every existing test sees the same diamond shape it always saw, now with the production-mirror property the test scaffold should have had from the start.

Closes #229. The #168 Track A residual files (`OfferFacetTest`, `DepthTieredLtv`, `PerAssetPause`, `AccessControlTransferAdmin`) stay on #168 as deferred Track A candidates; #229 was the SetupTest-side gap only.

## LayerZero → CCIP doc cleanup + SECURITY.md cross-chain rewrite (Issues #230 + #113)

T-068 (PR #46, merged 2026-05-18) migrated every cross-chain code path off LayerZero to Chainlink CCIP. The contracts and live infrastructure have been CCIP-only since then, but several user-facing documents and a small surface of TypeScript types still carried the pre-T-068 LayerZero framing. This release closes the load-bearing parts of that drift and files a focused follow-up for the wider doc sweep.

**SECURITY.md (closes #113):** the "Cross-chain security" section is fully rewritten to describe CCIP — committing DON + executing DON + the independent Risk Management Network — instead of the LayerZero-era DVN policy table and per-chain confirmation matrix. The new section names the actual contracts that ship today (`CcipMessenger`, `VPFIMirrorToken`, the stock CCIP `LockReleaseTokenPool` / `BurnMintTokenPool`, `VpfiBuyAdapter` / `VpfiBuyReceiver`, `VaipakamRewardMessenger`, `VpfiPoolRateGovernor`), records the three mainnet-deploy gates (CCIP lanes enabled, per-lane rate limits configured, CCT admin → timelock), and points at the `GuardianPausable` pause surface as the operational kill-switch. The audit-scope bullets are updated to reference the CCIP surface in place of the LayerZero OApp / OFT surface. The April 2026 cross-chain bridge incident — the exploit that motivated the migration — stays in the document as the rationale paragraph, in past tense.

**Stale-active-code (closes #230 — load-bearing part):** the `lzEid` field is gone from every TypeScript chain-config and deployments shape (`packages/contracts/src/chain-config.ts`, `packages/contracts/src/deployments.ts`, `apps/defi/src/contracts/config.ts` with its 13 per-chain values, `apps/defi/test/pages/Dashboard.test.tsx`, and the consolidated `packages/contracts/src/deployments.json` with three per-chain JSON entries). The cache-key salt in `apps/defi/src/hooks/useVPFIDiscount.ts` that mixed the LayerZero endpoint id into the per-wallet cap bucket has been re-keyed on `chainId` directly — same isolation guarantee, no LayerZero artifact in the live cache shape. The LayerZero ULN302 "executor options not configured" friendly-error entry was removed from `packages/lib/src/decodeContractError.ts`; the selector is no longer reachable from any active code path post-CCIP. A surgical fix in CLAUDE.md corrected the one remaining "via LayerZero" present-tense reference in the VPFIBuyAdapter payment-token-mode section to "via Chainlink CCIP (post-T-068, 2026-05-18)."

**Glossary (closes part of #230 acceptance):** `docs/GLOSSARY.md` already had a "LayerZero (legacy)" entry; it has been tightened to the documented form "LayerZero (deprecated 2026-05-18)" with the full migration narrative — the five LayerZero-era contracts that were retired, the contract directory move from `contracts/src/token/` to `contracts/src/crosschain/`, the April 2026 Kelp exploit context that drove the migration, and cross-references to ADR-0004 and `docs/DesignsAndPlans/LayerZeroToChainlinkCcipMigration.md`. Anyone landing on the glossary from an old reference now finds the deprecation note plus a forward pointer to the current architecture.

**What's intentionally NOT in this PR (tracked as #236):** README.md still has approximately six sections that describe LayerZero in present tense (the cross-chain transport table, the cross-chain reward mesh section, the bridge surface section, the operator runbook, the DVN configuration section). `docs/ops/` runbooks carry similar present-tense LayerZero language. `apps/www/` marketing copy and the i18n locale files reference LayerZero across roughly 34 files; per the #227 precedent, marketing content requires legal-counsel review and is a separate scope. `apps/defi/src/i18n/glossary.ts` keeps its `GLOSSARY_KEEP_VERBATIM` entries for "OFT", "LayerZero", and "VPFIOFTAdapter" — those entries protect translation invariants in user-facing copy that still exists, and removing them only makes sense after the apps/www sweep above. The `ops/lz-watcher` Cloudflare Worker (with its dedicated `vaipakam-lz-alerts-db` D1) needs an explicit decommission-or-rename decision from the operator. All five surfaces are scoped on #236.

**Migration rationale preserved:** every doc that describes the LayerZero → CCIP migration as historical context — ADR-0004, `docs/DesignsAndPlans/LayerZeroToChainlinkCcipMigration.md`, CLAUDE.md's "Cross-Chain Security Policy" section, and the post-2026-04 release notes — is unchanged. The migration story is load-bearing for understanding why the protocol uses CCIP today, and the LayerZero references in those documents are deliberate, not stale.

Closes #230 (the audit + load-bearing cleanup) and #113 (SECURITY.md cross-chain rewrite). Remaining doc surfaces tracked on #236.

## apps/keeper matcher — self-trade pre-filter + classifier log (Issue #235)

PR vaipakam/vaipakam#234 added `MatchError.SelfTrade` to the on-chain `LibOfferMatch.MatchError` enum and the `SelfTradeForbidden(party)` revert in `OfferAcceptFacet._acceptOffer`. The bot-side matchers — `apps/keeper/src/matcher.ts` (the protocol's own keeper Worker) and the public reference `vaipakam-keeper-bot/src/detectors/offerMatcher.ts` — kept submitting `matchOffers` for same-creator pairs and burning gas on the revert until they read the new classifier.

This release closes that gap on the protocol's own keeper. Two changes:

- A client-side pre-filter compares `L.creator` and `B.creator` before issuing the `previewMatch` `eth_call`. Same-creator pairs are skipped without an RPC roundtrip — one fewer call per colluding pair per tick. The `OfferLite` interface gains a `creator: Address` field; the `liftOffer` mapper picks it up from `getOffer`'s existing return shape, no ABI change.
- A defence-in-depth log at the post-`previewMatch` site fires when the classifier surfaces `MatchError.SelfTrade` despite the pre-filter. The intended steady state has zero of these logs; a non-zero count means the local `getOffer` snapshot raced an in-flight ownership transfer or a future refactor dropped `creator` from `OfferLite`. Per-pair logs for other typed errors stay off (too noisy on a busy book); per-tick `submits` / `previewCalls` counters carry the rest of the observability story.

Companion change in the public reference `vaipakam-keeper-bot` repo (PR there) carries the same pre-filter + log alongside its own `MATCH_ERR_SELF_TRADE` constant. Both matchers share the structural shape of the inner loop, so the diff is symmetric.

Out of scope:

- Any contract-side change to the self-trade policy — the `_acceptOffer` gate and the `previewMatch` classifier are the authoritative pair, both shipped in #234.
- Off-chain analytics for multi-account self-dealing (a user with two wallets) — that's fundamentally out of reach for a contract-side gate and remains an off-chain Sybil-detection concern.

Closes #235.

## Thread — LayerZero → CCIP residual doc sweep (PR #__, Closes #236)

Completes the doc cleanup tail that #230 + #113 deferred. T-068 (PR
#46, merged 2026-05-18) migrated the cross-chain layer from LayerZero
to Chainlink CCIP, and #230 / #113 / #127 cleaned the load-bearing
TypeScript types + the SECURITY.md cross-chain rewrite. This PR
sweeps the remaining ~30 doc + i18n surfaces that still carried the
pre-T-068 LayerZero framing.

**Top-level docs** — `README.md` §0 stale-doc banner removed; §11
token-standard row rewritten to "Chainlink CCIP CCT" with the actual
TokenPool naming; §12.3-§12.4 cross-chain reward + UX paragraphs
rewritten to `VaipakamRewardMessenger` + the CCIP CCT bridge route;
§13 Cross-Chain Surface entirely rewritten — replaces the seven
`VPFIOFTAdapter` / `VPFIMirror` / `VPFIBuyAdapter` /
`VPFIBuyReceiver` / `VaipakamRewardOApp` subsections + the DVN
hardening + LZ pause-surface subsections with the post-T-068
architecture: `ICrossChainMessenger` + `CcipMessenger`, the
canonical `VPFIToken` + `LockReleaseTokenPool` + mirror
`VPFIMirrorToken` + `BurnMintTokenPool`, the `VpfiBuyAdapter` /
`VpfiBuyReceiver` flow, `VaipakamRewardMessenger`, the CCIP RMN +
`VpfiPoolRateGovernor` + `GuardianPausable` security model.

**Operator docs** — `contracts/RUNBOOK.md` rewritten across §1 env
vars, §2 deploy order (collapses to `DeployCrosschain.s.sol`), §4
peer wiring (now `ConfigureCcip.s.sol`), §5 (was DVN hardening — now
the RMN + per-lane rate-limit + GuardianPausable section), §9
monitoring (CCIP-aware checks), §10 incident runbook (CCIP contract
pause map), §11 go/no-go checklist. `docs/ops/DeploymentRunbook.md`,
`docs/ops/BNBTestnetDeploy.md`, and
`docs/DesignsAndPlans/OperatorNodeDeploymentDesign.md` get T-068
status banners with pointers at the CCIP-current scripts + ADR-0004;
their detailed bodies stay as historical reference pending the
structural CCIP rewrite of those long docs (tracked as a follow-up).
`docs/ops/GovernanceRunbook.md` + `docs/ops/AnalyticsLabelRegistration.md`
+ `docs/ops/AdminKeysAndPause.md` get surgical per-line updates
(contract-name substitutions + the pause-surface list rewritten).

**`ops/lz-watcher` README** — top-level deprecation banner notes the
Worker is deferred for decommission post-T-068 (its three checks
describe a LayerZero surface that no longer exists); points at
`contracts/RUNBOOK.md` §9 as the canonical post-T-068 monitoring
spec. The Worker stays deployed only as long as operators want to
keep its alerts live; the replacement CCIP-aware watcher is tracked
as a follow-up card.

**i18n micro-copy** — 20 locale JSON files (10 locales × 2 apps:
`apps/defi/src/i18n/locales/*.json` + `apps/www/src/i18n/locales/*.json`)
swept with conservative term substitutions: "LayerZero OFT" →
"Chainlink CCIP CCT", "via LayerZero" → "via Chainlink CCIP", "OFT
adapter" → "CCIP token pool", "VPFIBuyAdapter" / "VPFIBuyReceiver" →
post-T-068 casing (`VpfiBuyAdapter` / `VpfiBuyReceiver`). 126
substitutions total. The Japanese line at
`Overview.ja.md:278` needed a direct edit because Python's regex
word-boundary `\b` doesn't fire between Japanese letters and ASCII
letters (both are Unicode word characters). Native-speaker review
of the 9 non-en locales is the right backstop — pairs with
EC-004's "9 non-en locale translation" pass.

**Marketing copy + whitepaper** — `apps/www/src/content/whitepaper/Whitepaper.en.md`
§13 fully rewritten to mirror the README §13 rewrite. The 21 marketing
content files (whitepaper + overview + userguide + admin guide across
en + 9 non-en locales) all got the conservative substitution pass.
Native-speaker review still required on the non-en locales for
sentence-structure refinement — flagged for EC-004's translation pass
but the technical proper-noun terminology is now consistent across all
locales.

**Glossaries** — `apps/{defi,www}/src/i18n/glossary.ts`'s
`GLOSSARY_KEEP_VERBATIM` list extended with the post-T-068 contract
names (`CcipMessenger`, `VaipakamRewardMessenger`, `VpfiBuyAdapter`,
`VpfiBuyReceiver`, `VPFIMirrorToken`, `VpfiPoolRateGovernor`,
`LockReleaseTokenPool`, `BurnMintTokenPool`, `TokenAdminRegistry`,
`GuardianPausable`) + the CCIP-era short forms (`CCIP`, `RMN`,
`CCT`). The pre-T-068 LayerZero-era contract names (`VPFIOFTAdapter`,
`VPFIMirror`, `VPFIBuyAdapter`/`VPFIBuyReceiver`,
`VaipakamRewardOApp`) stay in the verbatim list — they still appear
in historical narrative (ADR-0004, the migration design doc, the
release notes from the migration period) and need to render
untranslated there.

**`CLAUDE.md`** — surgical fix on the "VPFIBuyAdapter — payment-token
mode by chain" section: section header updated to the post-T-068
casing (`VpfiBuyAdapter`); the references to
`DeployVPFIBuyAdapter.s.sol` and
`VPFIBuyAdapterPaymentTokenTest.t.sol` (neither file exists
post-T-068) point at `DeployCrosschain.s.sol` and
`contracts/test/VpfiBuyFlowTest.t.sol`.

**Intentionally NOT swept** — every doc that describes the
LayerZero → CCIP migration AS HISTORY: ADR-0004,
`docs/DesignsAndPlans/LayerZeroToChainlinkCcipMigration.md`, every
release-notes file from the migration period (2026-05-01 onward),
the `docs/OlderDocs/` archive, and the historical incident citations
in the references section of README and the whitepaper. The
migration story is load-bearing for understanding why the protocol
uses CCIP today, and the LayerZero references in those documents are
deliberate.

Closes #236 (the residual doc sweep tail of #230's deferred scope).
The structural rewrite of `docs/ops/DeploymentRunbook.md` and
`docs/DesignsAndPlans/OperatorNodeDeploymentDesign.md` from
LayerZero-shaped to CCIP-shaped — currently flagged with status
banners — is tracked as a follow-up card.

## Thread — Cooldown + GTT countdown UX on own-offers list (PR #__, Closes #241)

Two time-driven UI states that landed on the protocol contracts but had
no frontend surface get one in this thread:

1. **`MIN_OFFER_CANCEL_DELAY` (5-min cancel cooldown)** — when range-
   order matching is active (`partialFillEnabled=true`), the
   `cancelOffer` contract path refuses to cancel an unfilled offer
   inside the 5-min window from `createdAt` to defend against
   matcher-frontrun. Pre-#241 the website had no awareness of that
   bound — a user hitting Cancel in the cooldown got a generic
   `CancelCooldownActive` revert with no explanation. Now the Cancel
   button is disabled inside the window and a `<TimeChip>`
   "Cancellable in 4m 23s" countdown renders inline, ticking to the
   second over the last 2 min of the window. The button enables
   exactly when the contract would accept the call.

2. **GTT offer-expiry (#195's `expiresAt`)** — offers may carry an
   absolute deadline; before the deadline the offer is live, after
   the deadline anyone (not just the creator) can clean it up via
   the widened `cancelOffer` access gate. The new
   `<TimeChip kind="expiry">` renders "Expires in 3h 12m" while
   live and "Expired N min ago — anyone can clean up" once
   lapsed. The chip's tick cadence is adaptive (1 s under the last
   2 min, 30 s otherwise) so an idle Dashboard tab doesn't burn
   renders on hour-scale countdowns.

The two chips share one `<TimeChip>` component
(`apps/defi/src/components/TimeChip.tsx`); the cooldown and
expiry modes differ only in label and tone. The chip is "dumb /
pure" — it does not gate buttons, does not call contracts, does
not own retry logic; the surrounding row applies the same
`now >= targetSec` predicate to decide whether to disable the
Cancel button, keeping render and gating in lockstep without
prop-callback ping-pong.

**Wired surfaces (this PR)**:
- `apps/defi/src/components/app/MyOffersTable.tsx` — the user's
  own-offers card on `/app/dashboard`. New `partialFillEnabled`
  prop threaded from `useProtocolConfig` via the Dashboard caller.
  Cooldown gate disables the Cancel button + renders the
  countdown chip; the GTT chip shows in the Status cell.
- `apps/defi/src/pages/Dashboard.tsx` — caller wiring; reads
  `protocolCfg?.partialFillEnabled ?? false` and threads it to
  the table.
- `packages/lib/src/decodeContractError.ts` — friendly-error
  copy added for `NotCreatorOrNotExpired(address,uint64)`,
  `CancelCooldownActive()`, `OfferExpired(uint256,uint64)`,
  `OfferExpiryInPast()`, `OfferExpiryAboveCap(uint64,uint256)`,
  `SelfTradeForbidden(address)`, `AonRequiresFullFill(...)`,
  `AonRequiresSingleValueAmount()`, `IocRequiresExpiry()`,
  `ModifyBelowFilledFloor(uint256,uint256)`,
  `CollateralMutationUnsupportedForShape()`. Selectors verified
  via `cast sig` against the contract source. Means a user
  hitting any of these reverts now sees a one-sentence
  explanation in the toast instead of `Custom Error 0x…`.
- `apps/defi/src/pages/OfferBook.tsx` — `OfferData` type extended
  (optional fields) with `createdAt`, `amountFilled`, `expiresAt`,
  `fillMode` so the chips can render against rows from any data
  path (indexer + RPC + event-payload + localStorage stubs)
  without TypeScript drift.

**Deferred to a small follow-up**:
- The PUBLIC `<OfferTable>` row's read-only GTT chip + the
  "Clean up" permissionless-clear button on expired rows. The
  primary user value of #241 — "the Cancel button shouldn't
  silently fail" — lands in this PR via the own-offers surface;
  the public read-only mirror is additive and best paired with
  the wider OfferBook UX polish under `#166 sub 2`.

Closes #241 (the cooldown + countdown surface on the user's own
offers).

## Thread — Codex review trigger automation (PR #274, supersedes #273)

A new GitHub Actions workflow at `.github/workflows/codex-review-trigger.yml`
auto-detects `@codex review <mode> [profile]` triggers placed in a PR's
description (or any PR-thread comment) and forwards them as a normalized
comment so Codex's comment-driven automation actually fires. The motivation
is simple: Codex listens to PR comments, not PR descriptions, and the
existing convention was for the PR author to remember to drop the trigger
comment by hand on every PR open and every fix-cycle. The workflow removes
that toil while preserving the per-cycle re-trigger semantics: dedupe is
keyed on the normalized trigger string plus the PR's current head commit
SHA, so the same trigger re-fires exactly once per new commit but never
duplicates on a same-commit event (e.g. an `edited` event that didn't
change the trigger text, or a re-delivery of the same webhook).

Three safety properties are baked in.

**Cost-DoS gating** — the workflow is a public-repo trigger for a paid
service (Codex review), so it gates on `author_association` in
`{OWNER, COLLABORATOR, MEMBER}` before parsing the trigger. Random
commenters on the public repo cannot burn paid review compute by typing
the magic words; only the repo owner, anyone added as a collaborator, and
(in the future, if the repo is ever moved into an org) org members can
fire it. The check runs after the bot-actor filter and before the trigger
regex, so it's the cheapest gate on the hot path.

**Race protection** — a job-level concurrency group keyed on the PR
number serializes parallel events. GitHub does occasionally double-deliver
`edited` events, and a user-typed comment can collide with a near-
simultaneous PR-description edit. Without serialization the dedupe check
(list-comments then create-comment) was TOCTOU and could produce two
identical forwarded triggers on the same head SHA, doubling Codex's
review cost for nothing. `cancel-in-progress: false` is deliberate — we
want to serialize, not cancel, so each event observes the previous run's
posted comment when checking the marker.

**Bot-loop guard** — actors ending in `[bot]` or containing `codex` are
skipped, so neither GitHub Actions itself nor Codex's own follow-up
comments can re-trigger the workflow. Combined with the forwarded
comment's HTML-comment marker (`<!-- codex-review-trigger:… -->`), the
loop is closed on both ends.

The supported modes match `AGENTS.md` §`@codex review …` exactly:
`normal`, `adversarial`, `full`, and `full security-critical`. The
optional profile suffix (e.g. `@codex review normal handbook`) is
captured and propagated unchanged, so the project-specific review
profiles documented alongside the canonical modes continue to work.

PR #273 was the initial attempt to ship this — identical workflow file,
authored via Claude's GitHub App. That PR was held up by branch
protection's `required_signatures` rule because Claude's GitHub App
authors via the GitHub Contents API and never signs commits. #274 is the
signed re-submission, cherry-picked locally so each commit carries the
maintainer's SSH signature and verifies green against the SSH signing
key registered on the maintainer's GitHub account. The unsigned-commit
failure mode is now a known pattern: PRs originated by Claude's chat-
based GitHub App will always need a signed re-submission before they can
merge to `main`; the cherry-pick-from-local recipe is the standard
workaround.

Supersedes #273.

## Thread — Off-chain data resilience: Stage A (B2 backup) + design doc (PR #?)

Closes the lockout-survival gap that issue #30 (T-077) opened. The
protocol has always been single-cloud on the off-chain side: every
indexed offer / loan row, every legal-hold audit entry, every legal
document uploaded by an operator lives only in Cloudflare's D1 + R2.
A Cloudflare account loss — billing dispute, credential
compromise, accidental delete — would lose all of it. On-chain state
is unaffected (the Diamond + VPFI live on the chain itself) but the
off-chain layer is what makes the protocol *usable*: the offer-book,
the diagnostic stream, the legal-hold register.

This PR ships **Stage A** of the resilience plan: a new
`ops/offchain-data-archive` Cloudflare Worker that nightly exports the two
production D1 databases (`vaipakam-archive` + `vaipakam-lz-alerts-db`)
and mirrors the R2 `vaipakam-legal-vault` bucket to a **Backblaze B2**
bucket on a separate billing + credential boundary. Every archive is
client-side encrypted with AES-256-GCM using a key kept OFFLINE
outside Cloudflare. A second weekly cron probes the most recent
archive — confirming it exists, decrypts cleanly, and its SHA-256
matches the manifest — and pages the operator on any drift. The
restore procedure (stand-up of a fresh Cloudflare account, archive
decryption, table-by-table reload, indexer re-bootstrap from block 0)
is documented end-to-end in `docs/ops/OffChainRestore.md`.

The PR also lands the umbrella design doc
`docs/DesignsAndPlans/OffChainDataResilience.md`. The doc covers
Stage A and forward-references **Stage C** — a 2-required + 1-optional
multi-cloud indexer quorum across Cloudflare + Fly.io + Hetzner
(or equivalent), with a thin aggregator that takes the majority on
every offer-book read and treats divergence as a security alarm —
plus cold-standby for the keeper / agent / lz-watcher Workers. The
quorum work is sized for the audit-to-mainnet window and tracked as
a separate Project card; Stage A is intentionally the floor that
ships immediately so the worst case (CF lockout = total off-chain
loss) is no longer realistic.

The Worker itself is npm-based (outside the pnpm workspace, matching
the `ops/lz-watcher` precedent) and has the standard
`build`/`typecheck`/`deploy` script set so Cloudflare Workers Builds
runs the type-check as a pre-deploy gate.

## Forge-lint cleanup — Group A.4 + setRewardOApp→setRewardMessenger rename (Issue #89)

Closes Group A.4 of the forge-lint cleanup tracked in Issue #89, plus
finishes the partial T-068 LayerZero→CCIP rename of the cross-chain
reward messenger function.

### Part 1 — 92 `mixed-case-function` suppressions (convention preserves)

Every external/public function whose name carries a project-domain
acronym (VPFI, NFT, KYC, ETH, USDC, DIA, LTV, TVL, APR, URI), an
ERC-standard suffix (ERC20, ERC721, ERC1155, ERC4907), an OpenZeppelin
AccessControl convention (already covered by PR #269's 7 role
getters), or an upstream interface spec (Aave V3
`FLASHLOAN_PREMIUM_TOTAL`, project `IVPFIToken` `TOTAL_SUPPLY_CAP` /
`INITIAL_MINT`) gets a one-line
`// forge-lint: disable-next-line(mixed-case-function)` directly above
the declaration. 92 inline suppressions across 17 files — same shape as
PR #269 but at the wider scope.

Renaming any of these would have changed a 4-byte function selector
on a deployed contract — the keeper-bot, the frontend ABI bundle, and
the Tenderly snapshot all consume those names directly. Suppression
preserves the public ABI and documents the conscious decision at every
call site.

Files touched (suppressions only):

- `VaipakamVaultImplementation.sol` — 10 ERC20/ERC721/ERC1155 vault wrappers
- `VaultFactoryFacet.sol` — 15 `vault{Deposit,Withdraw,Approve,Set,Get}{ERC20,ERC721,ERC1155,NFT*}` wrappers
- `VPFIDiscountFacet.sol` — 16 VPFI buy/discount/staking helpers
- `VPFITokenFacet.sol` — 9 VPFI getters / setters
- `VaipakamNFTFacet.sol` — 9 NFT mutators + tokenURI / contractURI / setImageURIForStatus
- `ProfileFacet.sol` — 7 KYC family
- `MetricsFacet.sol` — 5 NFT / TVL getters
- `VpfiBuyAdapter.sol` / `VpfiBuyReceiver.sol` — 4 each (recover stuck, rescue ETH/ERC20)
- `StakingRewardsFacet.sol` — 3 VPFI-staking + APR getters
- `AdminFacet.sol` — 2 KYC enforcement gate
- `OracleAdminFacet.sol` — 2 DIA oracle setters
- `TreasuryFacet.sol` / `OracleFacet.sol` / `RiskFacet.sol` — 1 each (mintVPFI / calculateLTV ×2)
- `IAaveV3Pool.sol` / `IVPFIToken.sol` — 1 / 2 interface getters

### Part 2 — `setRewardOApp` → `setRewardMessenger` (T-068 finish line)

T-068 migrated the cross-chain reward flow from LayerZero (where the
external counterparty was an "OApp" = Omnichain Application) to
Chainlink CCIP (where it's a "Messenger"). The artifact-side rename was
already done — `Deployments.sol`'s `readRewardMessenger()` /
`writeRewardMessenger()` and the deploy shell scripts' "legacy
`.rewardOApp` artifact key" fallbacks have been in place for weeks —
but the contract-side function still carried the LayerZero-era name.
This PR finishes the partial migration:

- **Function rename:** `RewardReporterFacet.setRewardOApp` →
  `setRewardMessenger`. Public ABI break (4-byte selector change);
  consumer-side ABIs regenerate in this PR.
- **Error renames:**
  `RewardOAppNotSet` → `RewardMessengerNotSet`,
  `NotAuthorizedRewardOApp` → `NotAuthorizedRewardMessenger`. Each
  changes the error selector — ABI break, frontend / indexer / agent
  pick it up via ABI regen.
- **Storage field rename:** `LibVaipakam.Storage.rewardOApp` →
  `rewardMessenger`. Solidity storage layout is determined by field
  **order + type**, not name — so this is layout-preserving (same
  offset, same 32-byte slot). The pre-PR comment claiming
  "storage-layout stability" as the reason the field couldn't be
  renamed was a misconception; the real reason was the ABI break, which
  this PR pays in one bundle.
- **Event topic-key rename:** `bytes32("rewardOApp")` →
  `bytes32("rewardMessenger")` in `RewardReporterConfigUpdated`'s
  `key` field. The event topic hash is unchanged (computed from
  signature, not field-key strings). No consumer code decodes the
  string literal — verified via grep of `apps/`.
- **Event parameter name:** `ChainInterestReported.viaOApp` →
  `viaMessenger`. The event topic hash is unchanged (computed from
  types, not parameter names). The ABI's parameter-name field changes,
  which downstream decoders display.
- **Companion-facet alignment:** `RewardAggregatorFacet` also reads
  `s.rewardOApp` / declares an `onlyRewardOApp` modifier; renamed in
  lockstep.
- **`IVaipakamErrors.sol`** — canonical error declarations renamed in
  lockstep.
- **Consumer-side test + script files:**
  - `CrossChainRewardPlumbingTest.t.sol` — 8 test function names
    (`testCloseDayMirrorForwardsToOApp` → `…Messenger`, etc.) plus 90+
    local-variable renames (`oApp` → `messenger`).
  - `HelperTest.sol` — selector reference at L1035.
  - `DeployDiamond.s.sol` — `console.log` text + selector reference at
    L1209.
  - `ConfigureRewardReporter.s.sol` — local var + comment + the call
    site at L90.
  - `pause-all-chains.sh` — JSON key in the read loop at L126.
  - `deploy-testnet.sh` / `deploy-mainnet.sh` — comment polish on the
    "legacy `.rewardOApp` artifact key" fallback (the fallback itself
    is preserved for backward-compat reading of historical addresses
    files).
  - `MockRewardMessenger.sol` — comment alignment.

What stays as "OApp" (intentional historical context):
- `IRewardMessenger.sol` — explicit "this interface used to be named
  `IRewardOApp`" historical paragraph.
- `VaipakamRewardMessenger.sol` — "CCIP successor to the LayerZero
  `VaipakamRewardOApp`" preamble.
- `LibVaipakam.sol` — the storage-field comment now records the
  historical name + the corrected layout-stability reasoning.
- `GovernanceHandover.t.sol` — test names like
  `_runMigrateOAppGovernance` / `test_OApp_OwnerIsTimelock` refer to
  the broader governance handover applied to multiple OApp contracts
  historically; out of scope for this PR's setter rename.

### ABI regen needed on merge

```
bash contracts/script/exportFrontendAbis.sh
pnpm --filter @vaipakam/{defi,keeper,indexer,agent} exec tsc -b --noEmit
```

Picks up the renamed `setRewardMessenger` selector + the two renamed
error entries across `RewardReporterFacet.json`,
`RewardAggregatorFacet.json`, and the shared `IVaipakamErrors.json`
surface. No consumer code in `apps/` references the old names by
string — verified via grep.

### Lessons banked

- The "storage-layout stability" justification for refusing to rename a
  Solidity struct field is technically incorrect — layout depends on
  order + type, not name. The real cost of a field rename is the ABI
  break on selectors derived from the field's getters and the
  declared errors that mention it, both of which are bookkeepable.
- The `Edit.replace_all` lesson from PR #271 (literal-substring, not
  word-boundary) carried over: this rename used a careful
  longest-first replacement list (e.g. `setRewardOApp` →
  `setRewardMessenger` comes before `oApp` → `messenger` so the
  function name isn't garbled mid-pass).
- `OApp` as a comment-level word recurred in surprising places — the
  cleanup needed to look at companion facets (`RewardAggregatorFacet`),
  the canonical error interface (`IVaipakamErrors`), the storage
  library, and the test mock alongside the obvious facet. The grep
  sweep at the end caught residue in `MockRewardMessenger`'s comments
  that the initial rename plan missed.

Closes Group A.4 of #89. The #89 umbrella stays open until Batch 6
(`unwrapped-modifier-logic` + `unsafe-cheatcode`) lands; the
mixed-case-function / mixed-case-variable / SafeCast / immutable
categories that defined Group A are now complete.

## Forge-lint cleanup — bundle: A.1 + A.2 + SafeCast.toInt256 (Issue #89)

Three logically related forge-lint follow-ups that all need the same
ABI-regen pass land together to minimise the operator's `exportFrontendAbis.sh`
round trips. PR #267 (Batch 5.4) shipped 53 `unsafe-typecast` SafeCast wraps
for `uint256` downcasts; this bundle finishes the typecast sweep with the
remaining nine signed-int sites, and folds in the two ABI-break selector
renames that Batch 2 / Batch 3 deferred precisely because they needed a
deliberate ABI regen.

**Part 1 — SafeCast.toInt256 (9 sites, `unsafe-typecast`).** The
`SafeCast.toInt256(uint256)` wrap protects `int256(uint256)` casts from
silent two's-complement overflow when the input ≥ 2^255. Eight sites in
`LibInteractionRewards` (the `perDay` / `perDayNumeraire18` flow rate
encoding) and one in `OracleFacet._captureDailyPriceSnapshotInner` (the
daily Chainlink price snapshot) get the wrap. Per-site rationale: each
input is bounds-checked upstream (`perDay` ≤ supply, Chainlink price
non-negative per `_primaryPrice`'s guards), but explicit revert beats
silent overflow into a negative int256.

**Part 2 — A.1 FlashLoanLiquidator immutable rename
(`screaming-snake-case-immutable`, 4 immutables).** `owner`, `diamond`,
`aaveV3Pool`, `balancerV2Vault` rename to `OWNER`, `DIAMOND`,
`AAVE_V3_POOL`, `BALANCER_V2_VAULT`. These are immutables, so the
Solidity style guide wants SCREAMING_SNAKE_CASE; Batch 2 deferred them
because the auto-generated getters are part of the public ABI consumed
by the keeper-bot and the rollout doc. The bundle updates
`FlashLoanLiquidatorTest.t.sol`'s four getter call sites and
`docs/ops/FlashLoanLiquidatorRollout.md`'s four `cast call` verification
commands in lockstep. Constructor parameter names + their NatSpec
`@param` docs stay lowerCamelCase — those are function locals, not
state vars, and `mixed-case-variable` is the applicable rule there
(satisfied). Revert string literals (`"owner"`, `"diamond"`) preserved
verbatim — the string-literal-aware tokenizer pattern from Batch 3
caught those.

**Part 3 — A.2 cross-chain VPFI 3 identifiers
(`mixed-case-variable` / `mixed-case-function`).** `stuckVPFIByRequest`
and `totalStuckVPFI` (public state vars on both `VpfiBuyAdapter` and
`VpfiBuyReceiver`) rename to `stuckVpfiByRequest` / `totalStuckVpfi`;
`isCanonicalVPFIChain` (the storage struct field in `LibVaipakam` plus
the external getter on `VPFITokenFacet`) renames to
`isCanonicalVpfiChain`. The lowercase `vpfi` inside the camelCase
identifier matches the convention already used everywhere else in the
repo (`vpfiBuyReceiver`, `vpfiMirror`, `vpfiOftAdapter` in the
deployments JSON, `vpfiHeld` in the borrower LIF settlement). 46 source
sites across `crosschain/`, `facets/`, `libraries/`, the test suite,
`DeployDiamond.s.sol`'s selector table, `HelperTest.sol`'s selector
table, the contracts `README.md` and `RUNBOOK.md` move in lockstep. No
consumer code in `apps/` or `packages/` references these by name (the
only consumer-side touch is the ABI JSON regen).

**ABI regen needed on merge:** `bash contracts/script/exportFrontendAbis.sh`
will pick up the new selectors on `FlashLoanLiquidator` (4 immutable
getters), `VpfiBuyAdapter` + `VpfiBuyReceiver` (`stuckVpfiByRequest`,
`totalStuckVpfi`), and `VPFITokenFacet` (`isCanonicalVpfiChain`). One
regen pass covers all three parts.

### Lessons banked

1. `Edit` tool's `replace_all` is literal-substring, not word-boundary —
   `aaveV3Pool` → `AAVE_V3_POOL` over-matched into the constructor
   parameter `_aaveV3Pool` and its NatSpec `@param` doc, producing
   `_AAVE_V3_POOL` (non-idiomatic). Revert the constructor params
   manually after a `replace_all` on identifiers that appear as
   substrings of other identifiers — or use the Python tokenizer.

2. The lint's "VPFI" recommendation could be read as either `Vpfi` or
   `_vpfi_` (pure separator) — the project convention (`vpfi` lowercase
   inside camelCase, established across the deployments JSON and the
   contract filenames `VpfiBuyAdapter` / `VpfiBuyReceiver`) is the
   load-bearing reference; pick from prior art, don't invent.

Closes the bundle slice of #89; leaves Group A.4 (~75 NFT / KYC /
acronym external functions) for a dedicated follow-up PR.

## Forge-lint cleanup — Batches 1-4 (Issue #89, PRs #255 / #257 / #258 / #259)

CI's `forge build` output had been carrying 628 `forge-lint` warnings —
unused imports, mixed-case identifiers, screaming-snake-case immutables
that should have been lowerCamel, and a handful of unsafe-typecast +
modifier-shape findings. The volume itself was the problem: every new
PR added more warnings, and a real regression in warning *shape*
(e.g., a new `erc20-unchecked-transfer` after a refactor) was easy to
miss in the noise. This release ships four mechanical batches that
clear ~430 of the 628 (about two-thirds), without touching the deferred
ABI surface that needs a deliberate selector-break PR to migrate.

**Batch 1 — unused-import (93 warnings).** A driver script parsed the
build output, located each `note[unused-import]` block, and rewrote
the import lines surgically: single-symbol imports were dropped
entirely, multi-symbol imports had the offending name removed from the
brace list. No identifier renames, no behaviour change — pure dead-code
removal. Merged as PR #255.

**Batch 2 — screaming-snake-case immutable/const (10 of 15 warnings).**
The Solidity style guide wants immutables and constants in
SCREAMING_SNAKE_CASE; a small inventory of project test fixtures, scripts,
and adapter immutables were still lowerCamel. The script renamed 14
symbols across 11 files. Codex's review caught two real regressions
the script was blind to: the rename mechanism (a word-boundary regex)
silently mangled identifier-shaped substrings *inside* string literals
— the import path `"@diamond-3/..."` flipped to `"@DIAMOND-3/..."`
and broke remappings, and the CCIP channel-ID constant
`"vaipakam.ccip.channel.vpfi-buy"` flipped to `VPFI-buy` and started
hashing a different namespace from the production sources. The full
FlashLoanLiquidator immutable rename also got reverted because its
`owner()` / `diamond()` getters are part of the public ABI consumed by
the keeper-bot and documented in the rollout doc, so renaming the
storage field renames the auto-generated getter — a selector change
masquerading as a style fix. Net delivered: 10 SCREAMING_SNAKE_CASE
renames; 9 deferred. Merged as PR #257.

**Batch 3 — mixed-case-variable (184 of 194 warnings).** Function
locals, parameters, and event-arg names that ended in three-letter
acronyms (`newHF`, `collateralUSD`, `simulatedLTV`) standardised to
lowerCamel. Hardened the script with three lessons from Batch 2: a
proper Solidity-aware tokenizer that tracks four states (code, string,
line-comment, block-comment) so identifiers inside string literals
are protected, an explicit skip for declarations on `public`/`external`
state variables to preserve auto-generated getter selectors, and a
global-codebase walk per accepted symbol so call sites in inheritor
files (e.g., `MetricsFacetTest` referencing `SetupTest`'s `mockNFT721`)
get renamed in lockstep with the parent declaration. Six ABI JSONs +
four frontend TypeScript files were updated alongside the contract
source so the ABI shape compare in CI stayed clean in one shot.
Codex's review cycle still found three more issues: a `_gap` rename
that broke the OpenZeppelin upgradeable storage-gap convention, the
`isCanonicalVPFIChain()` external function inheriting its selector
from a same-named internal state-var (Batch-2 class bug recurring on
an external getter the SKIP-public-state-vars classifier didn't cover),
and two cases of the lint's `Xys`-as-`XyS` heuristic producing
awkward identifiers (`totalNfTsInVault`, `statusImageUrIs`) — overridden
to the standard transform. Final cycle: 4 Codex passes, 2 reverts,
clean signoff. Merged as PR #258.

**Batch 4 — mixed-case-function (85 of 165 warnings).** Internal /
private function renames only. The script now joins multi-line
function signatures up to the next `{` or `;` and skips any signature
containing `external` or `public`; every renamed external/public fn
would change a 4-byte selector and that's a deliberate ABI-break,
not a mechanical batch. 80 external functions deferred — the
OpenZeppelin AccessControl convention role getters
(`DEFAULT_ADMIN_ROLE`, `ADMIN_ROLE`, etc.), `NFT`-suffix mutators
(`initializeNFT`, `mintNFT`, `burnNFT`), `KYC`-suffix gates
(`setKYCEnforcement`), and acronym-suffix admin setters (`fundETH`,
`setDIAOracleV2`, `setVPFIToken`). Two further lessons banked through
Codex's review: a per-file classifier dedup conflicts with a
whole-codebase rename walk when the same identifier has different
visibilities in different files (the `setDIAOracleV2` collision), and
the `/lib/` path filter over-excludes project-local
`script/lib/Deployments.sol` even though it's first-party code. Merging
as PR #259.

### Deferred to follow-up PRs

About 99 symbols across the four batches stayed un-renamed and need
deliberate follow-up PRs:

- **ABI-break PRs (Group A):** every public state-var auto-getter and
  every public/external function on a deployed contract whose selector
  is consumed by the keeper-bot, the frontend ABI bundle, or the
  Tenderly Diamond snapshot. Migration requires the rollout doc, the
  consumer ABIs, and the test fixtures to move in lockstep — same
  shape as the per-facet ABI sync that already runs after every
  contract change. Candidates include FlashLoanLiquidator's 4 immutable
  getters (Batch 2), the two `VpfiBuy*` cross-chain pub state vars
  (Batch 3), `isCanonicalVPFIChain()` (Batch 3), and the ~80
  external/public function names deferred in Batch 4.

- **Ecosystem / convention preserves (Group B):** four struct names
  whose ERC + NFT acronym blocks match OpenZeppelin / prevailing
  Solidity style (`NFTPositionSummary`, `ERC721Storage`, `ERC20Settlement`,
  `_TierCtx`), the `decimals` interface override in
  `MockSequencerUptimeFeed`, and the `__gap` declarations across the 7
  upgradeable contracts. These will likely land as targeted lint
  suppressions rather than renames — the convention is the
  load-bearing thing.

- **Test-base inherited state-vars (Group C):** `mockUSDC` and
  `mockWETH` declared in `InvariantBase` and read by 5 inheritor
  invariant suites via `base.mockUSDC()`. Bundled separately so the
  inheritor sweep + the base move in one focused PR.

### Lessons banked for the next mechanical refactor

Six classes of bug Codex caught that the lint warnings themselves
didn't surface, all now documented in the per-batch PR bodies for the
next person doing mechanical renames:

1. Word-boundary regex matches identifier-shaped substrings *inside*
   string literals.
2. Solidity has no single-quote string — apostrophes in comments must
   not flip the tokenizer's string mode.
3. The `mixed-case-variable` lint fires on declarations, not usages —
   inheritor files referencing inherited identifiers are missed unless
   the script walks the whole codebase.
4. Manual `external` function declarations sharing an identifier with
   an internal state-var are *also* ABI-bound; the skip-public-state-vars
   classifier needs to extend.
5. OZ `__gap` and AccessControl role-getter conventions take
   precedence over the lint's name suggestions.
6. The `Xys` plural-acronym lint heuristic produces unusable names
   (`totalNfTsInVault`, `statusImageUrIs`); always preview and
   override.

### Cumulative warning state on Issue #89

About 430 of 628 lint warnings cleared (~68%) across the four batches.
The remaining ~200 are split between the deferred groups above
(Group A is the big bucket — ~95 public/external selector renames) and
the categories not yet touched: `unsafe-typecast` (~136 warnings,
Batch 5), `unwrapped-modifier-logic` (11) and `unsafe-cheatcode` (9,
both Batch 6). Each remaining batch is mechanically smaller than
Batches 3-4 but needs the same per-batch Codex round-trip discipline.

Closes the Batches 1-4 work on #89; the umbrella stays open until
Batches 5-6 + the Group A/B/C follow-ups land.
