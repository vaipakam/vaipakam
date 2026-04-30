# Release Notes — 2026-05-01

Functional record of work delivered on 2026-05-01, written as
plain-English user-facing / operator-facing descriptions — no
code. Continues from
[`ReleaseNotes-2026-04-30.md`](./ReleaseNotes-2026-04-30.md).

Coverage at a glance: **matcher kickback BPS made
governance-tunable** (the 1% slice of LIF the Range Orders
matching path pays third-party bots is now an admin/governance
config knob, not a hard-coded constant); **ABI re-export sync**
to both the keeper-bot and the frontend after the contract
changes; and **OfferFacet split for EIP-170** so the contract
can deploy on real chains where the 24576-byte runtime-bytecode
ceiling is enforced (Range Orders Phase 1 pushed the facet to
~28KB; mainnet had been blocked behind anvil's
`--code-size-limit 50000` override).

## Matcher kickback BPS — governance-tunable

The Range Orders matcher fee — the slice of any LIF that flows
to treasury, which is paid out to the third-party bot/relayer
that submitted the match — was a hard-coded `100` BPS (1%) at
the contract level. The original Phase 1 plan called the fee
"economics revisit" a Phase 2 item with the explicit note:
*"dial up to 5-10% of LIF if needed to attract community bot
operators."* The constant made that revisit a contract upgrade.

Today's change moves it into governance config:

- New `ProtocolConfig.lifMatcherFeeBps` (`uint16`) field. Default
  zero means "use the library default" (`LIF_MATCHER_FEE_BPS =
  100`); any non-zero value overrides.
- New accessor `LibVaipakam.cfgLifMatcherFeeBps()` follows the
  same fallback shape as the dozen other governance-tuned BPS
  configs in the codebase (`cfgTreasuryFeeBps`,
  `cfgLoanInitiationFeeBps`, etc.).
- New admin setter `ConfigFacet.setLifMatcherFeeBps(uint16)`
  with a `MAX_FEE_BPS = 5000` (50%) sanity cap so a misfire
  can't starve treasury. Emits `LifMatcherFeeBpsSet(newBps)`
  for indexers.
- The field is included in `getProtocolConfigBundle`'s return
  tuple so the frontend's `useProtocolConfig` hook surfaces it
  without an extra RPC.
- `LibOfferMatch.matcherShareOf` switched from `pure` to `view`
  and now reads `cfgLifMatcherFeeBps()` instead of the constant.
  Both callers (synchronous lender-asset path in
  `OfferFacet._acceptOffer` and the deferred VPFI path in
  `LibVPFIDiscount.settleBorrowerLifProper` / `forfeitBorrowerLif`)
  pick up the live value automatically.
- `OfferFacet.matchOffers`'s synchronous `OfferMatched` event
  computation was also updated to read from cfg, so the event's
  `lifMatcherFee` field reflects the current governance setting
  not a stale constant.

Frontend `BundleTuple` + `ProtocolConfig` interface extended.
`BootstrapAnvil`'s post-flip readback destructure extended.
`ConfigFacetTest`'s bundle destructure extended. Selector cut
added to `DeployDiamond._getConfigSelectors` (index 20) and
`HelperTest.getConfigFacetSelectors` so fresh deploys + tests
pick up the new setter.

Governance path: ADMIN_ROLE today, transferable to a Timelock
at any time — same shape as every other governance-tuned knob.
No contract change needed when ADMIN_ROLE rotates to a DAO.

Verification: `forge test --no-match-path "test/invariants/*"` →
**1402/1407 passing, 0 failed, 5 skipped** at the same baseline
as before the change.

## Permissioning model for Range Orders matching

Discussion landed on the question of whether to ship the
matching path as permissioned-now-permissionless-later (gate to
our reference bot during the bake, flip a flag to open it up
later). After review, **shipped permissionless** — the existing
implementation has zero caller restrictions on `matchOffers`,
matching the well-precedented model already in place for
liquidations. Reasons:

1. **Composability is the win.** The whole point of the 1%
   matcher kickback economic incentive is to attract a market
   of community bot operators. A whitelist nukes that market.
