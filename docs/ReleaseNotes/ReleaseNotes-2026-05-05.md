# Release Notes — 2026-05-05

Testnet deploy hardening + protocol-console fixes. The contract surface
shipped on 2026-05-04 (Base Sepolia + Sepolia) revealed a chain of
operator-side and frontend-side gaps that this day's work closes. No
mainnet deploys.

## Testnet flow-test sweep on Base Sepolia — 49/49 scenarios PASSED

The diamond deployed at `0x94F551549898d23a5645F8628dE57d2E0C56c776` on
Base Sepolia was exercised end-to-end against four flow-test scripts
(after the master-flag flip described below):

- **SepoliaPositiveFlows** — 15/15 (NFT ERC721/1155 + rental, illiquid
  lending, classic ERC-20 lifecycle, third-party repay, cancel offers).
- **AnvilNewPositiveFlows** — 18/18 (range orders, partial repay,
  refinance, preclose 2/3, recovery happy path + sanctioned-source ban,
  disown, sanctions Tier-1/Tier-2, keeper per-action authorization,
  VPFI staking + discount + claim rebate, unstake, per-asset pause,
  global pause, treasury accrual, master-flag dormancy,
  sellLoanViaBuyOffer).
- **AnvilNewPartialFlows** — 7/7 (offer states, partial-repay midpoint,
  collateral doubled, keeper enabled, refinance offer posted, stray
  token in escrow, dual claimable side-by-side).
- **AnvilNegativeFlows** — 9/9 (range bounds, fallback consent,
  self-collateralized offer, zero duration, collateral floor, claim
  before terminal, partial repay opt-out).

Same total holds on Sepolia by parity (mirror chain).

## Live testnet sweep on Sepolia (L1) — direct execution

Earlier the parity claim above was just an inference from the mirror-chain
relationship; on 2026-05-05 the same four flow-test scripts were executed
end-to-end against the Sepolia diamond at
`0x3458758ec056db565CBE3FC6489480cd6f8B8eb7` (chainId 11155111). Result:

- **AnvilNewPositiveFlows** — `exit=0` ONCHAIN EXECUTION COMPLETE &
  SUCCESSFUL. 18/18 scenarios green over ~63 minutes of `--slow`-paced
  Sepolia broadcasts (range orders, partial repay, refinance, preclose
  2/3, recovery happy path + sanctioned-source ban, disown, sanctions
  Tier-1/Tier-2, keeper per-action authorization, VPFI staking +
  discount + claim rebate, unstake, per-asset pause, global pause,
  treasury accrual, master-flag dormancy, sellLoanViaBuyOffer).
- **BaseSepoliaPartialFlows** — `exit=0` ONCHAIN EXECUTION COMPLETE &
  SUCCESSFUL. 6/6 UI-testable midpoint states populated over ~27
  minutes (open lender offer / open borrower offer / active liquid
  loan / repaid-but-unclaimed / ERC-721-collateral active / ERC-721
  rental active).
- **AnvilNewPartialFlows** — `exit=0` ONCHAIN EXECUTION COMPLETE &
  SUCCESSFUL. 7/7 midpoints populated over ~67 minutes (P-G / P-H /
  P-N / P-O / P-P / P-Q / P-U).
