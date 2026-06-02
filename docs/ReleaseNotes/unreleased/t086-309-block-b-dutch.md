## T-086 #309 Block B — Dutch decay for prepay listings

Adds Dutch-decay posting + update entry points to the prepay-collateral
listing flow so borrowers of unique / illiquid NFTs can let the price
discover itself over the auction window instead of guessing a fixed
ask. Closes Issue #309's "Mode A — Dutch decay on Seaport (on-chain
only)" leg.

The Dutch path coexists with the Round-4 fixed-price flow and the
Block A fee-leg surface — borrowers pick per listing; the modes don't
gate each other.

### What this PR ships

**Contract surface — split-facet shape** —
`NFTPrepayDutchListingFacet` (new sibling facet) hosts the two Dutch
entry points `postPrepayDutchListing` and `updatePrepayDutchListing`.
The split out of `NFTPrepayListingFacet` is bytecode-budget driven:
combining all five entry points (fixed-price post / update +
Dutch post / update + cancel + helpers) in one facet tripped solc's
"Tag too large for reserved space" internal compiler error. The
sibling facet shares the same `LibVaipakam` storage and the same
`IListingExecutorRecorder` interface to the singleton executor, so
the two facets are coherent on the wire.

**Multi-mode recorder interface** —
`IListingExecutorRecorder.recordOrder` grew three trailing parameters
(`endAskPrice`, `auctionEndTime`, `mode`). For fixed-price posts the
facet stamps `endAskPrice == askPrice`, `auctionEndTime == 0`, and
`mode == PREPAY_MODE_FIXED_PRICE (0)`; for Dutch posts it passes the
real Dutch values + `mode == PREPAY_MODE_DUTCH (1)`. The executor's
`OrderContext` gained one packed slot
(`uint128 endAskPrice | uint64 auctionEndTime | uint8 mode | pad`) so
cancel-time canonical-shape reconstruction can dispatch on the mode
tag.

**Cancel-time dispatch** —
`CollateralListingExecutor._tryCancelOnSeaport` now branches on the
recorded `mode`. The fixed-price branch is the historic
`pctx@startTime` reconstruction (Round-4 shape). The Dutch branch
reads pctx at `auctionEndTime` so projected lender + treasury legs
replay the values the facet signed against — under sign-time
governance config; if governance has drifted the recompute mismatches
and the executor emits the existing `SeaportCancelSkipped` breadcrumb
(the proper cleanup still completes — only the OpenSea catalog-refresh
acceleration is lost, matching the Block A precedent).

**Borrower-facing sign-time validation** —
new errors `AuctionWindowTooShort`, `AuctionExceedsGrace`,
`AskNotMonotonic`, `FeeLegNotMonotonic`, `BorrowerLegNotMonotonic`,
`DutchStartAskBelowProjectedFloorPlusFees`,
`DutchEndAskBelowProjectedFloorPlusFees`. The
`MIN_AUCTION_WINDOW = 1 hour` floor protects against locking the
NFT into an instantly-expired auction; `auctionEndTime ≤ gracePeriodEnd`
keeps the Seaport boundary inside the protocol boundary. The
**derived borrower-leg monotonicity** check catches the
parameterization where fee legs decay FASTER than the total ask
(`borrowerLeg.startAmount` would invert) — Seaport would reject at
fill time with a per-item interpolation error, so the facet
catches it with a clean revert at post time instead.

**Shared event shape** —
`PrepayListingPosted` and `PrepayListingUpdated` extended with
trailing `endAskPrice` / `auctionEndTime` / `mode` fields. Same
topic hash regardless of mode; the indexer's event-coverage
allowlist stays tight (one handler per shape, not two).

**`@vaipakam/lib/prepayOrderShape` Dutch extension** —
`PrepayOrderInput.dutch?` optional object carrying
`(startAskPrice, endAskPrice, projectedLenderLeg, projectedTreasuryLeg,
auctionEndTime)`. When set, `buildPrepayOrderComponents` uses the
Dutch values for borrower-leg decay + the projected protocol legs
+ Seaport `endTime = auctionEndTime`. When unset, the builder
emits the Round-4 + Block A fixed-price shape verbatim. Exported
mode constants `PREPAY_MODE_FIXED_PRICE` / `PREPAY_MODE_DUTCH`.

**Indexer + D1 + autonomous-publish** —
- Migration `0018_prepay_listings_dutch.sql` adds three columns:
  `end_ask_price TEXT`, `auction_end_time INTEGER`, `auction_mode INTEGER`.
