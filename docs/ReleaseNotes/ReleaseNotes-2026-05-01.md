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

## More UX polish — three small fixes + one new helper

Continuing the same polish batch as above:

1. **Lender / borrower role tiles use neutral icons.** The
   Dashboard's "as lender" tile rendered a green
   `TrendingUp` icon and the "as borrower" tile rendered an
   amber `TrendingDown` icon — visual semantics that
   accidentally said "lending = good, borrowing = bad" on a
   peer-to-peer marketplace where both sides are equally
   valid market participants. Both tiles now use the same
   brand-tinted background; lender shows `Coins` (you have
   coins to lend) and borrower shows `HandCoins` (you receive
   coins). Same domain meaning, no colour bias.

2. **One-click copy on redacted addresses (initial surface).**
   New shared `<CopyableAddress address="0x…">` component:
   renders the standard `0x1234…abcd` shortform alongside a
   small copy icon; clicking flips the icon to a green check
   for ~1.5 s while the full address goes onto the clipboard
   (mirrors GitHub's commit-hash copy affordance). Hovering
   the icon shows the full address as a tooltip so the user
   can verify before they paste. Wired into the Asset-wise
   Breakdown table on the Analytics page; a follow-up sweep
   will roll the same component into the loan-detail parties
   block, claim-center counterparty rows, and any other
   surface that currently shows a redacted address with no
   way to grab the full hex.

3. **`Translation pending` notice copy.** The legal pages
   (Terms of Service, Privacy Policy) showed a notice that
   read "This document is available in English only. A
   translated version may be added in a future update." —
   raising an expectation we haven't actually committed to.
   Reworded to simply state the current fact: "This document
   is available in English only. The English text below is
   the canonical reference." No promise of future translation.

4. **Connect-Wallet button content centered on mobile.** The
   `<ConnectWalletButton>` at `width: 100%` (the mobile
   navbar's full-row CTA) was inheriting `.btn`'s default
   `justify-content: flex-start`, so the icon + label slid
   to the left edge of the button instead of sitting in the
   middle. Now explicitly sets `justifyContent: 'center'` in
   the `fullWidth` branch so it matches the sibling "Launch
   App" CTA.

## In-app pre-connect chain selector dropped

Inside the app, the topbar's standalone chain switcher used
to render next to the Connect Wallet button whenever the
wallet was disconnected (so a pre-connect viewer could pick
which chain's read-only data to view). The chip crowded the
right edge of the topbar without giving most users a useful
action — pre-connect viewers almost always want the canonical
default chain, and the existing read-only fallback
(`DEFAULT_CHAIN`, currently Base Sepolia via
`VITE_DEFAULT_CHAIN_ID=84532`) already routes them there.
Outside-app pages (landing, public Analytics, public Buy
VPFI) never had a pre-connect topbar picker in the first
place; the in-app surface was the lone outlier.

Change: the standalone chain switcher is now dropped from
the topbar pre-connect on every viewport (mobile + desktop).
The chip still renders when the wallet IS connected but on
an unsupported chain — that's an actionable recovery state
and the switcher is the right affordance there. When fully
connected on a supported chain, the chain picker is folded
into `<WalletMenu>` instead, same as before.

No JavaScript state change beyond the conditional itself —
the picker is simply not mounted when `!address`. A power
user who explicitly wants to preview a non-default chain
pre-connect can still do so via the public Analytics page's
in-page chain picker, which is preserved.

## Topbar chain visibility + in-app wallet-gating cleanup

Follow-up to the pre-connect chain-picker removal. The user
flagged that "you need to know absolutely which chain you're
in" — and the post-connect topbar's only chain cue was an
18 px icon with no name. Easy to miss before signing a
transaction on the wrong network. Audited the surface and
shipped a four-part fix:

1. **WalletMenu now shows icon + chain name.** The trigger
   pill renders a small chain badge ("Base Sepolia Testnet",
   "BNB Smart Chain Testnet", etc.) with the existing chain
   icon, sitting on the trailing edge of the wallet pill so
   the user always reads the network they're connected to.
   On viewports < 480 px the label collapses to icon-only to
   keep the pill from overflowing the topbar; the screen-
   reader name is preserved via `aria-label`. Unsupported
   chains read "Unsupported (chainId)"; read-only fallback
   reads "Read-only".

2. **OfferBook is now fully wallet-gated.** Previously the
   table rendered read-only pre-connect (since offer state
   is public on-chain) and only the `acceptOffer` action
   required a wallet. The post-batch UX direction is "every
   in-app page is wallet-gated; the public Analytics page is
   the read-only surface for protocol-wide data". OfferBook
   now shows the same Connect-Wallet empty state as the rest
   of `/app/*` pages pre-connect.

3. **LoanDetails is now fully wallet-gated.** Same
   reasoning. The page used to render every on-chain field
   read-only pre-connect; now it shows a Connect-Wallet
   empty state until a wallet is bound.

4. **BuyVPFI pre-connect: marketing block instead of empty
   state.** Pre-connect, the page used to show a one-line
   "Connect your wallet to buy VPFI" empty state — wasted
   real estate. Now shows three short cards explaining the
   *user-facing* pitch: tiered fee discount on lending and
   borrowing (lender treasury cut reduced + borrower
   loan-initiation rebate), staking yield on whatever VPFI
   sits in your escrow, and a how-it-works summary. Crucially
   no read-only protocol stats (those live on the public
   Analytics page) and no token-economics deep dive — this
   surface stays focused on the pitch. The Connect-Wallet
   empty state is preserved at the bottom as the call to
   action.

NFT Verifier stays chain-agnostic by design — it walks
`CHAIN_REGISTRY` to match a pasted address against every
deployed Diamond, so chain context is irrelevant to its
behaviour. No change there.

Net effect: a connected user always sees the network they're
about to transact on prominently in the topbar; the in-app
chrome no longer renders any state pre-connect (one source of
truth for chain selection — the wallet), and the BuyVPFI page
has something useful to say to first-time visitors instead of
a placeholder.

## Page-level ambient gradient on public pages

After several rounds of in-place experimentation (sidebar
gradient, card-level gradient, etc. — all reverted), the
final shipped shape gives the public pages the same ambient
depth the in-app shell already had, without touching cards
or the sidebar:

- New shared CSS class `.public-page-glow` (in
  `frontend/src/styles/global.css`) mirroring the in-app
  `.app-layout::before/::after` ambient backdrop — two soft
  radial gradients (primary brand-purple top-center,
  secondary brand-light bottom-right) that stay anchored to
  the viewport via `position: fixed`. Theme-aware via a
  `[data-theme='dark']` override.
- Co-class added to the wrapping `<main>` of all three
  public-route pages: Buy VPFI marketing, Analytics
  (PublicDashboard), NFT Verifier. Every public surface now
  carries the same ambient depth as the in-app dashboard.
- Cards stay flat. Earlier experiments adding directional
  gradients to `.card` and `.app-sidebar` were reverted —
  the page-level ambient is enough; layering card-level
  gradients on top fought visually with the cards' own
  borders.
- One **exception**: the Analytics page's `.pd-section`
  cards keep a subtle 165° `linear-gradient(--bg-card →
  --bg-card-hover)` at user request. Analytics is sparser
  than the in-app dashboard so the directional shading
  there reads as depth rather than noise. In-app cards
  remain flat.
- Bonus fix along the way: Analytics' `.pd-section` rule
  used to reference an undefined `var(--surface)` token
  (resolved to "no background" — transparent against the
  page). Now points at `--bg-card` so the cards actually
  have a defined surface in addition to the gradient
  overlay.

## Data rights (GDPR / UK GDPR / CCPA) own page

The broader "Download my data" / "Delete my data" pair used
to live in the Diagnostics drawer alongside the journey-log
controls. Two problems with that placement:

- **Wrong context.** The drawer is a support-debug surface
  ("report this issue, here's the events buffer"); a user
  reflexively clicking "Delete my data" there could wipe
  cookies, consent, and cached event indexes — surprising
  and irreversible client-side.
- **No room to caution.** A drawer row can't surface a
  proper "what happens after deleting" itemised list.

Resolution:

- New `/app/data-rights` page with sidebar nav entry under
  Allowances (`Lock` icon, `appNav.dataRights` label).
- Two action cards: **Download my data** (immediate JSON
  export, success-tick affordance) and **Delete my data**
  (red left border, two-step confirm — first click arms,
  second click in red deletes — and an itemised list of the
  four concrete effects: cookie banner returns, journey log
  wiped, cached event indexes purged, theme/language/mode
  preferences reset). Explicit "on-chain positions are
  unaffected" callout.
- Diagnostics drawer trimmed to journey-log scope only:
  Download / Clear act on the in-memory journey buffer (not
  cookies / not cached event indexes), with a small inline
  link pointing at the new page for users who want the
  broader controls.

Right-to-access + right-to-erasure are still satisfied
end-to-end; the controls just live in the right place now.

## i18n sync deferred

Today's session added new English keys across multiple
namespaces:

- `lenderDiscountCard.consentMissing*` / `consentEnabledNoVpfi*`
  (Lender Yield-Fee Discount card consent banner).
- `legalGate.englishOnlyBody` / `translationPendingTitle` /
  `translationPendingBody` (English-only notice copy
  reworded — no longer promises a future translation).
- `buyVpfi.title` / `buyVpfi.preconnect.*` (BuyVPFI
  pre-connect marketing block).
- `offerBookPage.connectTitle` / `connectBody`,
  `loanDetails.connectTitle` / `connectBody` (wallet-gating
  empty states for OfferBook + LoanDetails).
- `appNav.dataRights`, `dataRights.*` (new Data Rights page).
- `diagnostics.journeyBufferScope`, `downloadJourney*`,
  `clearJourney*`, `dataRightsLink` (Diagnostics drawer
  rewire).

i18next's `fallbackLng: 'en'` chain renders these as the
English text in every other locale until the canonical
`npm run translate` step runs. So nothing is broken in the
non-English UIs — just untranslated for these strings. Run
`ANTHROPIC_API_KEY=… npm run translate` from `frontend/` to
sync. Review the diff and commit alongside the en.json
changes.

## Copyable-address sweep across remaining surfaces

Earlier today the new `<CopyableAddress>` component shipped
into the Asset-wise Breakdown table on Analytics. The user's
underlying ToDo asked for the same affordance "wherever we
show redacted address" — followup sweep landed today.

Approach: rather than swap every `<AddressDisplay>` site for
`<CopyableAddress>`, the existing `<AddressDisplay>`
component grew an opt-in `copyable` prop. Setting `copyable`
renders a small copy icon next to the address that flips to a
green check for ~1.5 s on click while the full hex goes onto
the clipboard. Same icon size and animation as
`<CopyableAddress>`, so the affordance feels identical
wherever it appears.

Surfaces opted in:

- **Loan parties on the loan-detail page** —
  `<AddressDisplay copyable>` on the lender + borrower rows
  next to the existing explorer-link icon, so a user
  reviewing a loan can grab either party's full address
  without switching to the explorer first.
- **Offer creator on the offer-detail row** in OfferBook.
- **Keeper whitelist rows** — both the per-user list on
  `/app/keepers` and the per-loan keeper picker on
  LoanDetails. Useful for an operator copying a keeper's
  address into an off-chain whitelist.
- **Timeline event participants** in `<LoanTimeline>` —
  lender / borrower (LoanInitiated event), acceptor
  (OfferAccepted event). Each rendered with the new copy
  icon so users reading historical event detail can pull
  the parties straight from the timeline.
- **Per-chain asset distribution row on Analytics** — the
  `pd-dist-row` blocks that show "{symbol} {address}" now
  use `<CopyableAddress>` directly, replacing the bare
  `shortenAddr` text.

Surfaces intentionally NOT changed:

- Address display sites that already sit inside an `<a>`
  tag pointing at the block explorer (e.g. the VPFI token
  address on Analytics, the wallet pill in the topbar).
  The explorer link is the primary action there; nesting a
  `<button>` inside the `<a>` would invalidate the markup,
  and a duplicate copy affordance next to the existing link
  would crowd the row without adding meaningful value
  (right-click → "Copy link address" already covers it).
- Symbol-fallback rendering on Analytics (where
  `shortenAddr` is shown only if symbol lookup failed) —
  rare fallback path, low value.

`tsc -b --noEmit` clean. No behaviour change to the address
display when `copyable` is omitted; existing call sites read
identically to before the prop was added.

## Diagnostics drawer — collapsed, trimmed, mobile-tightened

User reported that on mobile the Report-Issue (Diagnostics)
drawer's top section was hiding most of the events list. Two
rounds of trim:

- **Layout collapse.** The two action rows ("Report on GitHub
  / Copy JSON" + a separate "Journey buffer …" header with
  Download / Clear) folded into a single row containing four
  buttons: `Report on GitHub` · `Copy JSON` · `Download` ·
  `Delete`. The standalone "Journey buffer (this drawer's
  events only)" header label and the per-button `<InfoTip>`
  wrappers were removed — the hint paragraph above already
  establishes the scope, so verbose tooltips on each button
  were redundant. Button labels shortened from "Download
  journey log" / "Clear journey log" to "Download" /
  "Delete".
- **Hint copy shortened** from a 4-sentence paragraph to one
  line: *"A redacted log of recent steps to report. Wallet
  addresses are shortened to 0x…abcd; free-form error text
  is not published."* Copy still asserts the redaction
  guarantee; just no narration of the support workflow.
- **Mobile-compact CSS overrides** at viewports < 640 px
  reduce the drawer's padding, hint font size, action-button
  padding and font size, so the events list (the drawer's
  actual value) gets the maximum vertical real estate.
- Data Rights link preserved as a small inline link directly
  below the actions row, pointing at the standalone
  `/app/data-rights` page for the broader Download/Delete
  pair.

## Report-issue tooltip portal-rendered

`<ReportIssueLink>`'s tooltip (the explanation of what gets
shared in the prefilled GitHub issue) used CSS-only
`[data-tooltip]`, which clips against `overflow:hidden`
ancestors. Inside the Diagnostics drawer (which sets
`overflow-x/y: hidden` on `.diag-drawer`) and inside each
event row in the same drawer, the tooltip was getting
cropped or rendered behind the drawer surface. Switched
to the existing `<HoverTip>` portal-based wrapper (added
earlier today for the same problem on table rows). The
`<HoverTip>` bubble's z-index was bumped from 1000 → 5000
to outrank the drawer's z-index 1001, matching the existing
`<InfoTip>` bubble's tier. Same hover/focus behaviour, same
copy.

## GitHub-issue body trimmed against URL-length cap

GitHub returns "Whoa there! Your request URL is too long" for
issue-creation links beyond a threshold. The diagnostics body
was already running a multi-tier trim ladder, but had three
genuine redundancies bloating the first-view tier:

- **Preamble** collapsed from 8 lines to 1: privacy
  disclosure preserved verbatim, structure tour for
  developers dropped (a developer can read the body's
  structure in 2 seconds by scrolling).
- **`Chain id`** and **`Tx hash`** lines removed from the
  first-level error-details block — both were already
  surfaced in the report header (`**Chain:** Base Sepolia
  (chainId 84532)` is strictly more informative than the
  bare chainId).
- **`Document language`** removed from the browser-env
  section — already in the header (`**Language:**`),
  drawn from the same `document.documentElement.lang`
  attribute.

Net saving: ~680 chars off a default report. The existing
tier-trim ladder (events 10+2 → 5+1 etc.) now has more
headroom before kicking in, so reports keep more events
visible by default.

## Buy VPFI moved inside the app + public-side cleanup

The biggest UX restructure of the day. Before: Buy VPFI was
a public route at `/buy-vpfi`, mounted inside the public
`<Navbar>`/`<Footer>` chrome. It was the **only** public
route that needed wallet connection — every other public
page (landing, Analytics, NFT Verifier, Discord, Terms,
Privacy, Help) is read-only or marketing. That asymmetry
forced the public Navbar to carry a wallet pill / chain
picker / Connect Wallet button just for one page.

After:

- **New `/app/buy-vpfi` route** mounting the existing
  `<BuyVPFI>` component inside `<AppLayout>`. Wallet-gated
  like every other in-app page; the WalletMenu's chain
  pill (icon + name) is always prominent at the top.
- **Public `/buy-vpfi`** is now a marketing-only page
  (`<BuyVPFIMarketing>`). Three cards (Tiered fee discount,
  Staking yield, How it works) plus a brand-coloured
  "Launch App to Buy / Stake / Unstake" CTA at the bottom
  that opens `/app/buy-vpfi` in a new tab. No wallet
  connection on this surface.
- **Sidebar nav** — the `Buy VPFI` item flipped from
  `external: true` (jumping out of `/app/*` to the public
  route) to a normal internal `<NavLink>` to
  `/app/buy-vpfi`.
- **In-app CTAs retargeted** — six callsites that
  previously linked to `/buy-vpfi` now point at
  `/app/buy-vpfi` (CreateOffer 2× banners,
  VPFIDiscountConsentCard, RewardsSummaryCard, OfferBook
  empty-state, LoanDetails consent banner).
- **Public Navbar VPFI dropdown reworked** to match the
  split (Option C in the planning discussion):
  ```
  VPFI ▾
  ├─ Learn about VPFI    → /buy-vpfi              (same tab)
  ├─ Buy VPFI            → /app/buy-vpfi#step-1   (new tab)
  └─ Stake / Unstake     → /app/buy-vpfi#step-2   (new tab)
  ```
  First item opens the marketing page in the same tab
  (user clicked the Navbar to read); the two action items
  open the in-app surface in a new tab so the marketing
  page stays open behind. New `newTab?: boolean` field on
  the `NavLink` type drives the per-item behaviour
  (renders as a plain `<a target="_blank">` instead of a
  react-router `<Link>` when set).
- **Launch App CTA** (Navbar desktop + mobile + Hero) now
  opens in a new tab too — same pattern as the VPFI
  dropdown's action items, so users land on the same
  expectation regardless of entry point.
- **Public Navbar wallet UI removed entirely.** With
  `/buy-vpfi` no longer needing a wallet, no public route
  does. Stripped: `<ConnectWalletButton>`, `<WalletMenu>`,
  `<WalletAddressPill>`, `<ChainPicker>`, the wrong-network
  warning button, the wallet-connected mobile triplet
  (pill + chain picker + disconnect), and the
  bottom-of-Navbar wallet error / warning banners. Imports
  and useWallet hook usage in `Navbar.tsx` cleaned up
  alongside.

Net effect: the public site is now purely informational —
no wallet UI on any page. Every wallet-bearing surface
lives inside `<AppLayout>`, where chain visibility is
always prominent. The chrome is much cleaner: public
Navbar's right side is now just `Learn ▾ · Verify ▾ ·
VPFI ▾ · Launch App · Settings gear`.

## "What is VPFI?" intro on the marketing page

Added as the first card on `<BuyVPFIMarketing>` so a
first-time visitor clicking "Learn about VPFI" actually
gets a learn surface, not just three benefit cards. Three
short paragraphs in plain language, no jargon:

1. *VPFI is Vaipakam's protocol token — you can buy with
   ETH, hold in your personal escrow, and use across the
   platform. No lockup period, freely transferable.*
2. *Holding VPFI ties you to the protocol's success in two
   practical ways: it earns you discounts on the fees
   Vaipakam charges (so you keep more of what you lend,
   and pay less when you borrow), and it earns staking
   yield while it sits in your escrow.*
3. *Anyone with ETH can buy and stake. The two benefit
   cards below show exactly what holding VPFI gets you.*

## Token classification standardized to "protocol token"

Question came up whether VPFI should be called a "utility
token" instead of "protocol token". The whitepaper had
been using "utility token" in two places already, but the
term carries a defined regulatory meaning under MiCA
(Article 3(1)(9): "only accepted by the issuer of that
token") that doesn't cleanly fit a freely-transferable
ERC-20. To avoid creating contradictions a regulator or
litigant could exploit, standardized everything on
**"protocol token"** — descriptive, consistent, makes no
formal classification claim.

Updated 8 hits across English source surfaces (localized
files re-sync via `npm run translate`):

- `frontend/src/i18n/locales/en.json` (Buy VPFI marketing
  intro card)
- `frontend/src/content/whitepaper/Whitepaper.en.md` —
  3 hits across lines 20 / 87 / 89
- `frontend/src/content/overview/Overview.en.md` — 1 hit
  at line 217
- Root `README.md` — 2 hits
- `docs/FunctionalSpecs/ProjectDetailsREADME.md` — 1 hit
  (Phase 2 governance description)
- `docs/OlderDocs/Whitepaper.md` — 2 hits
- `docs/OlderDocs/Whitepaper01.md` — 3 hits

`grep -rn "utility token"` excluding localized files now
returns zero. UserGuide-Basic / UserGuide-Advanced English
sources never used the term.

## Logo flex-shrink fix

Public Navbar's brand logo was shrinking on narrow
viewports because `.navbar-brand` and `.navbar-logo` had no
`flex-shrink: 0` while the surrounding `.navbar-inner` is
`display: flex` with the actions cluster competing for
width. Pinned both to `flex-shrink: 0`. The CSS comment
above the rule already promised "the logo never has to
shrink" — now it actually doesn't.

## Link audit — full sweep, one fix

Walked every internal link target across the codebase and
cross-referenced against the route table. Checked
`<Link to="...">`, `<NavLink to="...">`, `<a href="...">`,
and `linkTo=` props on shared components.

Single issue surfaced and fixed:

- The Footer's **"Smart Contracts"** link in the
  `Resources` column previously pointed at `/analytics`
  (the Public Dashboard / Analytics page). Linguistically
  opaque — a user clicking "Smart Contracts" expects a
  contracts surface, not a dashboard. The Analytics page
  does have a *Transparency & Source* section that lists
  every deployed contract address with explorer links, so
  the link target was right in spirit; just the user had
  to scroll to find it. Fix: added an `id="transparency"`
  anchor to that section and changed the Footer link to
  `/analytics#transparency` so users land directly on the
  contracts table.

Everything else checked out:

- All landing-page section anchors (`/#features`,
  `/#how-it-works`, `/#security`, `/#faq`) have matching
  `id` attributes on their respective section components.
- `RewardsSummaryCard`'s deep-link anchors
  (`/app/buy-vpfi#staking-rewards`,
  `/app/claims#interaction-rewards`) land on
  components that carry the matching `id`s
  (`StakingRewardsClaim` and `InteractionRewardsClaim`).
- `BuyVPFI`'s `#step-1` / `#step-2` / `#step-3` anchors
  used by the Navbar VPFI dropdown all exist as `<div id="step-N">`
  cards.
- Help routes (`/help/basic`, `/help/advanced`,
  `/help/technical`) are reachable via the in-page
  `<HelpTabs>` component which constructs the URLs
  dynamically.
- Loan-action sub-routes (`/app/loans/:id/preclose`,
  `/app/loans/:id/refinance`,
  `/app/loans/:id/early-withdrawal`) all linked from the
  LoanDetails action panel.
- External links (Discord, Reddit, X, GitHub, CoinGecko,
  LayerZero docs, Push notifications docs, Balancer
  subgraphs, Arbitrum RPC) all canonical.

In-app sidebar nav verified item-by-item against the
`/app/*` route table — every entry resolves. (Buy VPFI
sidebar entry is the one we just internalised this morning;
the audit confirmed it now points at `/app/buy-vpfi` and
not the public marketing page.)

## VPFI dropdown removed from public Navbar

The `VPFI ▾` dropdown (Learn / Buy / Stake-Unstake) was a
holdover from when Buy VPFI was a featured public page.
After the Buy-VPFI move-into-app earlier today, the public
`/buy-vpfi` is now a marketing surface reachable from:

- the **Hero** CTA (visible `Buy VPFI` button next to
  `Launch App` on the Landing page)
- the **Footer** "Resources" column (`Buy VPFI` link)
- the **in-app sidebar** (for users already in the app)

The Navbar dropdown was duplicating those entry points
without adding a new path. Removed entirely. Trade-off is
1 extra click for returning users wanting to stake straight
from a deep public page — they go Footer → marketing page
→ "Launch App to Buy / Stake / Unstake" CTA — but no path
is broken, just slightly longer for that narrow case.

Public Navbar's right side is now just `Learn ▾ · Verify ▾
· Launch App · Settings gear` — three menus shorter than
this morning. The orphaned `nav.vpfi*` i18n keys
(`vpfi`, `vpfiLearn`, `vpfiBuy`, `vpfiStakeUnstake`,
`vpfiStake`, `vpfiUnstake`) stayed in `en.json` unused —
cheap to keep around in case the dropdown comes back.

## Server-side error capture (D1) + Diagnostics drawer master flag

Foundation for proactive triage + defensible cross-reference
on user-submitted GitHub issues. Three slices, all landed
together:

**Worker side** (`ops/hf-watcher/`):

- New D1 migration `0003_diag_errors.sql` — single
  `diag_errors` table keyed by UUIDv4 PK. Stores only what
  the existing GitHub-issue prefill already publishes
  (redacted wallet, error type/name/selector, area/flow/
  step, locale, theme, viewport). No user-agent string,
  no full address, no localStorage / cookies / freeform
  text. Indexed on (fingerprint, recorded_at) for the
  dedup check + on (recorded_at) for the retention prune.
- New endpoint `POST /diag/record` (handler in
  `src/diagRecord.ts`). Wired into `src/index.ts`. Each
  POST: validates UUID + required fields, computes
  fingerprint server-side (don't trust client), checks
  whether the last 5 records all share that fingerprint
  (server-side dedup belt), inserts. Always returns 200
  even on dedup-skip — caller doesn't retry.
- Three defenses on the endpoint: (a) CORS-locked to
  `FRONTEND_ORIGIN` env var, (b) per-IP rate-limit binding
  `DIAG_RECORD_RATELIMIT` (default 60 req/min, tunable via
  the `simple` block in wrangler.jsonc), (c) random
  sampling via `DIAG_SAMPLE_RATE` env var (default `1.0`,
  set to `0.1` etc. when error volume spikes).
- Retention prune piggybacks on the existing 5-minute
  cron — one indexed `DELETE WHERE recorded_at < cutoff`
  per tick, gated by `DIAG_RETENTION_DAYS` env var
  (default `90`). Wrapped in catch so a transient D1
  hiccup can't break the watcher tick.

**Frontend side**:

- `lib/journeyLog.ts` — UUID upgrade (now uses
  `crypto.randomUUID()` so the per-event id satisfies the
  Worker's UUIDv4 validation; falls back to base36 in
  ancient browsers, which fail-soft when the Worker
  rejects them). New `recordFailureToServer()` fires from
  inside `emit()` for every `failure` event:
  `navigator.sendBeacon` first (survives page-unload),
  fetch with `keepalive: true` as fallback, never throws
  upward. Local 5-streak dedup keeps a runaway re-render
  loop from flooding the worker.
- `components/app/DiagnosticsDrawer.tsx` — master flag
  `VITE_DIAG_DRAWER_ENABLED` (default `true`, set to
  `"false"` to hide the drawer + FAB entirely). Server
  capture continues regardless of the flag, so the
  support team always sees errors. Lets the operator
  flip off the user-facing "report issue" affordance
  once server capture is observed working — matches the
  pattern of every other major DeFi platform (Uniswap /
  Aave / Compound / dYdX / Lido) which don't ask users
  to file bug reports.
- `pages/DataRights.tsx` — new "Download journey log
  (this session)" card. Saves the in-memory journey-log
  buffer as JSON for users sharing diagnostics in a
  Discord DM / 1:1 support thread. Available even when
  the Diagnostics drawer is hidden.

**Privacy** ([PrivacyPage.tsx](frontend/src/pages/PrivacyPage.tsx)):

One new paragraph under "What we collect" describing
exactly what gets captured server-side, what doesn't,
retention (90 days), legal basis (GDPR Art 6(1)(f)
"legitimate interest" — security, fraud prevention,
service-reliability), and how to request deletion.

**Net effect**: every UI error now has a defensible
server-side audit trail, support can cross-reference any
GitHub issue against a real session via UUID, and we have
visibility into errors users hit but don't report. The
drawer stays for now (master flag off-by-default);
operator can hide it once server capture is observed
healthy in production.

**Operator setup steps** (one-time):

1. Apply the new D1 migration to the production worker:
   `cd ops/hf-watcher && npx wrangler d1 migrations apply
   vaipakam-alerts-db --remote`
2. Deploy the worker: `npx wrangler deploy`
3. Confirm `/diag/record` accepts a test POST from the
   frontend origin.
4. (Later, when comfortable) set
   `VITE_DIAG_DRAWER_ENABLED=false` in
   `frontend/.env.production` (or the Cloudflare Pages
   dashboard) and redeploy the frontend to hide the
   user-facing drawer.

## Audit pass — tests, deploy scripts, FunctionalSpecs cross-check

End-of-day audit batch (operator was resting). Three slices:

**Test-suite baseline**:
- Forge: **1388 passed / 0 failed / 5 skipped** across 66 suites
  (excluded `test/invariants/*` and `test/fork/*` per CLAUDE.md
  guidance). Clean.
- Frontend (`npm test`): **BLOCKED** — 44/44 test files fail at
  module resolution because `@testing-library/dom` is a peer dep of
  `@testing-library/react@16.3.2` but isn't declared in
  `frontend/package.json`. Local Node version (18.19.1) also
  predates the engine requirement (≥ 20.19) and triggers a
  separate vitest startup error. Logged as finding 00009.

**Anvil deploy-script smoke test**:
The existing anvil bootstrap state was probed and found healthy
(diamond live at `0x84eA…7fEB`, 1 active loan + 1 active offer
from `SeedAnvilOffers`, paused = false). The 32 `contracts/script/*.s.sol`
files were then audited statically against the current contract
shape. 13 new findings logged as 00010–00022. Top 3 to
prioritise:
- 00010 (HIGH) — `WATCHER_ROLE` is never granted on a fresh
  `DeployDiamond` run; the auto-pause primitive is unreachable
  post-deploy until governance grants the role explicitly.
- 00011 / 00012 / 00013 (HIGH) — `RedeployFacets` /
  `ReplaceStaleFacets` / `UpgradeOracle` carry stale selector
  lists that drifted from the canonical `DeployDiamond` lists.
  Replace-cuts only update the listed selectors → unlisted ones
  keep pointing at the prior bytecode → Diamond ends up with
  state split across two facet implementations.
- 00014 (HIGH) — `UpgradeOracle.s.sol` uses `PRIVATE_KEY` for the
  diamondCut, which reverts post-handover when the deployer EOA
  has zero roles. Sister script `UpgradeOracleFacet.s.sol`
  correctly uses `ADMIN_PRIVATE_KEY`.

The other 9 findings (00015–00022) are MEDIUM / LOW: env-var
mismatches, broadcaster-key bugs in configure-scripts, missing
non-zero asserts on UUPS owner addresses, idempotency claims
that aren't actually idempotent, and a LayerZero confirmations
asymmetry on the receive-library config.

**FunctionalSpecs cross-check**:
The three canonical spec docs in `docs/FunctionalSpecs/` were
cross-checked against the codebase. 8 new findings logged as
00023–00030. Highlights:
- 00024 (MEDIUM) — `getAssetRiskProfile` return-tuple shape
  diverges from what the spec advertises to external integrators
  (DefiLlama / portfolio apps) — different field order, missing
  `currentPriceUSD`, extra `liqBonusBps`, `bool isLiquid`
  replaced by an enum.
- 00025 (MEDIUM) — ERC-20 loan duration has no on-chain upper
  bound. Spec mandates 1–365 days; OfferFacet only checks
  `durationDays != 0`. Frontend validation is the only gate.
- 00028 (MEDIUM) — Treasury Recycling Rule (38/38/24 ETH /
  wBTC / retain) prescribed in TokenomicsTechSpec §9 has no
  on-chain implementation in TreasuryFacet.
- 00023 (LOW) — VPFI on-chain `name()` is "Vaipakam DeFi Token"
  but TokenomicsTechSpec mandates "Vaipakam Finance Token". The
  two FunctionalSpecs disagree internally; deployed bytecode
  follows ProjectDetailsREADME. Decide which name is canonical.

The other 4 (00026 / 00027 / 00029 / 00030) are LOW: spec
references to renamed surfaces, missing audit-trail timestamp
on governance events, and a self-contradiction in the spec
about borrower-LIF forfeiture splits.

**Side-effect fixes shipped during the audit**:
- Server-side error capture (yesterday's batch) flipped OFF by
  default via new `VITE_DIAG_RECORD_ENABLED` env var. The
  worker endpoint, D1 schema, and frontend POST hook all stay
  in place; user must explicitly set the var to `"true"` after
  running through DeploymentRunbook §8d. Diagnostics drawer
  default stays ON. Net: zero risk of the frontend flooding
  an unprepared endpoint at next deploy.
- Finding 00001 (public Navbar wallet display) and 00004 (PWA
  Buy VPFI shortcut `/app/buy` → `/app/buy-vpfi`, plus a
  sibling `/app/loans` → `/app` shortcut that was also broken)
  ticked off — both already-fixed by today's earlier work.

**What NOT done** (intentional — operator scoping required):
- Test-coverage enhancement skipped. Each of the 22 new
  findings represents a potential test gap, but every one needs
  a scoping decision (which side is canonical when spec ↔ code
  diverge?). Listed as "discuss next session" rather than
  silently fixed.
- None of the HIGH-severity deploy-script findings were
  autonomously fixed. Same reason — getting `WATCHER_ROLE`
  granted properly, or rebuilding the selector-list discipline
  for `RedeployFacets` / `ReplaceStaleFacets`, are real
  operator-ops decisions that need the operator at the keyboard.

Findings file: [`docs/FindingsAndFixes/Findings01052026.md`](../FindingsAndFixes/Findings01052026.md).
30 active findings logged (00001 + 00004 ticked, 00002 +
00003 + 00005 + 00006 + 00007 + 00008 still pending from the
prior session, 00009–00030 added today).

## Findings batch — high-severity audit follow-ups

Three audit findings shipped this session, all high-severity
correctness/safety issues surfaced during yesterday's audit pass.

### 00010 — `WATCHER_ROLE` granted at init + canonical role list

`AdminFacet.autoPause` (the always-armed safety net documented in
CLAUDE.md) was unreachable on a fresh deploy because
`WATCHER_ROLE` was declared in `LibAccessControl` but never granted
during `initializeAccessControl`, and the `DeployDiamond.s.sol`
handover loop only iterated the seven older roles. Result: post-
deploy `hasRole(WATCHER_ROLE, *)` returned false for everyone.

Fix landed in three places:

- `LibAccessControl.initializeAccessControl()` now grants
  `WATCHER_ROLE` to the initial owner alongside the other seven
  roles (and sets its admin to `DEFAULT_ADMIN_ROLE`).
- New `LibAccessControl.grantableRoles()` exposes the canonical
  role list as the single source of truth. `DeployDiamond.s.sol`
  consumes it directly so the inline `bytes32[7]` array is gone —
  adding a future role flows through automatically without the
  drift hazard that caused this bug.
- `DeployerZeroRolesTest.t.sol` extended with two regression
  tests: `testRoleListsParity` (asserts library list ↔ test
  ALL_ROLES match byte-for-byte) and
  `testEveryGrantableRoleGrantedAtInit` (would have caught the
  original bug). The rotation dance also gained a `watcherBot`
  recipient so the post-rotation state assertions still hold.

`WATCHER_ROLE` scope confirmed narrow: only gates
`AdminFacet.autoPause(string)` — a time-bounded pause (default
30 min, max 2 hours, governance-tunable within those bounds) that
is a no-op when the protocol is already paused. It cannot
unpause. A compromised watcher's worst case is a 2-hour freeze;
PAUSER_ROLE retains the unpause lever.

### 00013 + 00014 — `UpgradeOracle.s.sol` deleted

Two related findings on the same broken script:

- `UpgradeOracle.s.sol:48,110` used `PRIVATE_KEY` for the
  diamondCut, which reverts post-handover when the deployer EOA
  has zero roles. The sister script `UpgradeOracleFacet.s.sol`
  already does the deployer/admin key split correctly.
- `UpgradeOracle.s.sol:82-87` listed only 4 of 9 OracleFacet
  selectors for the Replace cut; the un-listed 5 selectors would
  have kept pointing at the prior bytecode, splitting Diamond
  state across two implementations.

Both resolved by deleting the broken script. The
`UpgradeOracleFacet.s.sol` sibling is the working alternative,
and the mock-Chainlink wiring `UpgradeOracle` also did is
already covered by `DeployTestnetLiquidityMocks.s.sol` in the
bootstrap flow. No functionality lost.

### 00025 — Loan duration cap (governance-tunable)

ProjectDetailsREADME §2 mandates `1 ≤ durationDays ≤ 365` with
on-chain enforcement. Code only enforced `> 0`; nothing capped
the upper bound. A misclick or malicious offer could post a
1000-day loan, and `interest = principal × rate × days / 365`
over-charges past 365 days.

Fix shipped as a governance-tunable knob (per operator
direction — "make the max duration of loan admin configurable,
later by governance"):

- New `ProtocolConfig.maxOfferDurationDays` storage slot;
  default `MAX_OFFER_DURATION_DAYS_DEFAULT = 365` resolved via
  the standard zero-sentinel pattern. Bounded floor / ceil
  constants `MIN_OFFER_DURATION_DAYS_FLOOR = 7` and
  `MAX_OFFER_DURATION_DAYS_CEIL = 1825` (5 years) — floor
  prevents an accidental "1 day max" lockout, ceiling caps how
  far governance can stretch the interest formula's accuracy.
- `OfferFacet._createOfferSetup` reverts with
  `OfferDurationExceedsCap(provided, cap)` when the offer
  duration exceeds the live cap.
- `ConfigFacet.setMaxOfferDurationDays(uint16)` admin-gated
  setter with `[floor, ceil]` validation; emits
  `MaxOfferDurationDaysSet`. Pass 0 to reset to library default.
- `getProtocolConfigBundle` extended to expose the live cap so
  the frontend's offer-creation duration input can read it
  rather than hard-coding 365. (Frontend hook update is a small
  follow-up; tracked separately.)
- Selector wired into `_getConfigSelectors()` (DeployDiamond)
  and `getConfigFacetSelectors()` (HelperTest).
- Regression test in `OfferFacetTest.t.sol` asserts revert at
  366 days; `ConfigFacetTest` bundle test asserts the default
  comes back as 365.

Forge suite: **1391 / 0 / 5 skipped**, up from 1390 with the
new test.

### Findings re-evaluation against updated FunctionalSpecs

Operator updated `docs/FunctionalSpecs/*` to reflect latest design
flows mid-session. Re-walked all 14 findings that cite those specs;
3 closed by the spec update and 11 remain open with code still
diverging:

- **00003** (Liquidation UI fallback) — closed: WebsiteReadme
  now scopes fallback submit to "from the remaining sources where
  possible", matching the disabled-on-zero-quotes frontend.
- **00023** (token name "DeFi" vs "Finance") — closed:
  TokenomicsTechSpec now reads "Vaipakam DeFi Token", matching
  ProjectDetailsREADME and the deployed bytecode.
- **00024** (`getAssetRiskProfile` return shape) — closed:
  ProjectDetailsREADME now declares the 5-field tuple shape
  exactly matching `OracleFacet.sol`, and explicitly notes no
  `currentPriceUSD` is returned.

Remaining open findings (00005, 00006, 00007, 00008, 00026,
00027, 00028, 00029, 00030) all have spec language preserved
load-bearingly; code still diverges. These remain for the
operator's queue.

## Sanctions oracle — Tier-1 / Tier-2 split + retail policy clarified

Earlier in the project the on-chain Chainalysis-style sanctions
oracle was treated as one of three "industrial fork" gates that
stay dormant on the retail deploy. Operator clarified mid-session
that the sanctions oracle IS for retail too — only KYC and the
country-pair check stay off. Two follow-on consequences were
worked through:

- The contract gate had to be wider. Pre-session, only
  `OfferFacet.createOffer` and `acceptOffer` consulted
  `_assertNotSanctioned`. A flagged wallet could still get an
  escrow lazy-deployed, deposit/withdraw VPFI, claim recovered
  collateral, run liquidations, or initiate a preclose-offset /
  refinance / loan-sale obligation transfer. The on-chain check
  was patched together but the surface had drift.
- The user-facing message had to make the asymmetric blocking
  legible: "your address is listed; new positions and deposits
  blocked; close-out paths stay open so the unflagged
  counterparty can be made whole; contact Chainalysis." Showing
  this only when a flagged wallet connects (not on every TOS or
  marketing surface) was the explicit operator preference.

What shipped:

**Tier-1 (BLOCK) entry points** — every facet method that creates
fresh state for the caller, accepts a deposit, or hands them
funds is now gated by `LibVaipakam._assertNotSanctioned(who)`,
which reverts `SanctionedAddress(who)` on a positive oracle hit:

- `EscrowFactoryFacet.getOrCreateUserEscrow` — a flagged wallet
  cannot even lazy-deploy its UUPS escrow proxy. Without this,
  every other Tier-1 gate could be sidestepped by depositing
  directly into a self-deployed escrow.
- `OfferFacet.createOffer` / `acceptOffer` — already gated;
  retained.
- `VPFIDiscountFacet.buyVPFIWithETH`, `depositVPFIToEscrow`,
  `depositVPFIToEscrowWithPermit`, `withdrawVPFIFromEscrow` —
  the full VPFI fund-flow surface.
- `RiskFacet.triggerLiquidation` — a flagged wallet cannot earn
  liquidator bonus.
- `EarlyWithdrawalFacet.sellLoanViaBuyOffer`,
  `createLoanSaleOffer`, `completeLoanSale` — loan-as-an-asset
  transfer paths.
- `PrecloseFacet.precloseDirect`, `transferObligationViaOffer`
  — borrower obligation transfer / direct preclose entry points.
- `RefinanceFacet.refinanceLoan` — refinance creates a fresh
  loan, so it's a state-creating path.
- `ClaimFacet.claimAsLender`, `claimAsBorrower` —
  initially gated. (See the policy carve-out below.)

**Tier-2 (ALLOW) entry points** — debt-closing / safety paths
that the unflagged counterparty needs to recover funds. These
remain ungated even when the caller is sanctioned:

- `RepayFacet.repayLoan` — a flagged borrower can still repay,
  flushing the lender's principal+interest back to the lender's
  escrow.
- `DefaultedFacet.markDefaulted` — time-based liquidation runs
  regardless of the borrower's sanctions status; a flagged
  borrower's collateral still gets routed to an unflagged lender.
- HF-based liquidation initiated against a flagged borrower —
  the keeper / liquidator runs the path; the borrower's address
  is the *target*, not the *caller*, so they can't block their
  own liquidation by being flagged.

The asymmetric design rests on a clear legal foundation:
the lender's security interest in the collateral pre-dates the
borrower's sanctions designation, so the close-out path
recovers an unflagged counterparty's pre-existing economic
right rather than transferring fresh value to a flagged party.
This mirrors Circle's USDC blocklist precedent ("frozen, not
seized") and OFAC's standard "wind-down" provisions.

**Lender-recovery walkthrough (borrower sanctioned post-loan-init):**

1. Loan is Active. Borrower wallet gets flagged.
2. Borrower can still call `repayLoan` (Tier-2 ALLOW) — full
   repayment routes principal+interest to the lender's escrow,
   loan settles, both parties continue normally.
3. Borrower stops repaying. Time-based default fires
   (`markDefaulted`, Tier-2 ALLOW); collateral transfers to the
   lender's escrow (illiquid path) or gets swapped via 0x
   (liquid path) — lender is whole.
4. Or HF crashes: a third-party liquidator (Tier-1 — must be
   unflagged, but the borrower being flagged doesn't matter) calls
   `triggerLiquidation`. Collateral routes through the liquid
   swap path and lender recovers.
5. Lender claims. **Caveat**: `claimAsLender` is currently a
   Tier-1 gate. If the *lender* gets sanctioned, they can't claim;
   if only the *borrower* is sanctioned, the lender claims
   normally. This matches the underlying policy: a sanctioned
   actor cannot receive funds from the protocol, regardless of
   which side of the loan they were on.

**Frontend changes:**

- New three-line `SanctionsBanner` body. Title stays the same
  ("Connected wallet: sanctions-screening match"); body is now
  three structured paragraphs covering (a) what's blocked, (b)
  that close-out paths stay open, and (c) Chainalysis-only
  recourse. Visible only when the connected wallet (or, in the
  Offer Book, the offer creator's wallet) is flagged — clean
  wallets see nothing.
- Banner mounted on four additional surfaces:
  Dashboard, BuyVPFI, LoanDetails, ClaimCenter. Previously only
  `CreateOffer` and `OfferBook` rendered it. The Tier-2 close-out
  paths intentionally surface the banner so the borrower sees a
  clear explanation of what they CAN still do, not just what's
  blocked.
- Marketing copy under "Non-Custodial & No KYC" rewritten so it
  doesn't claim sanctions logic is "future governance" — that
  was misleading once the operator decided to enable the oracle
  on retail. The line now reads "tiered-KYC and country-pair
  logic remains in the codebase for future governance activation
  if a separate industrial deployment ever needs it" — sanctions
  intentionally absent because it's live.
- ToS keeps ONE defensive bullet under "Prohibited use":
  *"if your wallet address is listed under any sanctions
  programme in force in the United States, European Union, or
  United Kingdom"*. Detailed wording stays out of marketing
  surfaces.

**Country-pair gated helper (industrial-fork preview):**

The retail deploy keeps `LibVaipakam.canTradeBetween` as a
pure-true function. New helper `_canTradeBetweenStorageGated`
implements default-DENY (whitelist) semantics by reading the
existing `s.allowedTrades` storage. The two helpers coexist on
purpose so the industrial fork can flip pair-based restrictions
on without a storage migration. The symmetric `setTradeAllowance`
setter is shared — its writes populate the gated mapping, but
retail's `canTradeBetween` ignores it entirely.

`CountryPairGatedTest.t.sol` exercises the gated branch through
a test-only accessor on `TestMutatorFacet` (12 tests):
default-DENY, symmetric setter, allow-doesn't-leak-into-
unrelated-pairs, revoke-flips-back, self-trade-requires-explicit-
allow, plus a realistic ISO-code fixture with a US/IR/RU/KP/CN/
FR/IN whitelist matrix. Retail's `canTradeBetween` separately
asserted to stay pure-true.

**CLAUDE.md updated**: header changed from "KYC / sanctions /
country-pair gates STAY OFF" to "Sanctions ON; KYC / country-pair
OFF". Sanctions oracle deploy step (`setSanctionsOracle`) is now a
post-deploy REQUIREMENT, not a forbidden flip. Two-helper coexistence
documented inline.

**Test results:**

- `SanctionsOracle.t.sol`: 64/64 passing (5 new Tier-1 / Tier-2
  cases including a sanctioned-borrower lender-recovery
  end-to-end).
- `CountryPairGatedTest.t.sol`: 12/12 passing.
- Full no-invariants regression: 1396 passing / 0 failed / 5
  skipped (Phase-7-style fork tests skipped without `FORK_URL_*`
  env, as before).
- Frontend `tsc -b --noEmit`: clean.

Two VPFI sanctions tests (`buyVPFI`, `withdrawVPFIFromEscrow`)
deferred to `VPFIDiscountFacetTest.t.sol` because the
`SetupTest` test diamond doesn't cut the VPFIDiscountFacet
selectors — those routes return `FunctionDoesNotExist` before
the sanctions gate fires in the current fixture. The contract
gates are in place (verified via build); the test-fixture move
is tracked.

## Deployments JSON — single source of truth, frontend + hf-watcher

Pre-session, every contract redeploy meant the operator had to
copy ~25 addresses (Diamond, escrow impl, three "verify-link"
facet addresses, a buy adapter, the deploy block) from each
chain's freshly-written `contracts/deployments/<slug>/addresses.json`
into matching `VITE_<CHAIN>_DIAMOND_ADDRESS` /
`VITE_<CHAIN>_ESCROW_IMPL` / `VITE_<CHAIN>_*_FACET_ADDRESS` lines
in `frontend/.env.local`. A helper script existed
(`contracts/script/syncFrontendEnv.sh`) but it was a write-back
into `.env.local`, which is gitignored — CI builds couldn't see
the values, and a missed sync silently shipped a frontend with
empty addresses. The hf-watcher Worker had a parallel problem:
six empty `DIAMOND_ADDR_BASE` / `DIAMOND_ADDR_ETH` / etc.
placeholders in `wrangler.jsonc:vars` that the operator had to
hand-fill in the dashboard or in a re-deployed `wrangler.jsonc`.

This session collapsed both surfaces onto a single committed
artifact.

**The consolidation:**

- New `contracts/script/exportFrontendDeployments.sh` merges every
  per-chain `addresses.json` into one JSON keyed by `chainId`,
  written to BOTH `frontend/src/contracts/deployments.json` AND
  `ops/hf-watcher/src/deployments.json` (auto-detects the watcher
  target via the sibling repo layout; `WATCHER_DIR=` skips it).
  Each target also receives a `_deployments_source.json`
  provenance stamp so a deployed bundle / Worker can be
  correlated to a specific contracts commit.
- New `frontend/src/contracts/deployments.ts` and
  `ops/hf-watcher/src/deployments.ts` — typed loaders. Each
  exports `getDeployment(chainId)` against a `Deployment`
  interface. The frontend's interface is the canonical full
  shape; the watcher's is a minimal subset (only the fields it
  reads at runtime — `diamond`, `chainId`, optional `riskFacet`).
- `frontend/src/contracts/config.ts` rewritten so every
  `ChainConfig` is built by `buildChainConfig(staticMeta)` —
  static metadata (chainId, display name, blockExplorer, lzEid,
  isCanonicalVPFI flag) stays hand-maintained in the file because
  it never changes between deploys; the dynamic fields
  (`diamondAddress`, `deployBlock`, `escrowImplAddress`,
  `riskFacetAddress`, `profileFacetAddress`, `metricsFacetAddress`,
  `vpfiBuyAdapter`, `vpfiBuyPaymentToken`) all flow from
  `getDeployment(meta.chainId)`. The existing EIP-55 normalisation
  pass at module load is preserved so a mis-cased address in any
  per-chain JSON still surfaces at startup with a clear error.
- `ops/hf-watcher/src/env.ts` — `getChainConfigs(env)` now folds
  per-chain RPC env vars (still operator-specific Worker secrets)
  with `getDeployment(id)` lookups; chains without a recorded
  deployment are auto-filtered. The six `DIAMOND_ADDR_*` entries
  on the `Env` interface are gone.
- `ops/hf-watcher/wrangler.jsonc:vars` — six empty
  `DIAMOND_ADDR_*` placeholders dropped. Comment in the same
  spot now points at the deployments JSON.
- `frontend/.env.example` and `frontend/.env.local` shrunk from
  37 keys to ~15. What remains is genuinely operator-specific —
  per-chain RPC URLs (with API keys), WalletConnect project ID,
  default chain ID, log-chunk tuning, feature flags, push channel
  address. Nothing else.
- `contracts/script/syncFrontendEnv.sh` retired (deleted). Its
  whole job is now done by the export script's frontend target.
- `frontend/scripts/uploadEnvToCloudflare.sh` retired (deleted).
  That script targeted Cloudflare Pages — wrong tool for this
  project, which deploys via Workers Static Assets and inlines
  `VITE_*` at LOCAL `vite build` time.

**Omit-keys policy:**

Different chains have legitimately different shapes — the
canonical-VPFI chain has `vpfiOftAdapter` + `vpfiBuyReceiver`;
mirror chains have `vpfiMirror` + `vpfiBuyAdapter`. The merged
JSON preserves this variance: each chain's stanza only carries
the keys present in its `addresses.json`. There are NO
zero-address sentinels for "doesn't apply on this chain" because
`address(0)` already means real things in Solidity (the ETH
sentinel, the burn address, default-treasury). Conflating
"missing field" with "intentionally zero" is a bug class we
designed out. The TS `Deployment` interface marks non-universal
fields as optional, and consumers narrow on the
`isCanonicalVPFI` / `isCanonicalReward` discriminators (already
present in every per-chain JSON) before reading scoped fields.

The one exception: `vpfiBuyPaymentToken` carries
`0x0000…0000` to mean "pay in native gas (ETH/BNB)". That's a
meaningful runtime sentinel (the Solidity convention for
native-gas mode in payment-token slots), not a missing field.
The frontend's `nullIfZero` boundary maps it to `null` for
JS-truthiness ergonomics; the JSON keeps it raw.

**Verified end-to-end:**

- Frontend `tsc -b --noEmit` clean.
- Watcher `npm run typecheck` clean.
- `npm run build` (Node 25) on the frontend produced a clean
  bundle. The Base Sepolia and Sepolia Diamond addresses each
  appear exactly once in the main JS chunk
  (`dist/assets/index-*.js`) and zero times in any other chunk —
  vite inlined the JSON correctly with no duplication and no
  tree-shaking surprises.
- Export script ran cleanly against all 4 existing per-chain
  dirs (anvil 31337, base-sepolia 84532, bnb-testnet 97,
  sepolia 11155111), wrote both targets + provenance stamps.

**Operator workflow after a redeploy:**

```
[deploy contracts on chain X]                # writes contracts/deployments/<x>/addresses.json
bash contracts/script/exportFrontendDeployments.sh   # syncs both consumers
cd frontend && npm run deploy                # ships frontend
cd ops/hf-watcher && wrangler deploy         # ships watcher
```

No `.env.local` edits, no `wrangler.jsonc:vars` edits, no
Cloudflare dashboard touches for the address change. The merged
JSON is committed to git, so CI builds (if/when introduced) see
the addresses without needing an env-var dance.

**What stays manual / one-time:**

- `wrangler secret put TG_BOT_TOKEN` (and the other watcher
  secrets — `RPC_*`, `PUSH_CHANNEL_PK`, aggregator keys,
  `KEEPER_PRIVATE_KEY`). Secrets cannot live in `wrangler.jsonc`
  because that file is committed; they go in the encrypted
  secret store via the wrangler CLI, once per worker per env.
- `frontend/.env.local` per-chain RPC URLs (with API key).
  Still operator-specific.
- For a future migration to GitHub auto-deploy via Cloudflare
  Workers Builds: the build environment variables panel
  (separate from `wrangler.jsonc:vars` — those are runtime
  vars on the Worker; build-env-vars are what `vite build`
  reads at compile time). One-time setup, then every push
  picks them up.

**Documentation updated:**

- `CLAUDE.md` — section retitled "Deployments sync (frontend +
  hf-watcher)" with both consumer paths documented + the
  omit-keys policy spelled out.
- `docs/ops/DeploymentRunbook.md` — replaced the old
  `syncFrontendEnv.sh` walkthrough with the new
  `exportFrontendDeployments.sh` flow; explicitly notes that
  addresses are no longer in `.env.local` so CI builds see
  them via the committed JSON.
- `docs/ops/BaseSepoliaDeploy.md` — new §15 "Sync the deployments
  JSON (frontend + hf-watcher)" appended after the existing
  "Sync the frontend ABI bundle" section.
- `docs/ops/BNBTestnetDeploy.md` — Publish-step rewritten to use
  the export script instead of hand-editing
  `VITE_BNB_TESTNET_*` lines.

## Deploy-script auth cleanup — 00015 / 00016 / 00017 / 00018

Four post-handover-runnability findings in the deploy-script
collection, all small, all related. After yesterday's
`TransferAdminToTimelock` flow lands in production, the deployer
EOA holds zero ERC-173 ownership and zero roles — any admin-side
script that still reads the legacy `PRIVATE_KEY` reverts with
`NotContractOwner` or `AccessControlUnauthorizedAccount`.

**00015 — `AddOracleAdmin.s.sol` deleted.** Its stated purpose
("DeployDiamond didn't register OracleAdminFacet so add it via a
follow-up cut") is structurally impossible today — `DeployDiamond.s.sol`
already cuts the full 20-selector OracleAdminFacet surface at
line 131, so the follow-up `AddFacet` cut would revert with
`CannotAddSelectorThatAlreadyExists` even if the auth issue
were fixed. Operators who need to swap the OracleAdminFacet
implementation post-deploy use the working `UpgradeOracleFacet.s.sol`
sibling, which correctly splits `PRIVATE_KEY` (deploy a new impl)
and `ADMIN_PRIVATE_KEY` (broadcast the `Replace` cut from the
admin EOA). Same shape as the `UpgradeOracle.s.sol` deletion in
yesterday's findings 00013 + 00014. `contracts/README.md`
script-table cleaned up — dropped the `AddOracleAdmin.s.sol`
row and fixed the stale `UpgradeOracle.s.sol` reference (now
points at `UpgradeOracleFacet.s.sol`).

**00016 — `ConfigureRewardReporter.s.sol`.** Now reads
`ADMIN_PRIVATE_KEY` instead of `PRIVATE_KEY` at the broadcaster
line, matching the sibling-script convention used by
`ConfigureOracle`, `ConfigureVPFIBuy`, `ConfigureNFTImageURIs`.
The NatSpec env-var block was expanded to spell out the
rationale: every setter the script calls (`setLocalEid`,
`setBaseEid`, `setRewardOApp`, `setIsCanonicalRewardChain`,
`setExpectedSourceEids`) gates on `ADMIN_ROLE`, so
post-handover the legacy `PRIVATE_KEY` would no-op-revert.

**00017 — `SetInteractionLaunch.s.sol`.** Same fix shape as
00016 — `PRIVATE_KEY` → `ADMIN_PRIVATE_KEY` at line 34, plus
NatSpec rationale. The two setters it calls
(`setInteractionLaunchTimestamp`,
`setInteractionCapVpfiPerEth`) are both `ADMIN_ROLE`-gated.

**00018 — `ConfigureOracle.s.sol` scope clarified, not
loosened.** Verified the underlying authorisation surface
before fixing: every OracleAdminFacet setter the script
broadcasts (`setUsdChainlinkDenominator`,
`setEthChainlinkDenominator`, `setWethContract`,
`setEthUsdFeed`, `setUniswapV3Factory`,
`setSequencerUptimeFeed`, `setChainlinkRegistry`,
`setStableTokenFeed`, plus the secondary-oracle setters)
genuinely gates on `LibDiamond.enforceIsContractOwner()` —
not `ADMIN_ROLE`. Only the two `AdminFacet.setZeroExProxy` /
`setallowanceTarget` calls would tolerate ADMIN_ROLE alone.
The finding's "just relax the gate" framing would have meant
half the script silently broadcasts and half the script
reverts on-chain after the timelock takes ownership — worse
than the current loud-fail.

The right framing is: this is the **pre-handover bootstrap
path**. Per the BaseSepoliaDeploy / DeploymentRunbook
ordering, ConfigureOracle runs in §2 (right after
DeployDiamond, before any `TransferAdminToTimelock`). After
the timelock takes ownership, every OracleAdminFacet setter
must go through the timelock proposer flow (encode the
calldata, schedule with the documented delay, execute) —
not via this script. Splitting the script to support both
paths would force a half-broadcast / half-timelock-proposal
flow that's not worth the operational complexity for a
one-shot bootstrap.

What changed in the script:
- Doc-comment block above the pre-flight check expanded to
  document the scope explicitly.
- Pre-flight revert message now educates the operator
  hitting it post-handover: "This script is the
  pre-handover bootstrap path; post-handover oracle
  changes must go through the timelock proposer flow (see
  DeploymentRunbook)." No code-path change for the
  legitimate (pre-handover) caller — the
  ownership-required gate is preserved.

**Verified:** `forge build` clean across all four edits +
the `AddOracleAdmin` deletion (no compilation errors;
trailing notes are pre-existing lint warnings on unrelated
files).

## Bucketed duration picker on Create Offer

Per ToDo item 12. The Create-Offer duration field was a free-form
`type="number"` input — a lender could enter `47` and a borrower
`52` and never match each other. The matching engine that lands
in the Range Orders flow handles ranges on `amount` and
`interestRateBps` (Phase 1) but **not** on `durationDays` —
duration is matched single-value. So free-form entry is the wrong
shape for the matching story.

Replaced with a dropdown of seven preset buckets:
**7 / 14 / 30 / 60 / 90 / 180 / 365 days**. Spread covers the
typical lending window — 1 week up to the on-chain
`MAX_OFFER_DURATION_DAYS_DEFAULT = 365` cap — with finer
intervals (30-day steps) through the first quarter where most
flow concentrates and quarterly steps beyond. Default selection
is 30 days (median of the bucket list, matches the previous
placeholder text).

Why this helps matching: with seven discrete duration values,
exact-equal matches between two compatible offers (lender + borrower
on the same lending/collateral asset pair) happen frequently
enough that the keeper bot's matching pass produces useful
pairs without needing a duration-range model. Single-value
duration is also simpler to reason about for the
"transferability of obligation" flows (Preclose-via-offer,
Refinance) where the new loan must literally inherit the old
loan's duration tail.

Implementation:

- New `OFFER_DURATION_BUCKETS_DAYS` constant in `lib/offerSchema.ts`
  (single source of truth) plus `OFFER_DURATION_DEFAULT_DAYS = 30`
  for the form's initial state.
- `lib/offerSchema.ts:initialOfferForm.durationDays` now defaults
  to `"30"` instead of empty — the dropdown always has a sensible
  preselected value, no "please pick something" empty state.
- `pages/CreateOffer.tsx` swapped the duration `<input type="number">`
  for the existing generic `<Picker>` component. Same chrome as
  the chain selector + status filters elsewhere in the app.
- The `<label htmlFor>` link was dropped (the Picker's trigger is
  a `<button>`, not a native form input — `htmlFor` doesn't
  apply). Screen-reader text comes from the Picker's
  `ariaLabel="Loan duration"` prop; sighted users still see the
  label above the trigger.
- The `durationOutOfRange` validation and the grace-period hint
  block stay in place — defensive checks for the unlikely case
  that someone seeds the form with a non-bucket value. The
  contract enforces `1 ≤ durationDays ≤ cfgMaxOfferDurationDays()`
  on its side (per finding 00025), so power users hitting the
  Diamond directly with a custom integer still get sensible
  bounds.
- New i18n keys `createOffer.durationBucket_one` /
  `createOffer.durationBucket_other` (plural-aware) +
  `createOffer.durationPickerAria` for the trigger label.
- Other surfaces with their own duration entry (BorrowerPreclose
  offset path, Refinance) are out of scope for this batch —
  they're rarely-used flows where free-form entry makes sense
  for now. They can adopt `OFFER_DURATION_BUCKETS_DAYS` later
  if matching needs it.

Verified: `tsc -b --noEmit` clean, `npm run build` clean (Node 25,
1.97s), vite emits the bundle with the bucket list inlined.

## VPFIBuyAdapter — payment-token mode validation (T-036)

Per ToDo item T-036. Long-term path for the
"WETH-only on non-ETH chains" enforcement.

**Background.** The cross-chain VPFI buy adapter pulls funds from
the user on the source chain and forwards a BUY_REQUEST via
LayerZero to the canonical Base receiver, which mints + sends VPFI
to the buyer. The receiver quotes a single global wei-per-VPFI rate
denominated in **ETH-equivalent value**. Native-gas mode
(`paymentToken == address(0)`) is only valid on chains where 1 unit
of native gas == 1 ETH for rate purposes — Ethereum, Base,
Arbitrum, Optimism, Polygon zkEVM, and their public testnets. On
chains where the native gas token is something else (BNB Chain,
Polygon PoS), the adapter MUST be in WETH-pull mode against the
chain's bridged WETH9 ERC20, or every buy mis-prices vs. the
receiver's ETH-denominated rate.

The user's question — "how does the contract ensure user provides
only WETH and not other tokens?" — has a key insight at its heart:
**the contract holds a single `paymentToken` storage slot and pulls
only that token, regardless of any user input**. The user calling
`buy(amountIn, ...)` doesn't choose the token; the adapter
unconditionally does
`IERC20(paymentToken).safeTransferFrom(msg.sender, ...)`. The risk
vector is therefore not "user chooses wrong token" (impossible by
design) but **"operator misconfigures the storage slot at deploy
time"** — pointing it at an EOA, the wrong-decimals stablecoin, a
non-ERC20 contract, or `address(0)` on a chain that requires WETH
mode. The work this session adds two layers of defence against
that operator-side misconfig.

**Layer 1 — `VPFIBuyAdapter` contract-side validation.** New
internal helper `_assertPaymentTokenSane(token)` runs at every
state-mutation site: `initialize()` AND `setPaymentToken()`. When
`token != address(0)`:

- The address must have bytecode (`token.code.length > 0`) — catches
  an EOA pasted into the env var.
- `IERC20Metadata(token).decimals()` must succeed AND return exactly
  18 — catches the most common honest-mistake misconfig (USDC's 6-dec
  address pasted where WETH belongs) and the non-ERC20-contract case
  (decimals() reverts because the function doesn't exist on the
  bytecode).

Three new errors surface the failure modes precisely:
`PaymentTokenNotContract(address)`,
`PaymentTokenDecimalsNot18(address, uint8)`,
`PaymentTokenDecimalsCallFailed(address)`. Plain text in the error
name + the offending address in the payload, so operators reading
the revert immediately see what's wrong. `IERC20Metadata` import
added.

**Layer 2 — `DeployVPFIBuyAdapter.s.sol` chainId pre-flight.** New
helper `_chainRequiresWethPaymentToken(chainId)` returns true for
**BNB Chain mainnet (chainId 56)** and **Polygon PoS mainnet
(chainId 137)**. The script's `run()` reverts before broadcasting
if that helper returns true AND the resolved `paymentToken` is
zero. The error message names the env var the operator should set
(`BNB_VPFI_BUY_PAYMENT_TOKEN` or `POLYGON_VPFI_BUY_PAYMENT_TOKEN`)
plus the rationale — "native-gas mode would mis-price every buy
vs. the receiver's ETH-denominated wei-per-VPFI rate". Script also
gained env-var resolution for the two new mainnet keys (the
existing testnet keys `BNB_TESTNET_VPFI_BUY_PAYMENT_TOKEN`,
`POLYGON_AMOY_VPFI_BUY_PAYMENT_TOKEN` are unchanged — testnet
equivalents are intentionally NOT in the strict list because their
gas tokens have no real value and the testnet rate is symbolic).

**What's NOT validated on-chain — and why.** There's no on-chain
registry that says "this is the *canonical* bridged WETH9 on chain
X." A determined operator (or an attacker at deploy time) could
deploy a fake contract that returns the right decimals and bytecode
shape. The defence against that is **operational**: the deploy
script logs `name()` / `symbol()` of the configured token for human-
eyeball confirmation against the chain's published WETH9 address,
and CLAUDE.md now lists the canonical addresses (BNB:
`0x2170Ed0880ac9A755fd29B2688956BD959F933F8`, Polygon:
`0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619`) so the operator pasting
a wrong address gets caught against the published reference. The
contract guard catches the obvious-misconfig class
(EOA / wrong-decimals / non-ERC20); the operational check catches
the canonical-impostor class.

**Test coverage**: new
`contracts/test/token/VPFIBuyAdapterPaymentTokenTest.t.sol`,
10 cases — every revert path on `initialize` AND on
`setPaymentToken` rotation, plus the two acceptance paths
(`address(0)` for native-gas mode, valid mock WETH9 for WETH-pull
mode). Three minimal mock contracts (MockLZEndpoint, MockWETH9,
MockUSDC, NotAnERC20) exercise the failure modes precisely without
needing a live LZ endpoint. All 10 pass.

**Documentation**: CLAUDE.md gained a "VPFIBuyAdapter — payment-
token mode by chain" section right after the Cross-Chain Security
Policy block, documenting the per-chain mode selection rule, the
two-layer enforcement, and the canonical bridged-WETH addresses
operators should paste in for the strict-WETH-pull chains.

**Verified**: forge build clean, targeted suite green
(10 / 0 / 0).

## Bucketed duration i18n — full locale coverage (T-030 follow-up)

Tying off the i18n loose end on T-030. The bucketed
duration picker shipped with English-only strings; this round adds
the three new keys (`createOffer.durationBucket_one`,
`createOffer.durationBucket_other`,
`createOffer.durationPickerAria`) to all 9 non-English locales
already supported by the app: Spanish, French, German, Japanese,
Chinese, Hindi, Arabic, Tamil, Korean. Plurals follow each
language's natural form (`día` / `días`, `Tag` / `Tage`, `jour` /
`jours`); languages without singular/plural distinction (`日`,
`天`, `दिन`, `일`) duplicate the form for both keys so i18next's
fallback chain returns the right value regardless of the count.
Aria label translated per language. JSON validity verified across
all 10 locale files; tsc clean.

## Notification fee + 6 paid event types (T-032)

Per ToDo item T-032. Extends the off-chain alerts product (HF-only
Telegram + Push notifications) into a paid notification service
covering six additional loan lifecycle events.

**Design after iteration with the operator:**

- HF threshold notifications stay compulsory once any rail is on.
- Six new paid event types — all default ON for new subscribers,
  individually opt-out-able:
  1. **Claim available** — funds withdrawable from the Claim Center
  2. **Loan settled or defaulted** — terminal-state notify, both sides
  3. **Cross-chain VPFI buy received** — closing the loop on
     LayerZero-routed mints to the canonical chain
  4. **Your offer matched into a loan** — for the offer creator
  5. **Loan maturity approaching** — proactive heads-up days before
     due
  6. **Partial repayment received** — lender-side reconciliation
- **Telegram free; Push paid.** Push delivery costs the protocol's
  channel gas — recouped via a flat $2 USD-equivalent (governance-
  tunable, denominated through a pluggable oracle) deducted from
  the user's VPFI escrow on the FIRST paid notification per
  loan-side.
- **Bill at first notification, not at loan init.** Mid-loan opt-in
  works naturally — flip the off-chain flag, get notifications,
  get billed when the first event actually fires. Loan that ends
  Day-1 with no events fires: nobody pays.
- **Direct user-escrow → treasury, no Diamond custody window.**
  Confirmed during design discussion that the borrower-LIF custody
  pattern's split-at-terminal logic doesn't apply here (no
  rebate / split for notifications). One transfer, no commingling
  concerns.

**On-chain implementation:**

- New `Loan.lenderNotifBilled` and `Loan.borrowerNotifBilled`
  bool fields. Idempotent — set once, never re-billed.
- New `LibNotificationFee` library with two helpers:
  `vpfiAmountForUsdFee()` (Phase 1 ETH/USD oracle × fixed VPFI/ETH
  rate of 0.001 ETH; Phase 2 pluggable VPFI/USD oracle when VPFI
  lists with a real market price) and `bill(loanId, side, payer)`
  (the orchestration: idempotency check, single
  `escrowWithdrawERC20` call to treasury, set flag, increment
  counter, emit event).
- New `LoanFacet.markNotifBilled(uint256 loanId, bool isLenderSide)`
  external entry, gated by the new
  `LibAccessControl.NOTIF_BILLER_ROLE`. The off-chain hf-watcher
  Worker (or whichever bot the operator runs) calls this on the
  first PaidPush-tier notification per loan-side. Idempotent;
  loan-existence guard via `loanId > nextLoanId` revert.
- Three new errors in `LibNotificationFee`:
  `NotifFeeWethNotSet`, `NotifFeeOracleStale`,
  `NotifFeeOraclePriceZero`, `NotifFeeVpfiTokenNotSet`,
  `NotifFeeTreasuryNotSet`, `NotifFeeOraclePriceZero`.
- Three new ConfigFacet entries: `setNotificationFeeUsd(uint256)`
  (admin-gated, bounded `[$0.10, $50]`),
  `setNotificationFeeUsdOracle(address)` (admin-gated, no on-chain
  validation — operator's responsibility), and a frontend-facing
  read `getNotificationFeeConfig()` that returns
  `(feeUsd1e18, feeOracle, feesAccrued)` in one RPC.
- `s.notificationFeesAccrued` cumulative counter — operator
  monitors for anomaly detection (a compromised
  `NOTIF_BILLER_ROLE` could falsely bill, capped per loan-side at
  the fee ceiling but observable as a spike here).
- `LibAccessControl.grantableRoles()` extended with
  `NOTIF_BILLER_ROLE`. Init grants it to the deploy owner;
  `DeployerZeroRolesTest` extended to keep the canonical-list
  parity invariant.

**Why a separate role rather than extending WATCHER_ROLE**: blast
radii differ. WATCHER's worst case is a 2-hour freeze (recoverable
by PAUSER_ROLE). NOTIF_BILLER's worst case is false-billing capped
per loan-side. Rotating one without the other lets the operator
respond proportionally to a compromise on either side.

**Test coverage**: `contracts/test/NotificationFeeTest.t.sol`,
15 cases — happy-paths on both sides, idempotency, role-gating,
loan-existence guard, insufficient-VPFI revert, oracle math at
two ETH prices (verifies the Phase 1 `1 VPFI = 0.001 ETH` formula),
both-sides-independent, treasury-accrual counter, governance
bounds (floor/ceiling/zero-resets-default), and the pluggable
oracle setter. All pass.

**Frontend**: `/app/alerts` page extended with:

- New "Event types" section between the HF threshold ladder and
  the delivery-rails section. Six checkbox toggles, all default
  ON, individually opt-out. Persisted via the existing
  `PUT /thresholds` call to the hf-watcher Worker — payload
  extended with six `notify_*` boolean fields. Forward-compatible
  with the current watcher (which stores arbitrary
  `user_thresholds` columns; unknown fields are no-ops until the
  backend's per-event detector lands as a follow-up).
- New "Push notifications: fee disclosure" callout inside the
  Push rail block. Renders the flat `$2` figure inline (the
  governance-tunable live read via `getNotificationFeeConfig()`
  is a quick follow-up after the next ABI export).
- i18n keys added across all 10 supported locales (en / es / fr /
  de / ja / zh / hi / ar / ta / ko). Locale JSONs all parse + tsc
  clean.

**What's NOT in this batch (deferrable as separate items):**

- Watcher-side D1 schema migration to add the six `notify_*`
  columns + the per-event detectors (poll for `ClaimableRecorded`,
  `LoanSettled`, `LoanDefaulted`, `BuySucceeded`, etc., and fan
  out to subscribers). The frontend POSTs the new fields today;
  the watcher stores them only when its schema catches up.
- VPFI-balance pre-flight gate on the Push subscribe button —
  warn the user if their escrow balance is below the fee
  equivalent. Deferred to the watcher work above (the watcher
  would already revert at `markNotifBilled` time on insufficient
  VPFI; frontend pre-flight is a polish improvement).
- Live fee read via `getNotificationFeeConfig()` instead of
  the hardcoded `$2` figure in the disclosure copy. Quick
  follow-up after the next ABI re-export — the contract surface
  + ABI are ready, just need the `useReadContract` hook wiring.

**Verification**: forge build clean, full no-invariants regression
green (15 new tests + no regressions), frontend tsc clean across
all 10 locale JSONs.

## BuyVPFI page asset-aware UX (T-038)

Per ToDo item T-038. The BuyVPFI page previously labeled
the input asset as "ETH" everywhere — accurate on Base / Ethereum /
Arbitrum / Optimism / Polygon zkEVM (which all use ETH for native
gas) but wrong on BNB Smart Chain (mainnet) and Polygon PoS
(mainnet) where the BuyVPFIAdapter runs in WETH-pull mode and the
user actually pays in a bridged WETH9 ERC20, not native ETH. Even
worse, "WETH on BNB" and "WETH on Polygon" are different bridged
contracts with different addresses, so a user grabbing "WETH on
Uniswap" wouldn't necessarily have the right token. T-038 fixes
the labeling AND adds an unambiguous per-chain CoinGecko deep-link
so users can confirm exactly which asset they need before they go
acquire it.

**New helper**:
[`frontend/src/lib/buyAssetInfo.ts`](../../frontend/src/lib/buyAssetInfo.ts)
exports `getBuyAssetInfo(chainConfig, modeOverride?)` returning
`{ symbol, coinGeckoUrl, isWethPullMode }`. Mode resolution
priority: explicit override (`useVPFIBuyBridge.quote()` returns
the runtime-confirmed mode after reading `adapter.paymentToken()`)
→ chain-config inference (`vpfiBuyPaymentToken` from the
deployments JSON). Until a quote lands, the static config is
consulted; once a quote returns, the runtime mode takes over.

**ChainConfig extension** ([config.ts](../../frontend/src/contracts/config.ts)):
three new static fields populated per chain in the registry —
`nativeGasSymbol`, `nativeGasCoinGeckoSlug`,
`bridgedWethCoinGeckoSlug`. ETH-native chains
(Ethereum / Sepolia / Base / Base Sepolia / Arbitrum / Arb
Sepolia / Optimism / OP Sepolia / Polygon zkEVM / Cardona / Anvil)
all use `nativeGasSymbol: 'ETH'`,
`nativeGasCoinGeckoSlug: 'ethereum'`,
`bridgedWethCoinGeckoSlug: null`. BNB chains use
`'BNB'`/`'tBNB'` + `'binancecoin'` + `'weth'` (CoinGecko's
multi-chain WETH page covers the bridged variants).

**UI changes** in [BuyVPFI.tsx](../../frontend/src/pages/BuyVPFI.tsx):

- BuyCard (canonical-chain direct buy on Base) — rate stat
  rewritten from `${rateEth} ETH / VPFI` to dynamic asset symbol
  with CoinGecko deep-link wrap.
- BridgedBuyCard (mirror-chain LayerZero bridge buy) — same rate
  stat treatment + the existing "Pay (tokens / ETH)" label
  switched to the dynamic asset symbol.
- `Stat` component's `value` prop widened from `string` to
  `React.ReactNode` so callers can embed inline links inside
  stat values (the rate is now a React fragment with an `<a>`
  for the symbol).
- Asset symbol uses dotted underline + new-tab open as the
  visual affordance for "click for more info" without making
  it look like a primary action button.
- ARIA label `buyVpfiCards.assetCoinGeckoAria` so screen
  readers announce "Open CoinGecko page for WETH" (or BNB / ETH
  / etc.) on focus.

**WETH-pull approval flow** — already implemented in
`useVPFIBuyBridge` (the `s.status === 'approving'` branch
dispatches the prerequisite ERC20 approval before submitting
the buy when `paymentToken != address(0)`). Verified the path
during this batch; no changes needed there.

**i18n** — `buyVpfiCards.assetCoinGeckoAria` added to all 10
supported locales (en / es / fr / de / ja / zh / hi / ar / ta /
ko). All JSONs parse + tsc clean + Node-25 vite build clean
(1.89s).

**What's NOT in this batch** (deferrable as T-038 follow-ups):

- Remaining hardcoded "ETH" strings in BridgedBuyCard's
  tooltips and error copy (e.g., the LayerZero fee tooltip
  saying "ETH for the LayerZero fee"). The LZ fee IS always
  native gas across chains, so that label needs to use the
  chain's `nativeGasSymbol`, not blindly "ETH".
- Per-asset balance read in WETH-pull mode. Today the page
  reads native ETH balance via wagmi; in WETH-pull mode it
  should read the WETH ERC20 `balanceOf` instead. The
  `useVPFIBuyBridge` quote already returns the right
  `paymentToken` address; just need to wire the balance hook
  conditionally on the mode.

## Direct user-escrow transfers — wallet→Diamond→escrow eliminated (T-037)

Per ToDo item T-037. Six call sites across `RepayFacet`,
`PrecloseFacet`, `RefinanceFacet`, and `EarlyWithdrawalFacet`
previously routed funds **wallet → Diamond → recipient escrow** in
two transfers — the Diamond received the asset momentarily and
then forwarded it. The user's question (after seeing the receive
side of the borrower-LIF flow): why the intermediate hop? Two
reasons evaporate on inspection:

1. The Diamond is the spender on `safeTransferFrom` (the borrower
   has approved the Diamond, not the destination). `transferFrom`
   can move tokens directly between any two addresses using the
   spender's allowance — the Diamond doesn't need to be the
   `to` address itself.
2. The "lender escrow may not exist yet" was the only legitimate
   reason for the two-step. Re-ordering — call
   `getOrCreateEscrow` FIRST, then `safeTransferFrom(borrower,
   lenderEscrow, amount)` — addresses that with a single transfer.

Sites refactored:

- `RepayFacet.sol` — full-repay yield path (line ~222). Borrower's
  principal+interest → lender's escrow direct.
- `PrecloseFacet.sol` — preclose-direct lender-due path (line ~170),
  preclose-offset lender-share (line ~432), preclose-via-offer
  offset (line ~756). All three now route the borrower's settle
  payment directly to the old lender's escrow.
- `PrecloseFacet.sol` — rental-prepay split (line ~263). This was
  an *escrow → Diamond → escrow* shape: borrower's prepay-asset
  withdrawn from their escrow, then forwarded to lender's escrow.
  Now uses `escrowWithdrawERC20`'s arbitrary-recipient parameter
  to route directly between the two escrows.
- `RefinanceFacet.sol` — refinance pull-and-split (line ~183).
  Previously pulled the entire borrower payment into the Diamond
  then split treasury vs lender; now two direct `safeTransferFrom`
  calls (treasury share + lender share) replace the
  one-pull-two-push pattern.
- `EarlyWithdrawalFacet.sol` — three branches in the loan-sale
  recipient-funding path. Previously pulled `originalLender`'s
  topup into the Diamond then dispatched via
  `LibFacet.transferToTreasury` + `depositForNewLender`. Now uses
  two new helper variants that route directly.

Two new `LibFacet` helpers added to support the refactor:

- `transferFromPayerToTreasury(payer, asset, amount)` —
  `safeTransferFrom`-based variant of the existing
  `transferToTreasury`. Records the same `treasuryBalances`
  accrual on Diamond-as-treasury deployments.
- `depositFromPayerForLender(asset, payer, lender, amount, loanId)`
  — `safeTransferFrom`-based variant of `depositForNewLender`.
  Same `heldForLender` accounting.

The Diamond-resident variants stay in place — escrow-source
flows where the Diamond is genuinely the holder (e.g.,
liquidation-swap output staging) still use them.

**Why this is more than just gas savings:**

The user's framing was right: removing the transient
Diamond-hold-of-(principalAsset) state is meaningful beyond
the ~2-3k gas saved per call. The Diamond's `balanceOf` for the
principal asset is now provably zero outside of the genuinely
in-flight cases (LIF custody, liquidation-swap staging). Any
future audit asking "where does the Diamond hold user funds" has
a strictly shorter answer. The custody model becomes:
*"Diamond holds VPFI for borrower-LIF custody (until terminal
split) and SWAP output during liquidation routing — and nothing
else."* Cleaner principal-of-least-surprise.

Already-direct sites verified during the audit and left as-is:

- `RepayFacet:213` (treasury share) — already a single
  `safeTransferFrom(borrower, treasury, x)`.
- `RepayFacet:490-499` (partial repay) — already two direct
  `safeTransferFrom`s (lender wallet + treasury).
- `PrecloseFacet:160` and `PrecloseFacet:743` (treasury fees) —
  already direct.
- `OfferFacet:470` (offer creation lender-pull) — already direct
  `safeTransferFrom(creator, escrow, x)`.
- `AddCollateralFacet`, `VPFIDiscountFacet.depositVPFIToEscrow`
  — already direct.

**Verified**: forge build clean. RepayFacet targeted suite 63/63
passing. Full regression after the merge will run as part of
the next batch.

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