2. **Audit-friendlier shape.** Adding caller-gating expands the
   security model from "anyone can call this without harm"
   (which is robustly true: matchOffers can't steal funds, only
   facilitate a match between two consenting offers) to
   "whitelist must be defended" — strictly worse audit shape.
3. **You can still win the matching race during the bake**
   without a gate: faster bot poll interval, private mempool
   (Flashbots Protect / MEV Blocker), pre-funded gas reserves.
   Excluding others is the wrong tool for "we want to be
   first."
4. **Already permissionless** — adding the gate would be
   feature-creep we'd have to remove.

If a critical bug ever forces a controlled rollback, the
existing `pause()` lever is the actual emergency mechanism — it
freezes every state-changing path, not just matching, which is
the right granularity for an incident.

## ABI sync — keeper-bot + frontend

Per the project's standing convention (every contract-touching
PR ships with a fresh ABI re-export), both consumers were
synced after the lifMatcherFeeBps change:

- Keeper-bot: `bash contracts/script/exportAbis.sh
  KEEPER_BOT_DIR=…` regenerated the four facet JSONs
  (`MetricsFacet`, `RiskFacet`, `LoanFacet`, `OfferFacet`) plus
  the `_source.json` provenance stamp pointing at
  `vaipakam@9e9683d`. Bot's `npm run typecheck` clean.
- Frontend: `bash contracts/script/exportFrontendAbis.sh`
  regenerated all 28 per-facet JSONs (the full Diamond surface
  the frontend imports). Frontend's `tsc -b --noEmit` clean.

No selector deltas in either sync that affect existing
consumers — the only ABI change was the `getProtocolConfigBundle`
return tuple growing one slot (now 14-tuple including the
matcher BPS) and a new `setLifMatcherFeeBps` setter selector.
Frontend `useProtocolConfig` already updated to read the new
slot; bot doesn't consume the bundle so its sync is purely
provenance.

## Offer-creation HF / LTV live preview (Tier 2 #4)

Until today, an offer creator typed an amount and a collateral
amount blind: there was no live indication of where their
choice would land on the Health Factor or LTV curve until they
hit submit, watched the on-chain `LoanFacet.initiateLoan`
reject, and tried again. The dashboard's existing
**Liquidation-price projection** card already does the exact
right shape of work for an *active* loan; this change brings
the same idea into the *creation* flow.