- The `PrepayListingPosted` and `PrepayListingUpdated` handlers decode
  the new event fields and persist them on INSERT / UPDATE.
- `indexerPublishPrepayListing` accepts an optional `dutch` object;
  when set, pctx is read at `auctionEndTime` and the JS reconstruction
  uses the Dutch shape (matching the on-chain orderHash). When unset,
  the helper emits the fixed-price shape unchanged.
- The cron retry sweep reads the new columns back and rebuilds the
  Dutch input from D1 for autonomous republish.

**Dapp** —
`useNFTPrepayListing` hook grew `postPrepayDutchListing` /
`updatePrepayDutchListing` entry callbacks. v1 of the dapp does NOT
include the frontend-direct OpenSea publish for the Dutch path —
the indexer's autonomous handler covers it uniformly across both
modes using the event's Dutch fields. The borrower-facing Dutch
posting UI (decayed-price ticker + parameter form) is the dapp
deferred follow-up; the contract + indexer surface ships first.

**Deploy + multicall harness reuse** —
DeployDiamond's facets array bumped to 40 + a separate
`_getNFTPrepayDutchListingSelectors` cut. The Block A multicall
deploy harness (`multicallDeploy.s.sol`, `BatchCaller`,
`EncodeMultiSend`, `DeployGnosisSafe`) is unchanged — the same
atomic UUPS upgrade + diamondCut pattern works for Block B's
recorder-interface bump. The platform is pre-live so the
multicall harness is forward-looking scaffolding for the
eventual mainnet, not a load-bearing per-PR gate.

### What's NOT in this PR (intentional)

- **Dutch posting UI on the dapp** — hook entries are exposed; the
  decayed-price ticker + parameter form are the deferred follow-up
  (matches Block A's "fee picker is deferred" pattern).
- **Mode B — English via OpenSea Offers (Block C)** — Issue #309's
  pragmatic English path is dapp-only and lands as a separate PR.
  Block A's "fee-free collection" track for C can run in parallel.
- **Vickrey / sealed-bid auctions** — out of scope per design doc §15;
  incompatible with OpenSea's offer-book UI.
- **Frontend-direct OpenSea publish for Dutch** — the indexer's
  autonomous publish path handles both modes uniformly. Frontend-
  direct is a UX-latency optimization; we'll add it once the
  borrower UI lands.

### Operator action post-merge

This PR is atomic for the codebase — every layer ships together.
For the eventual on-chain rollout (post-mainnet-cutover):

1. Deploy the new `CollateralListingExecutor` implementation
   (the multi-mode `recordOrder` signature is ABI-breaking vs Block A's).
2. Deploy the new `NFTPrepayDutchListingFacet`.
3. Build the multisend payload via `multicallDeploy.buildPayload(...)`
   — one `upgradeToAndCall` for the executor + one `diamondCut`
   adding the Dutch facet selectors.
4. Send the multisend through the Safe (1 transaction, atomic).
5. Apply the D1 migration:
   `cd apps/indexer && wrangler d1 migrations apply vaipakam-archive --remote`

The platform is pre-live so there's no production rotation outage
risk — the multicall harness is scaffolded for the eventual mainnet
cutover. See [[project_platform_prelive]] in memory for the
broader framing.

### Verification

- Forge regression (cifast scope): **121 / 121 PASS** locally.
- New facet test coverage: 7 Dutch integration tests on
  `NFTPrepayListingFacetTest` (happy post + window-too-short +
  grace-exceed + ask-not-monotonic + end-ask-below-floor +
  borrower-leg-not-monotonic + happy update). Combined facet suite
  now 46 / 46 PASS.
- Executor unit suite: 36 / 36 PASS.
- Deploy-sanity suite (facet count, selector coverage, no
  collisions, facet sizes): 12 / 12 PASS.
- Indexer event-coverage: 41 enforced state-change events, 26
  handled, 15 allowlisted — no drift.
- Workspace typecheck: `defi` / `agent` / `indexer` / `keeper` —
  all four green.

### Closes

Issue #309 (Mode A — Dutch decay) part 1. Block C (English via
OpenSea Offers) is the remaining slice.

### Related

- Round 5 design + Round 5.1 errata: #322 + #323
- Block A (fee-legs atomic): #324
- **Block B (this PR): Dutch decay** — closes #309 Mode A
- Block C (English via OpenSea Offers): #309 Mode B
- Multi-marketplace fan-out: #281