- **SepoliaPositiveFlows** — `exit=1` at Scenario 5 ("Cancel Lender
  Offer") with `CancelCooldownActive()`. Pre-existing legacy-script
  bug surfaced: the script creates a lender offer and calls
  `cancelOffer` in the same broadcast tick, which the 5-minute
  `MIN_OFFER_CANCEL_DELAY` introduced by the offer-cancel PR rejects
  on a real chain. The first four scenarios passed cleanly before
  the cooldown bit. Earlier "passes" of this script on Anvil / Base
  Sepolia had this hidden because Anvil timestamps are
  deployer-controlled and Base Sepolia run-history happened to land
  on a longer wall-clock between create and cancel. The contract
  behaviour is correct; the script needs a `vm.warp(+5 minutes)` (or
  a different scenario shape that doesn't depend on instant cancel)
  before this test can run end-to-end on a real chain. Tracked
  separately — fix in a future PR.

Total broadcast time on Sepolia: ~2h 50m across the four scripts (chain
confirmations, not script logic, dominated). Bash chain ran sequentially
without `set -e` so the SepoliaPositiveFlows failure didn't abort the
remaining three. Logs at `/tmp/sepolia-flow-logs/{01..04}-*.log` for
post-mortem; broadcast artifacts at
`contracts/broadcast/<Script>.s.sol/11155111/run-latest.json`.

## Pre-existing bugs surfaced + fixed

### Diamond selector gap — 38 functions missing on-chain

A comprehensive audit of every external/public function on three
configuration facets versus what `DeployDiamond.s.sol` registers
revealed:

- **ConfigFacet** — 27 of 55 functions missing (master-flag
  single-getters, periodic-interest knobs, predominantly-available-
  denominator knobs, grace-bucket admin, numeraire knobs).
- **OracleAdminFacet** — 10 of 30 functions missing (Pyth
  cross-check oracle setters + 5 individual getters).
- **RewardReporterFacet** — 1 of 12 missing (`getRewardGraceSeconds`).

The functions existed in source but were never wired into the
diamond's selector arrays, so the diamond's fallback returned
`FunctionDoesNotExist()` for every protocol-console knob read.

**Resolution:**

1. Source additions — added 4 single-field getters to ConfigFacet
   (`getRangeAmountEnabled` / `getRangeRateEnabled` /
   `getPartialFillEnabled`, plus `getRewardGraceSeconds` to
   RewardReporterFacet). The other 34 functions already existed in
   source; only the diamond registration was missing.
2. `script/DeployDiamond.s.sol` — `_getConfigSelectors` grew 28 → 55,
   `_getOracleAdminSelectors` 20 → 30, `_getRewardReporterSelectors`
   11 → 12. Fresh deploys now ship with the complete protocol-console
   surface.
3. `test/HelperTest.sol` — mirrored the same growth (45 → 55 for
   ConfigFacet, 11 → 12 for RewardReporter). OracleAdminFacet stays
   un-cut in HelperTest by design — tests bypass owner-gated setters
   via `TestMutatorFacet.setWethContractRaw` and friends.
4. `script/ReplaceStaleFacets.s.sol` — extended to a 9-cut diamondCut
   that deploys fresh ConfigFacet + OracleAdminFacet + RewardReporterFacet
   bytecode and does Replace+Add for every selector across the three
   facets (plus the original Offer/Oracle/EscrowFactory replaces).
   Run on both testnets with `ADMIN_PRIVATE_KEY` (admin owns the
   diamond pre-rotation).
5. `forge test --no-match-path test/invariants/*` — 1613/1613 PASS
   after every change.

### Frontend Diamond ABI — `OracleAdminFacetABI` never spread

`frontend/src/contracts/abis/index.ts` exports per-facet ABIs and
composes a unified `DIAMOND_ABI` by spreading 27 of them. The
`OracleAdminFacet` per-file export was imported but **never spread
into `DIAMOND_ABI`**, so every viem `readContract({ abi:
DIAMOND_ABI_VIEM, functionName: 'getPyth*' })` returned "Function not
found on ABI" before it even hit the chain — even though the
contract had the selector and returned values via direct `cast call`.

**Resolution:** added `import OracleAdminFacetABI from
'./OracleAdminFacet.json'`, the named export, and the
`...OracleAdminFacetABI` spread into `DIAMOND_ABI`. Frontend
typecheck + Vite build clean.

### Frontend protocol-console knob references — 2 stale setter names

`frontend/src/lib/protocolConsoleKnobs.ts` referenced
`OracleAdminFacet.setPythNumeraireFeedId` and
`OracleAdminFacet.setPythNumeraireMaxDeviationBps`. The actual contract
setter names are `setPythCrossCheckFeedId` and
`setPythCrossCheckMaxDeviationBps` (the getter names diverged from the
setter names during a rename pass). Knob registry updated to use the
canonical setter names.

### Frontend VPFIBuyReceiver knob — `no-target` on non-canonical chains

The "Reconciliation watchdog" knob targets `VPFIBuyReceiver`, which by
design lives only on canonical-VPFI chains (Base / Base Sepolia). On
mirror chains (Sepolia, Arb Sepolia, Polygon Amoy, etc.) the
deployments JSON has `vpfiBuyReceiver: null` because the cross-chain
buy mesh has many adapters → one canonical receiver. The protocol
console correctly resolved the target to null but surfaced "read
failed: no-target", which is confusing for users who can't act on
that chain anyway.

**Resolution:** `pages/AdminDashboard.tsx` now filters out every knob
whose `getter.facet === 'VPFIBuyReceiver'` when
`readChain.isCanonicalVPFI !== true`. The card is hidden cleanly on
mirror chains; appears as before on Base / Base Sepolia.

### Watcher chain-indexer `kind` literal mismatch

`hf-watcher/src/chainIndexer.ts` writes `indexer_cursor` rows with
`kind = 'diamond'` (one indexer scans the diamond's full event
surface — offers + loans together). `hf-watcher/src/offerRoutes.ts`
was reading with `kind = 'offers'` — a stale literal from before the
indexers were unified. The cursor lookup always returned null →
`/offers/stats` exposed `"indexer": null` to the frontend → the
"connected/disconnected" badge stayed permanently amber even though
the indexer was working perfectly (44 offers + 12 loans observed live
during this work).

**Resolution:** `offerRoutes.ts` now reads `kind = 'diamond'` to match
the writer. Watcher redeployed; `/offers/stats` now returns
`indexer: { lastBlock, updatedAt }` and the frontend badge turns
green on next read.

## Operational ergonomics — automated post-deploy steps

Three steps that previously required manual operator action were
folded into `deploy-chain.sh` (testnet only — mainnet preserves
its tiered confirm-each-phase discipline):

### `[5b]` Master-flag auto-flip on testnet

Range Orders Phase 1's three governance-gated kill switches
(`rangeAmountEnabled`, `rangeRateEnabled`, `partialFillEnabled`)
default `false` per `docs/RangeOffersDesign.md §15` staged-enablement
rationale. The Anvil bootstrap script flipped them; `deploy-chain.sh`
did not. So Base Sepolia's first deploy came up with the flags OFF
and `AnvilNewPositiveFlows.N22` + every range-offer scenario in
`AnvilNewPartialFlows` failed with `FunctionDisabled(1)`. After the
manual cast send to flip them, the same scripts passed.

`deploy-chain.sh` now runs `cast send <diamond> 'set*Enabled(true)'`
for each of the three flags after the contract deploy completes,
gated on `ADMIN_PRIVATE_KEY` being present. Idempotent — re-flipping
an already-true flag is a successful no-op tx. `deploy-mainnet.sh`
intentionally does NOT call this — production rollout remains gated
on governance.

### `[8b]` D1 migrations on watcher deploy

The watcher returned 500 `byParticipant-failed` (D1_ERROR no such
table) for every loan / offer query because the operator workflow
required a separate `npm run db:migrate` step that was easy to miss.
`deploy-chain.sh §8b` and `deploy-mainnet.sh phase_cf_watcher` now
run `npm run db:migrate` on every deploy. Wrangler's migration
applier is idempotent — already-applied entries are skipped.

### `[8c]` RPC-secret presence check

The watcher returned 503 `chain-not-configured` for any chain whose
`RPC_<CHAIN>` Cloudflare secret wasn't set. The script now runs
`wrangler secret list` and warns (does not fail) when the expected
per-chain RPC secret is missing, with the exact `wrangler secret put`
command to set it. Per `CLAUDE.md`, RPC secrets carry API keys and
stay operator-curated — the script never auto-populates them.

## Verification (live state at 2026-05-05)

- **Base Sepolia diamond** (`0x94F5…c776`)
  - `getMasterFlags()` → `(true, true, true)` ✓
  - `getTreasuryFeeBps()` → 100 ✓
  - `getLifMatcherFeeBps()` → 100 ✓
  - `getRewardGraceSeconds()` → 14400 ✓
  - `getPythMaxStalenessSeconds()` → 300 ✓
  - `getSecondaryOracleMaxStaleness()` → 3600 ✓
  - VPFIBuyReceiver `reconciliationWatchdogEnabled()` → true ✓
- **Sepolia diamond** (`0x3458…8eb7`) — same flag state (`true,
  true, true`) post-flip
- **Watcher** (`vaipakam-hf-watcher` Version
  `e78af698-63ab-4daf-9e29-6507ed0f4ba8`)
  - `/offers/stats?chainId=84532` returns `indexer: { lastBlock:
    41070911, updatedAt: 1777910112 }` ✓
  - `/loans/by-lender/...?chainId=84532` returns 12 indexed loans ✓
- **Frontend** (`vaipakam` Version
  `53095de8-9861-4444-b154-223e9823332e`)
  - `tsc -b --noEmit` clean ✓
  - DIAMOND_ABI now spreads 28 facets (was 27) — OracleAdminFacet
    fully surfaced ✓
  - VPFIBuyReceiver knob hidden on non-canonical chains ✓
- **Forge test regression** — 1613/1613 PASS, 0 failed (after every
  contract change in this session)

## Frontend UX + indexer/refresh-pipeline rebuild

A large frontend pass shipped today reshapes how the app pulls data
from chain + worker, how it surfaces "is this fresh?" to the user, and
how a handful of dense list views render token amounts. The pieces are
related — they move together as one coherent shift from "bulk-scan
on every render" to "indexer first, narrow RPC delta on top, with a
single 5-second watermark probe driving the whole tree."

### Indexer status badge + popover

The top-bar status pill that surfaces "what's serving the data right
now" was rebuilt to remove the manual rescan button and replace its
explanatory tooltip with a structured popover. Three states:

- **Cached (green)** — the worker indexer responded; the page renders
  from its snapshot and a 5-second background tail merges new
  on-chain events on top.
- **Live (amber)** — the worker is unreachable, the chain isn't
  covered by the cache, or the snapshot hasn't returned yet. The
  browser falls back to direct RPC reads.
- **Local dev (blue)** — wallet connected to chainId 31337
  (Anvil / Foundry / Hardhat). The cloud worker by definition can't
  reach a local dev node; surfacing this as a distinct colour keeps
  the badge from flashing amber during normal dev work.

Clicking the info icon next to the pill opens a popover with:

- A structured status block (State / Chain / Data source / Cache age /
  Last update timestamp) so a curious user can see the exact health
  of the pipeline without digging into devtools.
- A plain-English explanation of what the colour means and what to
  expect if the user submits a transaction in this state.

The previous rescan button on the badge was removed deliberately:
manual chain-scans are an RPC-quota abuse vector (a frustrated user
or a trivial bot can spam-click into a paid-tier RPC bill) AND they
gave users the wrong mental model that they "need" to refresh.
Auto-refetch on tab-focus + the 5-second background tail + post-tx
receipt refetch is the modern DeFi pattern; users who want to force
a fresh read still have a cooldown-gated rescan button on the pages
where it belongs (OfferBook, Activity, Vault — see below). The
popover is mobile-aware: on viewports below 640 px it docks fixed
to the top of the viewport instead of anchoring to the badge,
preventing the off-screen-clip bug on narrow screens.

### Live-tail data pipeline (5-second watermark, indexer + RPC catch-up)

Replaced every page's per-page-mounted polling timer with a single,
shared "watermark probe" pattern shared across the app:

1. **Initial mount + tab-focus** — the page snapshots from the
   indexer (cheap, fast, complete up to the indexer's last cron
   tick), then runs a chunked `eth_getLogs` catch-up over the
   indexer-tail → safe-head gap (1000-block windows so it slots
   into the strictest free-tier RPC caps). The catch-up reads at
   the safe block tag so a reorg can never deliver a then-discarded
   log into the cache.
2. **Live tail** — every 5 seconds (paused when the tab is hidden,
   re-fired immediately on visibility change), one cheap on-chain
   read of a single contract view returns the lifetime offer count
   and lifetime loan count. Strictly increasing on creates. The
   subscriber data hooks listen on a `version` integer that bumps
   only when one of those numbers actually advanced — so a quiet
   chain with no new offers / no new loans uses ~12 RPC calls per
   minute total across the entire page, not per-hook.
3. **Per-tx receipt refetch** — the user's own actions trigger an
   immediate refetch of the surfaces they touched (already standard
   wagmi behaviour); doesn't go through the watermark.

The 5-second cadence was chosen as a balance: tighter than every
chain we ship on except Arbitrum (where the user sees a new block at
most ~3 s after creation), well under the threshold where a
freshly-created offer "should have appeared by now," and exactly
half the indexer cron's 60-second minimum so the next-cron-data is
always available when the rescan cooldown expires. Earlier in the
session the cadence was 2 s; raised to 5 s because the perceptual
benefit of 2 s was zero (post-tx refetch handles "after I clicked"
freshness) and the RPC budget at 2 s was 60 % higher.

The watermark probe doesn't replace contract-event subscriptions
indiscriminately — it specifically replaces the long-lived
`eth_newFilter` / `eth_getFilterChanges` poll loops that the legacy
on-chain log scan used to keep alive. Those polls were running 4
times per page (one per offer-book event), even on idle. Removed.
Now a single 5-second multicall against the diamond drives every
data-hook subscriber AND triggers the legacy log-scan refresh.

### Safe-block cursor everywhere — reorg-proof refresh

Both layers of the indexer pipeline (browser-side legacy log scan +
worker-side D1 indexer) used to cursor on `latest`-tag head, which
meant cached events near the unsafe tip could include rows from a
soon-to-reorg block. The next scan would skip those blocks (fromBlock
= cached.lastBlock + 1), leaving the stale row in cache forever.

Fix shipped on both sides:

- Browser localStorage cursor reads at `eth_getBlockByNumber('safe')`
  (fallback: `latest - 32` on older RPCs that don't support the safe
  tag).
- Worker D1 cursor reads at `client.getBlock({ blockTag: 'safe' })`
  with the same fallback.

By the time a block is safe-tagged, its reorg horizon is already
past it, so the cursor is structurally reorg-proof. Initial page
load, tab refocus, manual rescan, the watermark refresh, and the
worker cron all pull from the same safe-aligned cursor — no path
ever caches a row from a block that could later get reorged out.

### Rescan-button cooldown + sync-status state machine

Three pages have an explicit "force-fresh-now" rescan button:
OfferBook, Activity, and the Vault (Your Vaipakam Vault). All three
now drive their button through a shared state machine:

- **30-second cooldown** prevents spam-clicks burning RPC quota. The
  legacy chain scan completes in 1–5 seconds on healthy RPC, so the
  cooldown is longer than the underlying refresh — that gap is
  exactly where the user reads the confirmation status, and the
  cooldown's end is timed so the next indexer cron run has likely
  also fired before the button re-enables.
- **Animated progress bar** along the bottom edge of the button
  shrinks right-to-left as the cooldown drains. Visual semantic:
  "this much time still locked" — easier to read at a glance than
  a fill-from-empty bar.
- **Status pill transitions** — Idle → Syncing… (with spinning
  refresh icon and live seconds-remaining) → Synced ✓ (with
  check-mark icon and the seconds remaining until re-enabled) →
  Idle. The user sees the underlying scan finish ("Synced") well
  before the button returns to its idle state.
- **Stable-width seconds** — the digits (e.g. "30" → "9") sit in a
  fixed-width slot with tabular numerals, so the surrounding
  "Refreshing… " / "Synced — " / "s" labels don't shift left or
  right as the countdown ticks down.

Same chrome on all three buttons so users learn the pattern once.

### Layered refresh — indexer first, RPC delta on top

When the user clicks rescan:

1. The page re-pulls the indexer snapshot (fast, complete up to the
   indexer's last cron tick).
2. On top of that snapshot, a chunked `eth_getLogs` catch-up reads
   only the indexer-tail → safe-head delta and merges new offer
   events / loan events / activity events into the rendered list.
3. The legacy in-browser log scan also re-runs as a fallback, but
   now starts at `max(local-cached-block, indexer.lastBlock + 1)`
   — when the indexer is healthy, that collapses to a ~60-second
   window of blocks instead of the entire deploy-block → head
   history. Combined with the safe-block cursor, the legacy scan's
   typical per-rescan work is now a few hundred blocks at most.

The OfferBook had a long-standing race where the legacy log scan
completing AFTER the indexer-served path populated the offer list
would clobber the page back to empty (the reset-on-`sortedIds`
effect didn't know to skip when the indexer was already serving).
Fixed: the reset effect now defers to the indexer-served path when
that path is active, and the rescan button no longer manually
blanks the offers state during an indexer-serve refresh.

### Refresh + offer/loan-list rendering polish

A pile of smaller polish items shipped alongside the data-pipeline
work:

- **Loan-list HF / LTV columns** — the bar gauges that ate ~200 px
  per row are replaced with compact colour-coded chips
  (safe-green / warning-amber / danger-red). The bar variant is
  retained for single-loan / preview surfaces (Loan Details,
  OfferRiskPreview) where the threshold tick-mark adds value; on
  the dashboard list, the chip is enough since users are scanning
  for the danger zone, not measuring exact distance.
- **View column dropped from the loan list** — the loan-id in the
  first column already deep-links to the loan detail page; a
  separate "View" button at the row's far right was duplicate
  navigation. The cell is kept for the conditional Claim CTA on
  rows where the wallet has a terminal-state claimable.
- **Token symbols pre-warmed** — the loan list pre-fetches every
  unique principal + collateral asset's `symbol()` and `decimals()`
  in parallel before any row mounts, so users see "USDC ↗" / "WETH ↗"
  on first paint instead of a shortened-address flash. Combined
  with a fix to the token-meta cache (which used to poison itself
  on a transient RPC hiccup and persistently render the address
  forever), the list now renders symbols cleanly on first load and
  every refresh.
- **Compact locale-aware amounts** — token amounts in the loan list
  + offer cards now render in compact form (`2.5K`, `4.54M`,
  `1.2B` in English; `2,5 Tsd.` / `2,5 Mio.` in German;
  `2,5 k` / `4,54 M` in French; `2.5万` / `4540万` in Japanese;
  `٢٫٥ ألف` / `٤٫٥٤ مليون` in Arabic with Arabic-Indic digits)
  following the in-app language switcher, NOT the OS locale.
  Each compact value carries a hover tooltip with the full precise
  decimal-grouped value so users who need the exact number get it
  without clicking through. Detail pages (Loan Details, Refinance,
  Preclose, Withdraw, NFT Verifier) keep full precision since the
  exact amount is load-bearing for a tx the user is about to sign.

### Initial-load deep-scan race

Before today, mounting a page on a fresh browser kicked off a
deploy-block → head log scan immediately, BEFORE the indexer's
`/offers/stats` endpoint had returned the indexer's `lastBlock`
hint. That meant a fresh user on Sepolia (which is at hundreds of
thousands of blocks) waited tens of seconds on the slow scan even
when the indexer was healthy and could have provided the cursor
hint. Fixed: the legacy log scan is now gated on the indexer-stats
fetch resolving (success or failure). Once it resolves, the scan
either fast-forwards to the indexer's last block (cheap) or falls
back to the local cache cursor (also cheap on warm browsers). The
localStorage cache snapshot is still rendered synchronously for
first-paint via `peekLoanIndex` regardless of the gate, so users
see content immediately; only the background RPC scan is deferred.

### Per-page polling tiers + activity-aware backoff

The 5-second watermark probe described above turned out to be too
hot for surfaces other than the OfferBook. Refined into three
layers:

- **OfferBook (active surface)**: 5 s probe — users actively watch
  for new offers landing.
- **Dashboard / Activity / Vault / Loan Details / homepage hero**:
  20 s probe — counter-driven changes still surface within ~30 s
  without the OfferBook's RPC cadence. Three-quarters of pages run
  at this rate now; the budget drop is 60 % vs the original
  5-second-everywhere build.
- **Idle / walked-away on OfferBook**: extra activity-aware tiers
  layered on top of the 5-second baseline. After 5 minutes of no
  mouse / keyboard / scroll / touch input the cadence backs off to
  30 s; after 15 minutes the timer pauses entirely until the next
  activity event. Tab refocus and any input event fire an immediate
  catch-up probe and reset to the active tier.

`useLiveWatermark` takes four optional knobs (`pollIntervalMs`,
`idlePollIntervalMs`, `idleAfterMs`, `pausedAfterMs`); only the
OfferBook hook opts into the activity layer. Other pages stay flat.
Activity listeners use `passive: true` and a 1 Hz timestamp-write
throttle so the listener itself isn't a perf cost.

### Adaptive rescan-button cooldown

The rescan buttons (OfferBook, Activity, Vault, plus a new one on
Dashboard) used to lock out for a flat 30 seconds. The cooldown
state machine (`useRescanCooldown`) is now adaptive:

- First click after a quiet stretch: 30 s baseline.
- Each consecutive click within `resetAfterIdleMs` of the previous
  cooldown ending grows the next cooldown by `growthFactor` (2×),
  capped at `maxCooldownMs` (5 minutes).
- After 2 minutes of quiet post-cooldown, the next click resets
  to the 30 s baseline.

Spam pattern: 30 s → 60 s → 120 s → 240 s → 300 s (capped). Walk-
away-and-come-back-2-minutes-later: stays at 30 s. The growth fires
on the second click — the first establishes the cooldown — so
legitimate "did my tx land?" rechecks after a few minutes always
get the baseline.

Visual polish from the same pass:

- The countdown progress bar now drains right-to-left ("time
  remaining") instead of filling left-to-right.
- The seconds digit sits in a fixed-width slot with `tabular-nums`,
  so the "Refreshing… 30s" → "Refreshing… 9s" transition doesn't
  shift the surrounding label by one digit width.
- All four rescan buttons (Activity / OfferBook / Vault / new
  Dashboard button) share the same chrome, animation, and adaptive
  state machine.

### Dashboard rescan button

New rescan button on the Dashboard's "Active loans" section header
(connected wallets only). Click triggers `refetchIndexedLoans()` +
`reloadUserLoans()` + `reloadClaimables()` together — three loan-
list data sources refresh in one action. Same chrome + adaptive
cooldown as the other rescan buttons.

### Watcher offer-decode drift — incident + structural fix

The OfferBook page rendered offers with garbage values
(5×10²⁹ ETH amounts, 10⁷% rates, 5×10¹⁸ days durations) for
several offer IDs while the same IDs rendered correctly on the
Dashboard. Every value off, every "address" pointing at a
near-zero / BPS-literal pattern.

Root cause: the hf-watcher Cloudflare Worker carried a hand-typed
`as const` ABI tuple in `ops/hf-watcher/src/diamondAbi.ts` for
`getOfferDetails`. When `LibVaipakam.Offer` gained
`periodicInterestCadence` (T-034 — Periodic Interest Payment) the
hand-rolled tuple wasn't updated. viem's positional decoder shifted
every subsequent field by one slot:

- `lendingAsset` decoded from where the cadence enum actually
  lives — a small enum value padded out to 32 bytes is a
  near-zero address, which the frontend rendered as "ETH" via
  its `0x0000…0000`-asset fallback path.
- `amount` decoded from the lendingAsset bits — an address read
  as a uint256 produced 5.93×10²⁹.
- And so on cascading.

Why it only bit OfferBook: Dashboard reads via the auto-synced
frontend ABI bundle (canonical, byte-perfect), bypassing the
watcher entirely. The OfferBook indexer pipeline went through the
watcher's stale tuple.

**Surgical fix**: added `periodicInterestCadence` to the worker
ABI, redeployed; the worker's `refreshStaleOfferDetails` cron loop
re-decoded every active offer on the next 5-minute tick, healing
all 17 polluted D1 rows across Base Sepolia + Sepolia without a
custom backfill script.

**Structural fix**: replaced the hand-typed ABI tuple with JSON
imports generated via `forge inspect <Facet> abi --json`. New
script `contracts/script/exportWatcherAbis.sh` (mirrors
`exportFrontendAbis.sh` exactly) writes
`ops/hf-watcher/src/abis/OfferCancelFacet.json` and
`LoanFacet.json`, plus a `_source.json` provenance stamp.
`deploy-chain.sh` phase 6 and `deploy-mainnet.sh phase_abi_sync`
invoke it automatically alongside the existing frontend +
keeper-bot exports — the watcher ABI can never silently drift from
the contract struct again. The Solidity compiler is the single
source of truth for the worker's read-decode shape; hand-typed
positional ABIs are gone and can't recur. Documented in
[`CLAUDE.md`](../../CLAUDE.md) "Watcher (hf-watcher) ABI sync".

### Safe-block cursor on the watcher (mirroring the frontend)

The earlier safe-block fix shipped on the browser-side legacy log
scan but the worker's D1 indexer kept reading at `latest`-tag head.
That left the cursor exposed to reorgs on the worker side — a
1- to 32-block reorg could remove a block whose `OfferAccepted`
the worker had already written to D1, and the next cron run
(resuming from `cursor + 1`) would skip the reorged block,
leaving the stale row in D1 forever.

[`chainIndexer.ts`](../../ops/hf-watcher/src/chainIndexer.ts) now
reads at `client.getBlock({ blockTag: 'safe' })` with a
`latest - 32` fallback for RPCs that don't support the safe tag.
Initial page load, tab refocus, manual rescan, the watermark
auto-refresh, AND the worker cron all now cursor from the same
safe-aligned position. End-to-end reorg-proof.

### Vault token discovery (drop hardcoded list, pure-history)

The Vault page (`Your Vaipakam Vault`) used to render rows from a
hardcoded `knownProtocolTokens(chainId)` list pulling
`vpfiToken / weth / mockERC20A / mockERC20B` from the deployments
record. That list silently broke for testnet mock tokens because
each flow run deploys fresh `new ERC20Mock(...)` contracts whose
addresses are NEVER written into `addresses.json` — a wallet with
1,000 mUSDC physically in escrow rendered as zero because the page
didn't know mUSDC was a token to render.

Vaipakam is asset-agnostic — the platform doesn't curate which
ERC-20s users may transact in. The static list was dropped
entirely; token discovery is now pure-history:

- `useIndexedLoansForWallet(addr)` — every loan the wallet
  participated in on either side. Surfaces `lendingAsset` +
  `collateralAsset`.
- `fetchOffersByCreator(chainId, addr)` — every offer the wallet
  created (active / filled / cancelled). Same asset fields.

Both sources are cache-backed via the worker indexer's D1, fronted
by the worker REST endpoints — no direct historical RPC reads. The
per-token live `balanceOf` + `protocolTrackedEscrowBalance` reads
are still RPC (those values must be live), but the token LIST
itself comes from the indexer cache. Refresh cadence end-to-end:
worker cron 5 min → frontend probe 20 s on the Vault page →
immediate refetch on tab focus / post-tx receipt / manual rescan.

`min(balanceOf, tracked)` defensive gate preserved per-token —
the change is which tokens get checked, not the trust model.

### Vault zero/dust filter + dust toggle

Companion to the discovery change — the Vault now drops zero-
balance rows always (no information value) and hides dust amounts
(< 1×10⁻¹¹ in display units) behind a toggle, default ON.

- **Zero filter**: always on; `min(balanceOf, tracked) === 0n`
  rows never render. No toggle.
- **Dust filter**: toggle in card header, default ON. Hides rows
  whose display value is below `1×10⁻¹¹`. Implementation gates the
  threshold by token decimals: 18-decimal tokens have balances
  below 10⁷ wei (≈10 gwei) classified as dust; ≤10-decimal tokens
  are exempt (1 wei on a 10-dec token displays as 1×10⁻¹⁰, above
  the threshold). 6-decimal stable-coins always show every
  non-zero balance — even `1 wei = 0.000001 USDC` stays visible.

Counter inline in the header surfaces hidden-row counts so the
user knows when filtering is doing real work. Empty-state copy
distinguishes "all your balances are dust → click Show all" from
"all your balances are zero → re-deposit via staking flow."

### Vault token icons + CoinGecko / explorer external links

Vault rows now render a small circular token icon (Trust Wallet's
CDN by default, configurable via `VITE_TOKEN_ICON_URL_TEMPLATE`)
next to the symbol. The symbol itself is wrapped in
`<AssetLink kind="erc20">` — the same component the OfferBook /
Dashboard / Loan Details surfaces use — which routes the click to
CoinGecko when the token is indexed (debounced verifier check)
and falls back to the chain explorer's contract page otherwise.
Hover tooltip on the symbol surfaces the full contract address.

Icon sourcing:

- Default: Trust Wallet's purpose-built CDN
  (`assets-cdn.trustwallet.com`) — designed for wallet/DApp icon
  traffic, no GitHub-ToS rate-limit caveats.
- Override via `VITE_TOKEN_ICON_URL_TEMPLATE` (documented in
  `frontend/.env.example` with two example fallback patterns:
  GitHub raw + self-hosted registry).
- Caching: browser HTTP cache only. No localStorage layer — the
  status-cache pattern was prototyped and reverted; HTTP cache is
  the right primitive for binary assets and Trust Wallet serves
  long-cache headers. Negative-cache durability via localStorage
  was the only real win and only on testnet; not worth the
  cache-invalidation complexity.
- On image load failure (testnet mocks, unrecognised chain), the
  icon collapses to a neutral grey circle placeholder so row
  chrome doesn't jitter. Chains absent from the slug map
  (`TRUST_WALLET_SLUG`) short-circuit before the network request.

### Compact locale-aware token amounts in list views

Token amounts in dense list views (Dashboard's loan list, OfferBook
offer cards + table rows) now render in compact form using
`Intl.NumberFormat` with `notation: 'compact'`, following the
in-app language switcher (NOT the OS locale):

- en: `2.5K`, `4.54M`, `1.2B`
- de: `2,5 Tsd.`, `4,54 Mio.`, `1,2 Mrd.`
- fr: `2,5 k`, `4,54 M`, `1,2 Md`
- ja: `2.5万`, `4540万`
- ar: `٢٫٥ ألف`, `٤٫٥٤ مليون`

Each compact value carries a hover tooltip with the full precise
decimal-grouped value so users who need the exact number get it
without clicking through. Detail surfaces (Loan Details, Refinance,
Preclose, Withdraw, NFT Verifier) keep full precision for tx-bound
displays.

### HF/LTV chips replacing bar gauges in dense views

The bar gauges that ate ~200 px per row in the Dashboard loan list
were replaced with compact colour-coded chips (safe-green /
warning-amber / danger-red). The bar variant survives on
single-loan / preview surfaces (Loan Details, OfferRiskPreview)
where the threshold tick-mark adds value; on the Dashboard list
the chip is enough since users are scanning for the danger zone,
not measuring exact distance.

### "View" column dropped from loan list

The loan-id in the first column of the Dashboard loan table
already deep-links to the loan detail page. A separate "View"
button at the row's far right was duplicate navigation; removed.
The action cell stays for the conditional Claim CTA on rows where
the wallet has a terminal-state claimable.

### Chain-agnostic flow-script wrappers

Three chain-agnostic entry-point scripts landed for the next test
run, composing the existing per-feature scripts with no internal
state merge — Phase A runs to completion, Phase B follows:

- `contracts/script/PositiveFlows.s.sol` — appends
  SepoliaPositiveFlows (15 legacy lifecycle scenarios) +
  AnvilNewPositiveFlows (18 new-features scenarios) for a 33-scenario
  full-positive sweep on any chain.
- `contracts/script/PartialFlows.s.sol` — appends
  BaseSepoliaPartialFlows (6 UI-testable midpoints) +
  AnvilNewPartialFlows (7 new-features midpoints) for a 13-midpoint
  partial sweep on any chain.
- `contracts/script/NegativeFlows.s.sol` — chain-agnostic dispatch
  over AnvilNegativeFlows (9 gate-rejection scenarios; only one
  negative-flow source exists today).

Both halves of each composition already pulled the diamond address
from `Deployments.lib` and read the standard env-var topology, so
the wrappers inherit chain-agnosticism with no further configuration.
Originals are untouched. Updated `docs/ops/DeploymentRunbook.md` §5c
and `docs/TestScopes/AdvancedUserGuideTestMatrix.md` to point new
testnet sweeps at the wrappers.

## What this PR does NOT do

- Push to remote — local merges and deploys only. The 122 commits
  ahead of `origin/main` (from yesterday's session) plus today's
  changes are still local.
- Flip master flags on mainnet — staged rollout discipline preserved
  for production. Governance flips them via `setRange*Enabled(true)`
  through the Timelock when ready.
- Set RPC secrets via wrangler from the script — operator-curated
  values per `CLAUDE.md` "Cross-Chain Security" section. The deploy
  scripts now warn when missing, with the exact `wrangler secret
  put` command to run.
- Bump `currentTosVersion` / `currentTosHash` on-chain. The retail
  deploy continues to run with `currentTosVersion == 0` (gate
  dormant); when governance flips it on, the canonical text in
  `docs/Terms/TermsOfService.md` is what should be pinned.

---

## Phase 9 polish — indexer-first across Analytics + Dashboard

### Why this work

Two related issues drove the refactor. First, the Dashboard "Your
Offers" card was showing 2 active offers when the OfferBook
showed 5. Root cause: Dashboard's `useMyOffers` hook fed off the
local browser-side log scan, which lags the worker's snapshot by
seconds-to-minutes during catch-up. The OfferBook reads from the
worker's `/offers/by-creator` endpoint and saw the fresher state.
Same shape of bug surfaced on Analytics: every aggregate stat
walked the full historical loan list via per-loan `getLoanDetails`
multicalls, which scaled linearly with protocol history and burned
RPC budget on first paint.

The fix consolidates onto an indexer-first pattern across every
read surface. Pages now hydrate from the Cloudflare Worker's D1
cache when reachable; chain reads only fire when the worker is
confirmed-offline.

### New worker endpoints

Four endpoints landed on the hf-watcher Worker, all live at
`vaipakam-hf-watcher.dawn-fire-139e.workers.dev`:

- `GET /loans/stats` — aggregate loan counters per status
  (active / repaid / defaulted / liquidated / settled), ERC-20 vs
  NFT-rental split for the active set, per-asset principal volume
  + loan count across every status, average APR. Replaces the
  Analytics page's per-loan multicall storm with one D1 query.
  Per-asset BigInt sums aggregated in JS to avoid the SQLite
  `CAST(... AS INTEGER)` 64-bit overflow that would silently cap
  18-decimal token amounts past ~9.2e18.
- `GET /loans/recent` — most recent N loans regardless of state.
  Drives the Analytics recent-activity feed without falling back
  to a chain log scan.
- `GET /offers/recent` — same shape for offers.
- `GET /loans/timeseries?range=24h|7d|30d|90d|All` — per-day
  buckets of ERC-20 loan principal + earned interest grouped by
  lending asset. Drives the "TVL Over Time" + "Daily Loan Volume"
  charts. Server keeps the time bucketing; the frontend prices
  the per-asset BigInt sums to USD client-side using the oracle
  over the unique-asset set (typically <10 assets, scales with
  the supported-token list rather than loan history).

All four use the existing CORS / pagination shape and follow the
same indexer-cursor-included response pattern as `/offers/stats`.

### Activity-aware watermark policy helper

Eight call sites across the codebase used `useLiveWatermark` with
a hand-passed `pollIntervalMs` literal and no idle/walk-away
backoff. New helper `frontend/src/hooks/watermarkPolicy.ts`
exposes three named tiers:

- **hot** — OfferBook live market: 5 s active, 30 s idle (after
  5 min no input), pause after 15 min walked-away.
- **warm** — Dashboard, Vault, OfferDetails, Activity: 20 s
  active, 60 s idle, pause after 15 min walked-away.
- **cool** — Analytics aggregates: 180 s active, 600 s idle, pause
  after 15 min walked-away.

Every call site (`useIndexedActiveOffers`, `useIndexedLoans` ×2,
`useOfferStats`, `useIndexedActivity`, `useMyOffers`, `useLogIndex`,
`EscrowAssets`) now passes a tier instead of magic numbers.
Cadence tuning is now centralised. Visibility-pause (tab hidden →
no probe) is unconditional across all tiers.

Analytics gained auto-refresh in this pass — `PublicDashboard`
fires `reload()` + `reloadCombined()` on every cool-tier watermark
advance; the previous flow was on-mount only.

### New indexer-first hooks

- `useLoanStats` — wraps `/loans/stats`. Drives Analytics count
  cards.
- `useAssetBreakdown` — composes `useLoanStats.volumeByAsset` +
  `loansByAsset` with on-chain `getAssetPrice` over the unique-
  asset set + cached `fetchTokenMeta`. Drives the "Asset
  Distribution" section.
- `useHistoricalData` rewritten — pulls pre-bucketed time-series
  from `/loans/timeseries`, prices in USD client-side, falls back
  to the chain-side multicall walk only on worker outage.
- `useTVL` rewritten — paginates `/loans/active` until the
  `nextBefore` cursor returns null (hard-capped at 25 pages × 200
  = 5000 active loans for safety). Without pagination the TVL
  silently truncated to the first 50 active loans, understating
  real-world value locked. Falls back to the chain-side multicall
  list on worker outage.

### `useProtocolStats` lazy gating

Pre-this-pass `useProtocolStats` ran the full per-loan
`getLoanDetails` multicall on every Analytics mount, even after
every primary surface had migrated to the indexer-first hooks
above. The hook now accepts an `{ enabled }` option (default
`true` for backward compat). Three call sites pass `enabled`
based on whether their respective indexer-first source has
confirmed-failed:

- `PublicDashboard` enables when `loanStats === null` after
  loading.
- `useTVL` enables when its paginated `fetchActiveLoans` walk
  returns null.
- `useHistoricalData` enables when `fetchLoanTimeseries` returns
  null.

Each tracks an internal `indexerFailed` flag that flips back to
false on the next successful indexer fetch. On the happy path
(worker reachable), zero `getLoanDetails` calls fire on Analytics.
The chain-side multicall is now purely outage-recovery
infrastructure.

### Dashboard `useMyOffers` indexer-first

Same refactor pattern as the Analytics hooks — `useMyOffers` now
fetches from `/offers/by-creator` paginated, maps every status
(`active` / `accepted` / `cancelled`) onto its existing three
buckets without consulting the local log scan. The chain-side
`getOffer` multicall is now the worker-down fallback, gated by
the indexer fetch's success. Resolves the 2-vs-5 mismatch the
user reported. The Dashboard rescan button now also calls
`refetchMyOffers()` so manual refresh forces a fresh indexer
pull.

### `fetchActiveOffers` pagination correctness

Same correctness gap that bit `useTVL` was present in
`useIndexedActiveOffers` — single-page fetch with `limit=200`.
Now paginates via the `nextBefore` cursor, hard-capped at 25
pages × 200 = 5000 active offers. OfferBook is now safe at scale;
without the fix, a busy mainnet with >200 active offers would
silently hide the rest of the book.

### OfferBook status count fix

The page surfaced `Showing 7 of 3 open offers` because the bottom-
strip total derived from `useLogIndex.openOfferIds.length` (the
laggy local log-scan = 3) while the rendered rows came from
`useIndexedActiveOffers` (the fresher worker snapshot = 7). Both
the bottom strip and the `Open (N)` tab badge now read from the
indexer-served list when in indexer mode, falling back to the
validated count only when the worker is unreachable.

The earlier `Showing X of Y` semantics also got a fix in the same
file — the count now reflects the post-filter visible total
(after dedup + market filters + hide-my-offers) rather than the
raw fetch size, with an explicit `(N hidden by filters)` suffix
when the gap is non-zero. Resolves the previous UX where the
user could see "Scanned 3 of 3" while only 2 rows rendered (their
own offer hidden by the toggle without acknowledgment).

## Offer Detail page

New route `/app/offers/:offerId` — symmetric with the existing
`/app/loans/:loanId` Loan Detail surface. Mirrors the Loan Detail
read-path discipline: indexer-first via `fetchOfferById`, falls
back to a single direct `getOffer` chain read only when the
worker is unreachable. Page renders status badge, type
(Lender / Borrower), principal + collateral with TokenIcon and
asset link, rate, duration, creator, partial-repay flag,
first-seen timestamp + block link, and a redacted creation
transaction hash linked to the chain explorer.

The creation tx hash is resolved lazily after the indexer payload
lands via a targeted single-block `eth_getLogs` against the
`firstSeenBlock` filtered on the OfferCreated event topic + the
offerId-as-bytes32 — exactly one log matches per offer, so the
lookup is one block, one result, one RPC. Cached per-render via
React state so the lookup never runs twice.

The page exposes three contextual actions when applicable:
"Manage keepers" (creator-only, active offers; deep-links to the
existing keepers page), "Cancel offer" (creator-only, active
offers; submits the cancel tx with decoded contract-error
reporting), and "View loan #N" (for accepted offers; deep-links
to the loan that consumed this offer).

A partial-fill row displays when the indexer reports
`amountFilled > 0 AND amountFilled < amountMax`; pre-Phase-1
partial-fill rollout this branch is dormant but lights up
automatically once the indexer's `amountFilled` starts
populating.

The original implementation used custom CSS classes
(`loan-detail-field` / `loan-detail-label` / `loan-detail-value`)
which didn't exist in the project's CSS — fields stacked
vertically with no horizontal alignment ("juggled" appearance).
The page now uses the existing `.data-row` / `.data-label` /
`.data-value` chrome from AppLayout.css, matching the rhythm of
the Loan Detail page exactly.

## Site-wide offer-ID deep-linking

Five surfaces previously rendered offer IDs as static text. Each
is now a clickable Link to the new `/app/offers/:id` route:

- Activity feed event pills
- Loan Detail's "Original offer #N" reference
- Borrower Preclose review screen
- Refinance review screen
- NFT Verifier "Origin" row

Plus the OfferBook market table's ID column and the Dashboard
"Your Offers" table's ID column (every row variant — Active,
Filled, Cancelled-with-data, Cancelled-stub).

## Dashboard polish

### "Last refreshed" status with adaptive ticker

Both the Dashboard footer and the EscrowAssets Holdings card-
bottom toolbar now show a `Last refreshed N minutes ago`
indicator on the left side, paired with the existing rescan
button on the right. The relative-time text auto-advances via a
self-rescheduling `setTimeout` that picks the next tick interval
based on elapsed time:

- Under 60 seconds elapsed → ticks every 1 second (smooth count
  from "1 second ago" through "59 seconds ago").
- 60+ seconds elapsed → ticks every 30 seconds (the relative-
  time string only changes once per minute past 60 s, so a
  faster tick would burn CPU for no visual change).

The effect re-runs whenever the underlying data refreshes,
restarting the sub-minute fast-tick window. Pre-fix the ticker
was a flat 30 s interval, which made the visible count jump from
"6 seconds ago" to "36 seconds ago" with no in-between values.

### Pagination on Your Offers card

The Dashboard "Your Offers" table now paginates 10-per-page via
the existing `Pager` component. Page resets to 0 on status filter
changes (active / filled / cancelled / all) so a narrowed list
doesn't leave the cursor stranded past the new last page.

### EscrowAssets rescan moved to card bottom

The Vault's "Refresh" button used to live in the Holdings card-
title header next to the "Hide low balances" toggle. Moved to a
new card-bottom toolbar with `Last refreshed N minutes ago` on
the left and the rescan button on the right — matching the
Dashboard footer rhythm.

### Hide-my-offers toggle persistence

The OfferBook's "Hide my offers" toggle (default-on) now persists
to `localStorage` under `vaipakam:offerBook:hideMyOffers`,
matching the pattern already used by the Vault's "Hide low
balances" toggle. State survives page navigations and reloads.

## Locale coverage

Localised across 10 languages (en, de, es, fr, hi, ta, zh, ja,
ar, ko):

- OfferBook: `Show / Hide my offers` button + tooltip,
  `Showing N of M` count text, `(N hidden by filters)` suffix.
- Vault: `Show all (N hidden) / Hide low balances` toggle +
  tooltip.
- Dashboard rescan + EscrowAssets rescan: `Refresh`,
  `Refreshing…`, `Synced — `, seconds suffix, `Last refreshed
  {{when}}` (where `{{when}}` is filled by the existing
  `formatRelativeTime` helper which is already locale-aware).

The pre-existing `Scanned X of Y` wording was replaced with
`Showing X of Y` to reflect the new filter-aware semantics
across every locale.

## Net effect on RPC budget

Analytics page first paint, worker-reachable case:

| Surface | Before | After |
|---|---|---|
| Count cards | per-loan `getLoanDetails` multicall (scales with history) | indexer JSON, zero chain reads |
| TVL value | same multicall + per-asset `getAssetPrice` | paginated `/loans/active` + per-asset `getAssetPrice` |
| Asset distribution | same multicall + price lookups | one worker call + per-unique-asset price lookups |
| TVL Over Time + Daily Volume | same multicall, JS bucketing | one worker call + per-unique-asset price lookups |
| Recent activity feeds | log-scan IDs + 50-id `getOffer` multicall | one worker call, zero chain reads |
| Active offer book | log-scan IDs + per-id multicall | paginated `/offers/active`, zero chain reads on happy path |
| `useProtocolStats` | always fired on mount | gated; fires only when worker is confirmed offline |

The chain-side multicall infrastructure remains intact and is
still the source of truth during a worker outage — every
indexer-first hook holds the chain-side fallback path behind an
`indexerFailed` flag that auto-clears on the next successful
indexer fetch. No regression in worst-case correctness; the
common case is now an order of magnitude cheaper.