What landed (Advanced mode only, ERC-20 / ERC-20 pairs only —
NFT-rental loans don't have a meaningful HF):

- A new **Risk preview** card renders inside the Collateral
  card on `Create Offer`. It reads the collateral asset's
  on-chain liquidation threshold (the same bps the on-chain HF
  formula uses) plus live oracle prices for both the lending
  and the collateral leg, and computes the projected Health
  Factor and LTV for the user's typed amounts.
- For a **Range Orders** offer (where the user has set a
  separate maximum amount above the minimum), the card renders
  HF and LTV at *both* ends of the range — labelled "best" and
  "worst" — so the user can see the worst-case position before
  publishing.
- A clear amber warning fires when the worst-case HF dips
  below the on-chain initiation floor of 1.5: at that point
  partial fills at the upper end of the range will revert with
  `HFTooLow`. The fix is mechanical (add collateral or tighten
  the ceiling) and the message says so.
- A "Collateral can drop X% before liquidation" line, derived
  the same way the existing Liquidation-price projection card
  does it, so the user has a concrete intuition for how much
  market move their offer can absorb.
- Two-way bound **sliders** for lending amount, lending amount
  max (when range mode is on), and collateral amount, mirroring
  the number inputs above. Drag the slider → the input value
  updates → the HF / LTV bars animate. The bars use the same
  shared component (`HealthFactorGauge` / `LTVBar`) and CSS
  transitions as everywhere else in the app, so the visual
  feedback is consistent with what the user sees on the
  dashboard and the loan view page.
- The card bails to a placeholder message while inputs are
  empty, and to a single-line "oracle unavailable" notice if a
  feed reverts — never to a broken `—` row. The on-chain HF
  check is still authoritative; the preview is a *guide*, not
  a guarantee.

The on-chain side of this is already correct (the HF gate at
`LoanFacet.initiateLoan` was always there); this is purely a
front-end pre-flight. Net effect: fewer "why did my loan get
rejected" support questions, and a friendlier ramp into Range
Orders for users who don't yet have an intuition for how a
[min, max] range maps to risk.

## Auto-refresh of the offer book on chain events (Tier 2 #22)

Previously, a new offer (or a fresh acceptance / cancellation /
range-orders match) would only show up in the Offer Book after
the user explicitly clicked the "Rescan chain" button or
hard-reloaded the page. Two open browsers — one creating an
offer, one watching the book — would diverge until either side
manually refreshed.

What landed:

- The shared event-backed loan / offer index (`useLogIndex`,
  consumed by both Offer Book and the Dashboard) now subscribes
  to four offer-affecting events on the Diamond:
  **OfferCreated**, **OfferAccepted**, **OfferCanceled**, and
  **OfferMatched**. Any one firing on-chain triggers a
  debounced incremental rescan.
- The 750 ms debounce coalesces the multiple events that a
  single user action emits (a `matchOffers` call emits
  `OfferAccepted` plus `OfferMatched`, optionally a dust-close
  `OfferCanceled`) into one rescan rather than three.
- The underlying scan is already incremental — it only re-reads
  blocks past the last cached block — so the per-trigger cost
  is small even on a slow public RPC.
- Because the Offer Book page already re-fetches its row data
  whenever the index's open-offer ID set changes, no
  Offer-Book-side change was needed: as soon as the index
  emits the new id, the page renders it. The existing
  "Rescan chain" button is preserved for the case where a
  filter drops a log (it now functions purely as a manual
  failsafe).
- Sort order is unchanged — the Offer Book's sort is fixed
  (descending by ID, newest first), not user-configurable, so
  a freshly indexed offer slots in at the top automatically.

Net effect: the offer book is now live. A new offer published
in one tab appears in another tab within ~1 s of its inclusion
block.

## Frontend env sync from deployment artifacts (Tier 3 #20)

The previous redeploy loop was: redeploy a contract on a chain →
open `contracts/deployments/<slug>/addresses.json` → manually
copy seven values per chain into `frontend/.env.local`. Easy to
transpose a digit, easy to forget a chain.

What landed: a small idempotent shell helper at
`contracts/script/syncFrontendEnv.sh`.

- Walks every `contracts/deployments/<chain-slug>/addresses.json`
  and writes the per-chain values back into
  `frontend/.env.local`. Diamond, deploy block, escrow impl,
  metrics / risk / profile facet addresses, and (where present)
  the VPFI buy adapter.
- Skips `anvil` (local-only — would otherwise pollute an
  .env.local that's also used for production builds).
- Replaces `KEY=...` lines in place when they exist; appends
  to EOF when they don't. Comments and unrelated lines (RPC
  URLs, manually-tuned values like `VITE_LOG_INDEX_CHUNK`) are
  preserved untouched. Empty / null / zero-address values are
  skipped silently so a half-populated artifact can't blank an
  existing value.
- Re-running on an already-synced env leaves it byte-identical.

The earlier draft of this same task in this file proposed
syncing into `frontend/wrangler.jsonc`'s `vars` block instead.
That was the wrong surface: the frontend ships as a Cloudflare
Pages-style static-asset deploy (`wrangler.jsonc` only declares
`assets` + SPA fallback, no Worker code), so a `vars` block
wouldn't reach the browser bundle at all. `VITE_*` values are
inlined at `vite build` time from `.env.local` — that's the
right surface to keep in sync, and it's what the script now
writes.

Deploy-flow caveat: `frontend/.env.local` is gitignored, so a
CI build (Cloudflare Pages dashboard, GitHub Actions) won't see
anything written by this script unless the values are also
mirrored into the Cloudflare Pages Build-Environment-Variables
dashboard, OR a `frontend/.env.production` is committed. The
script is for the developer's local `npm run deploy` flow; the
CI mirror remains a one-time setup step.

## UX polish batch — five Tier-4 dashboard / loan-view fixes

A grouped set of small UX issues shipped together since they
all touched the same dashboard / loan-detail surfaces and
reviewing them as one diff is cleaner than five micro-PRs:

1. **Tooltips inside scrolling tables now escape clipping.**
   The dashboard's `Your Offers` and `Your Loans` cards and the
   Offer Book's row table all wrap their `<table>` in an
   `overflow-x: auto` container so the table scrolls
   horizontally on small viewports. The CSS-only
   `[data-tooltip]` pseudo-element pattern can't escape that
   ancestor's clipping rectangle (CSS Level 2: `overflow-x:
   auto` with `overflow-y: visible` resolves both axes to
   `auto`), so a tooltip popping up off a table row was
   getting cropped or hidden entirely. A new `<HoverTip
   text="…">` wrapper component (mirrors `<InfoTip>`'s portal
   trick — bubble rendered into `document.body` via
   `createPortal`, positioned with JS-computed coordinates
   relative to the viewport) is now used for the in-row
   tooltips that previously clipped: the cancelled-offer
   pill, the manage-keepers and cancel-offer action triggers
   in `MyOffersTable`, the position-NFT verifier link and the
   claim button on the Dashboard's Your Loans, and the
   manage-keepers link on the Offer Book row. Same look and
   delay as the CSS tooltip — only the rendering surface
   differs.

2. **Lender Yield-Fee Discount card: discount-tier consent
   banner.** When a lender opens the loan-detail page and
   their platform-level VPFI fee-discount consent is **off**,
   the card now surfaces an amber `Discount tier disabled`
   banner that explains the yield fee will be charged at the
   full treasury rate with no VPFI rebate, and links straight
   to the Dashboard where the consent toggle lives. When
   consent is on but the lender has zero eligible VPFI in
   escrow on this chain, a quieter informational banner says
   `Consent enabled, no eligible VPFI` so the user knows the
   next step is to top up VPFI rather than to flip a switch.
   Both banners are silent in the normal case (consent on +
   VPFI staked) so day-to-day operation is unchanged.

3. **Status filter for `Your Offers` moved into the card
   header.** The Active / Filled / Cancelled / All filter chip
   used to render in a separate flex row above the card,
   making it easy for a user who scrolled past the card title
   to lose track of which filter was in effect. It now sits
   inline with the New Offer button in the card's header row,
   so the title row reads "Your Offers · n offers · [Status:
   …] · [+ New Offer]" left to right. No behaviour change —
   just relocation.

4. **Collateral column added to the Dashboard's `Your Loans`
   table.** Previously the table only showed Principal — a
   user reviewing their loans couldn't see the collateral
   asset or amount without clicking through to the loan
   detail page. The new Collateral column re-uses the same
   `<PrincipalCell>` renderer the Principal column uses, so
   ERC-20 amount + symbol, ERC-721 `NFT #N`, and ERC-1155 `Q
   × NFT #N` all render consistently. The underlying
   `LoanSummary` type and the `useUserLoans` hook were
   extended to surface `collateralAssetType` and
   `collateralTokenId` from the existing `getLoanDetails`
   return — they were already on the contract side, just
   never plumbed through.

5. **Claim Center loan IDs now deep-link to the loan-detail
   page.** When a user opens the Claim Center to claim a
   pending payout, each row's `Loan #N` label is now a link
   to `/app/loans/N`. Reviewing the loan's full timeline /
   risk panel before claiming no longer requires bouncing back
   to the dashboard.

All five land behind the existing chain-keyed dashboard fetch
paths — no contract changes, no ABI re-export needed.

## Outstanding for the testnet redeploy gate

Before fresh testnet diamonds can land:

1. **OfferFacet split for EIP-170** — already shipped earlier
   today. Closed.
2. **Frontend env sync runbook** — shipped above as
   `contracts/script/syncFrontendEnv.sh`. Closed.

The redeploy gate is now clear.

## Documentation convention

Same as carried forward from prior files: every completed phase
gets a functional, plain-English write-up under
`docs/ReleaseNotes/ReleaseNotes-…md`. No code. Function names,
tables, and exact selectors live in the codebase; this file
describes behaviour to a non-engineer reader (auditor, partner
team, regulator).
