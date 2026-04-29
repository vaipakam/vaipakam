# Release Notes — 2026-04-29

Functional record of everything delivered on 2026-04-29, written as
plain-English user-facing / operator-facing descriptions — no code.
Grouped by area, not by chronology. Continues from
[`ReleaseNotes-2026-04-28.md`](./ReleaseNotes-2026-04-28.md).

Coverage at a glance: a one-time **migration inside the log-index
cache reader** that backfills the rolling list of recently-accepted
offer IDs from the cached events array on hydrate, so existing
users whose browsers had already scanned past the relevant
`OfferAccepted` block under the previous code still see the market-
anchor rate-deviation badges in the Offer Book; a fresh
**production deploy** to the public Cloudflare Worker that ships
the day's bundle; a **fixed-position-Navbar clearance** on the
public Privacy and Terms pages (the top of those pages used to sit
behind the Navbar); a series of **Buy VPFI copy cleanups** —
tighter Step 2 / Step 3 subtitles, a single user-friendly Info
callout on the Stake card explaining open staking + auto-escrow-
on-first-deposit, and removal of duplicated framing copy that
existed twice on the page; and a **major Loan Details overhaul**
— a chronological **on-chain activity timeline** for every loan
showing each event's friendly per-type breakdown (settlement
splits, fallback collateral allocations, partial-repay rows, swap
retries, VPFI fee-discount rebates), a pinned **"Ready to claim"
action bar** at the top when the connected wallet has a claimable
position, a clickable **Loan #X** pill on the Activity page that
deep-links to the matching Loan Details, a green **Claim CTA** on
the Dashboard's Your Loans table for terminal-state rows that
have unclaimed funds, and a brand-new **VPFI staking-rewards
claim** card that surfaces the wallet's pending APR-accrued VPFI
on the Buy VPFI page Step 2 plus a compact mirror on the
Dashboard's Discount Status surface; and a **rewards-architecture
split** that retires the old in-app Rewards page entirely —
staking rewards claim from Buy VPFI Step 2, platform-interaction
rewards claim from a new card on Claim Center (with a lifetime-
claimed total summed from on-chain events plus an expandable
"contributing loans" list that links each contributing lender /
borrower entry back to its full Loan Details page; a **lifetime-
claimed total** added to the staking-rewards card on Buy VPFI
(Step 2) so historical claimers see how much VPFI they've pulled
from the program over time, and conditional chrome that flips
green only when `pending > 0`; **navbar tightening** so the brand
logo never gets squeezed by the four nav slots; **in-app sticky
top bar** fix (`overflow-x: hidden → clip` so the topbar actually
sticks during page scroll); **sidebar/topbar height parity** at
64 px so the divider line aligns across the app shell; **Create
Offer button gating** that disables the submit until
`validateOfferForm` passes, with the validator now returning
typed error codes mapped to localised strings across all 10
locales; an asset-picker UX cleanup that **drops the lone red
asterisk** on the Create Offer address field (button gating +
tooltip already disambiguates required state); a sweep that
**removes the "mirrors the in-app revoke flow used by Uniswap
and 1inch" reference** from the Allowances page subtitle in
every locale; an **interaction-rewards card upgrade** showing
lifetime claimed + an expandable contributing-loans list (each
row linking to Loan Details); and finally a **full
protocol-config sweep** — `useProtocolConfig` extended to also
fetch a new `getProtocolConstants()` view returning the four
compile-time constants (`MIN_HEALTH_FACTOR`, the two VPFI pool
caps, `MAX_INTERACTION_CLAIM_DAYS`); the `VPFI_TIER_TABLE`
static export retired in favour of a `useVpfiTierTable()` hook
that derives tier rows from the live tier-thresholds + tier-
discount-bps reads; the hardcoded `RENTAL_BUFFER_BPS` constant
in Create Offer replaced with the live `rentalBufferBps`
config field; `<CardInfo>` extended to **auto-inject 18
protocol-config placeholders** (`{{treasuryFee}}`, `{{tier1Min}}`,
`{{maxSlippage}}`, `{{minHealthFactor}}`, `{{vpfiStakingPoolCap}}`,
…) into every `cardHelp.*` tooltip without per-call-site wiring;
~16 i18n strings across 10 locales swept to use those
placeholders so governance changes (or even a contract redeploy
that bumps a constant) flow into the UI without a frontend
redeploy; and finally a **LayerZero Phase-1 hardening pass**
that closes the last two gaps from the post-Kelp-incident plan
— a strict 128-byte **per-packet size sanity check** added to
`VaipakamRewardOApp._lzReceive` (rejects malformed / oversized
payloads with a typed `PayloadSizeMismatch` error before
`abi.decode` can silently swallow trailing bytes), and a
brand-new internal-only **`ops/lz-watcher` Cloudflare Worker**
that runs three off-chain detectors on a 5-minute cron — DVN-set
drift on every `(chain × OApp × peer eid × send/receive)` pair,
OFT mint/burn imbalance between Base's canonical adapter lock
and the sum of every mirror chain's `totalSupply()`, and
oversized single-tx VPFI flows above a configurable threshold
— alerting to a private ops Telegram channel, deliberately
separated from the public-facing `ops/hf-watcher` Worker which
doubles as a competitive autonomous keeper that anyone can
clone.

## Market-anchor cache backfill — no rescan needed

Background: the Offer Book's market-anchor rate-deviation column
is driven off a rolling list of the last ~20 accepted offer IDs,
fed by the per-(chain, diamond) log-index cache in the user's
browser. That field was added on 2026-04-28 without bumping the
cache key version number — the call at the time was that
"incremental scans append new `OfferAccepted` events as they
arrive, so the rolling list will populate over time without
forcing a full rescan." Older caches keep working; new caches
populate the field; everyone converges.

The flaw in that reasoning surfaced when a user reported the
anchor-deviation badges working in one wallet session but not in
a parallel session on a different account. Both sessions share
the same per-(chain, diamond) cache, but the cache predates the
field — and incremental scans only re-read blocks past the cache's
`lastBlock` watermark. Any `OfferAccepted` event sitting *behind*
the watermark on a stale cache stays invisible to the rolling-list
field forever, even though the same event is already serialised
into the cache's `events` array with all the data needed to
reconstruct the field.

The cache reader now reconstructs the rolling list from the cached
`events` array on hydrate whenever the field is missing or empty.
It walks the events oldest-first, filters to `kind ===
'OfferAccepted'`, pulls each offer ID, and keeps the trailing 20
to seed the rolling list. The data was already in cache; the
reader just needed to read it.

Effect: any browser session that had a v7 cache from before the
2026-04-28 rolling-list addition now picks up the right market
anchor on next page load with zero RPC traffic and zero rescan
delay. The user-visible symptom (rate-deviation badges showing on
one session and not another, with no obvious reason) is gone.

Cache key stays at v7 — no full rescan forced. The migration is
load-bearing-on-hydrate only; once a cache has been written under
the new code path it carries the rolling list directly and the
backfill clause is a no-op.

## Privacy + Terms — Navbar clearance fix

The public Privacy Policy and Terms of Service pages share a
single stylesheet (`LegalPage.css`). The top-of-page layout used a
32 px `padding-top` on the main content block, which assumed a
non-fixed Navbar. The site Navbar is `position: fixed` at 72 px
height, so the page heading (`Vaipakam Privacy Policy` / `Vaipakam
Terms of Service`) and the version metadata line directly under it
were sitting behind the Navbar on every page load. `padding-top`
bumped to 104 px (72 px Navbar height + the original 32 px
breathing room), matching the per-page clearance pattern used by
the User Guide page.

## Buy VPFI — Step 2 / Step 3 copy cleanup

The Buy VPFI page had grown two layers of overlapping framing copy
between iterations:

- A page-top "Staking is open to anyone — you don't need an
  existing loan to participate. Depositing VPFI into your escrow
  earns the 5% APR yield, and the protocol auto-creates an escrow
  for you on first deposit." paragraph under the page subtitle.
- A long blue Info callout inside the **Step 2 — Deposit / Stake
  VPFI into your escrow** card that re-explained the same things
  in spec-document language ("Per spec, moving VPFI into escrow is
  always an explicit user action. The protocol never auto-funds
  escrow after a buy or bridge…").
- A Step 2 subtitle ("Required on every chain — including the
  canonical one. Earns 5% APR staking yield while it sits there.")
  whose first half was protocol-internals trivia for end users.
- A Step 3 subtitle that duplicated the warning rendered just
  below it inside the unstake form.

Cleanup pass:

- **Step 2 subtitle** is gone. The card title and the new Info
  callout below carry the message.
- **Step 2 Info callout** rewritten in plain second-person prose:
  *"Staking is open to everyone — you don't need a loan to
  participate. Any VPFI you deposit into your escrow earns 5% APR
  for as long as it stays there. First time staking? Your escrow
  is created for you automatically on your first deposit — no
  setup needed."* Translated across all 10 locales.
- **Step 3 subtitle** is gone. The unstake-form's existing
  discount-tier-impact warning carries the discussion.
- **Page-top open-staking paragraph** is gone — the Step 2
  callout is the single canonical home for that message.

The Step-Header component grew an `optional` flag on the subtitle
prop so the omission renders cleanly without an empty `<p>` slot.

`step2Subtitle`, `step3Subtitle`, and `openStakingNote`
translation keys were dropped from every locale file; only
`step2Info` remains in the Stake area.

## Production deploy

The full day's bundle (yesterday's TokenInfoTag, the Dashboard
"your stuff" consolidation, the VPFI Token card move with
paginated activity, the inlined ERC-20 detection pill, the lender-
self-repay guard, the illiquid risk-math custom error, and today's
cache-backfill fix) shipped to the public Cloudflare Worker
deployment. 23 new / modified static assets uploaded; 101 cached
from prior bundles unchanged.

## Loan Details — chronological activity timeline

The loan view page used to be a static read of the loan struct
plus the action surfaces (Repay / Add collateral / Preclose /
Refinance). The on-chain history of *what had already happened* to
the loan was visible only by paging through the global Activity
page and visually filtering by loanId.

A new **LoanTimeline** component now sits at the bottom of every
Loan Details page. It pulls every event from the per-(chain,
diamond) log-index whose `args.loanId` matches the page's loan,
sorts by (block, log-index) ascending, and renders one row per
event with a per-kind friendly breakdown — the numbers come
straight from the event arguments, no on-chain re-derivation.

Per-kind breakdowns rendered today:

- **Loan initiated** — principal + collateral + lender + borrower.
- **Offer accepted** — the address that accepted.
- **Partial repayment** — amount repaid + principal remaining.
- **Loan repaid** — interest paid + late fee (if any) + repayer.
- **Settlement breakdown** (proper close) — principal returned,
  interest, late fee, lender share, treasury share. Source: the
  `LoanSettlementBreakdown` event invariant
  `treasuryShare + lenderShare == interest + lateFee`.
- **Loan defaulted** — dual fallback consent flag.
- **Liquidation fallback (swap reverted)** — collateral entering
  the fallback path.
- **Fallback collateral split** — the three-way slice (lender /
  treasury / borrower) on the claim-time settlement path.
- **Lender / Borrower claimed** — amount + asset + claimant.
- **Borrower LIF rebate claimed** — VPFI rebate paid out to the
  borrower's NFT holder at proper close (Phase 5 §5.2b).
- **Collateral added** — added amount + new total.
- **Lender position sold / Borrower obligation transferred** —
  original / new party + shortfall paid (transfer path only).
- **Claim-time swap retry** — succeeded / failed + proceeds
  returned on success.
- **Loan settled** — both sides have claimed; loan is final.

Each row also carries a tx-hash deep-link to the chain explorer.

## Loan Details — "Ready to claim" action bar

Above the loan-data grid, a new **ClaimActionBar** pins itself to
the top of the page whenever:

- the loan is in `Repaid`, `Defaulted`, or `FallbackPending` (the
  three statuses where ClaimFacet allows a claim);
- the connected wallet still owns one of the position NFTs;
- the claim slot for that side hasn't been pulled yet AND the
  side has at least one actionable claimable lane (fungible
  amount > 0, an NFT payload, held-for-lender funds on a fallback
  retry, a rental-NFT awaiting return, or a Phase 5 borrower-LIF
  VPFI rebate).

Headline payout from `getClaimable(loanId, isLender)`. Inline
sub-line for any held-for-lender slice (lender side) and the
borrower LIF rebate (borrower side). One Claim button per side
that submits the appropriate facet call (`claimAsLender` /
`claimAsBorrower`). After a successful submission the page
refetches loan + claim state so the bar disappears.

## Activity row — clickable Loan pill

The grouped-by-tx Activity row used to render `Loan #16` as a
non-interactive `<span>` pill. It's now a `<Link to="/app/loans/X">`
that opens the full Loan Details (timeline + claim bar) for that
loan. The pill keeps the same visual chrome plus a hover-underline
treatment so it reads as clickable.

## Dashboard — Claim CTA on terminal-state loans

The **Your Loans** table on the Dashboard now renders a small
green **Claim** CTA next to the existing **View** action whenever
the connected wallet has unclaimed funds on that loan. Detection
runs through the existing `useClaimables(address)` hook (no
extra contract reads beyond what the Claims page already
performs) and lights the badge for any loanId in the resulting
set. Click sends the user straight to the Loan Details page
where the action bar is already pinned at the top.

## VPFI staking-rewards claim card

The protocol's `StakingRewardsFacet` already exposes
`previewStakingRewards`, `getUserStakedVPFI`, `getStakingAPRBps`,
`getStakingPoolRemaining` views and a `claimStakingRewards`
write. There was no front-end surface for it.

A new **StakingRewardsClaim** component lives on the Buy VPFI
page Step 2 (Stake) card as a full row, and mirrors itself in a
compact inline strip on the Dashboard's Discount Status surface.
Reads the four views in one read-multicall, shows the current
**pending VPFI** number, and one Claim button submits
`claimStakingRewards`. The card hides itself entirely when the
wallet has zero pending AND zero staked — fresh users don't see
a "0 VPFI rewards" prompt.

## Contract — new fallback-snapshot view

`ClaimFacet.getFallbackSnapshot(loanId)` is added to expose the
existing `s.fallbackSnapshot[loanId]` storage struct as a
public view. Returns the three-way collateral split
(`lenderCollateral` / `treasuryCollateral` / `borrowerCollateral`),
the principal-due figures (`lenderPrincipalDue` /
`treasuryPrincipalDue`), plus the `active` and `retryAttempted`
flags. Frontends use this where the breakdown comes from
storage rather than from the `LiquidationFallbackSplit` event.
Three Foundry tests assert: live-snapshot shape while in
FallbackPending, snapshot cleared on cure, and a no-op return
for a fresh loanId. Added to both DeployDiamond and the
HelperTest selector lists.

## Log-index — new event topics + cache version bump

The frontend log-index allow-list was widened to include the
loan-lifecycle breakdown stream powering the Loan Details
timeline: `LoanSettlementBreakdown`, `LiquidationFallback`,
`LiquidationFallbackSplit`, `LoanSettled`, `PartialRepaid`,
`ClaimRetryExecuted`, `BorrowerLifRebateClaimed`, plus the per-
user `StakingRewardsClaimed`. Each gets a topic-hash decoder
that converts the indexed and packed event data into the
existing `ActivityEvent` shape so Activity, the timeline, and
any downstream consumer all read from one cache.

The cache key bumped from `v7` to `v8` to force a fresh full
scan once — older caches pre-date the new topics in the
`getLogs` OR-set and can't backfill incrementally past
`lastBlock`. The previous `recentAcceptedOfferIds`-style hydrate-
time backfill doesn't help here because the new topics weren't
captured at all in old caches.

## Rewards architecture — split + delete

The in-app Rewards page used to combine two reward streams into one
Claim Rewards button: passive **staking rewards** (5% APR on
escrow-VPFI) and active **platform-interaction rewards** (a daily
share of a 69M VPFI pool, weighted by the user's settled-interest
participation). The "Withdraw staked VPFI" card on the same page
duplicated Step 3 (Withdraw / Unstake) on the Buy VPFI page.

The streams are now split between their natural homes:

- **Staking rewards** stay on Buy VPFI Step 2 (Stake) — claim
  surface lives next to the deposit/withdraw controls. Already
  shipped earlier today via `StakingRewardsClaim`.
- **Platform-interaction rewards** moved to Claim Center as a new
  inline card above the per-loan claim rows. Claim Center now
  reads as the single home for "anywhere you can pull funds you're
  owed."

The old `/app/rewards` route, the sidebar entry, the
`Rewards.tsx` page, and the `useRewards.ts` hook are gone.
The duplicated Withdraw card is also gone — Buy VPFI Step 3
remains the canonical unstake path.

### Interaction-rewards card details

The Claim Center card pulls `previewInteractionRewards(address)`
for the headline pending VPFI. Cross-chain finalization gating
(spec §4a) is preserved: when a `dayId`'s global denominator
hasn't been broadcast to this chain yet, the Claim button swaps
for a "Waiting on day {{day}}" pill with a tooltip explaining
why a click would revert. The card hides itself entirely when
the wallet has zero pending and isn't waiting — fresh users
don't see a 0-VPFI promo.

### Lifetime claimed total

A new "Lifetime claimed" sub-line surfaces the cumulative VPFI
the wallet has historically claimed from the interaction-rewards
pool. Sourced by summing every `InteractionRewardsClaimed` event
keyed to the wallet from the per-(chain, diamond) log-index
cache; no on-chain getter for the running total exists, but the
events carry the full history. The line hides itself at zero so
first-time claimers see only "Pending."

### Contributing-loans expandable list

Below the headline, an expandable **Contributing loans** section
enumerates every loan that drives the user's daily share of the
pool — lender-side AND borrower-side rows on the same loan are
listed separately. Each row links to the loan's full Loan Details
timeline and shows either:

- **Ongoing** entries — the snapshot interest accrual rate
  (`{{rate}} USD/day interest`).
- **Closed** entries — total contribution
  (`{{total}} USD over {{days}} day(s)`).
- **Forfeited** entries (defaulted-borrower side, early-
  withdrawal initiator side) — visually de-emphasised since they
  were routed to treasury and no longer feed the user's share.

The display intentionally does NOT show "earned X VPFI on loan
Y" — the rewards aren't directly attributable to a per-loan VPFI
amount because they're daily-normalised by the global denominator,
so showing per-loan VPFI would be a fiction. The list shows
*participation* contribution in 18-decimal USD; the lifetime-
claimed total above shows the actual VPFI the user has received.

### Contract — new view

`InteractionRewardsFacet.getUserRewardEntries(user)` exposes the
existing `userRewardEntryIds` + `rewardEntries` storage as a
public read. Returns the full `RewardEntry[]` array (loanId,
side, startDay/endDay, perDayUSD18, processed, forfeited).
Selector wired into both `DeployDiamond` (18-element array) and
the test-side `HelperTest` cuts (also 18). Two Foundry tests
cover the empty-state contract (`getUserRewardEntries(unknown)
== []`) and the populated-state shape (after pushing a lender +
borrower entry on the same loan via a new `pushRewardEntry`
helper on `TestMutatorFacet`, the view returns both with every
field intact).

### Log-index — new event topic + cache version bump

`InteractionRewardsClaimed(user, fromDay, toDay, amount)` joins
the topic OR-set in the frontend log-index. Cache key bumped
from `v8` to `v9` to force a one-time rescan that captures
historical claims; without the bump, older caches couldn't
backfill incrementally past their `lastBlock` watermark.

## Buy VPFI staking-rewards card — lifetime-claimed total + conditional chrome

The staking-rewards claim card on Buy VPFI Step 2 used to show
only the pending VPFI balance with an always-green chrome and an
"available" headline regardless of state. Two changes:

- **Lifetime-claimed sub-line** added next to "Pending". Sourced
  by summing every `StakingRewardsClaimed(user, amount)` event
  in the per-(chain, diamond) log-index keyed to the connected
  wallet — no on-chain getter for the running total exists, but
  the events carry the full history. Hidden when zero so a
  first-time staker sees only "Pending".
- **Conditional chrome**: green border + tinted background +
  green icon only when `pending > 0` (i.e. there's an actual
  Claim button to press). When pending is zero the card flips to
  neutral chrome with the title "VPFI staking rewards" and the
  body copy: *"Stake VPFI in Step 2 above and your escrow balance
  will earn {{apr}}% APR — you can claim accumulated rewards
  here."* The same conditional applies to the Dashboard inline
  mirror (transparent background + grey icon when empty).
- **Repositioned** to sit right after Step 2 (Deposit / Stake)
  rather than between Step 3 and the VPFI Token panel. Reads as
  a natural causal pairing: deposit here → reward here → claim
  here.

## Navbar polish — link spacing + brand-logo non-shrink

The public Navbar previously had `padding: 8px 16px` on each nav
link and a 24 px `margin-right` between the rightmost dropdown
trigger (VPFI) and the Launch App pill. With four slots
(Learn / Verify / VPFI / Launch App) plus the wallet pill +
gear, the row consumed enough horizontal width that the brand
logo got flex-squeezed below its natural 36 px height on
mid-width desktop. Two CSS-only edits:

- `.navbar-link` horizontal padding `16 → 10` px — saves
  ~12 px per link, ~48 px across the four-slot cluster while
  keeping the four pills visually equivalent (10 px padding
  either side + 8 px parent `gap`).
- `.navbar-links` `margin-right` `24 → 12` px — tightens the
  seam between VPFI dropdown and the Launch App / wallet
  cluster.

Net: ~60 px of horizontal room reclaimed for the brand area;
logo no longer has to shrink on any desktop viewport.

## In-app sticky top bar — `overflow-x: hidden → clip`

The in-app top bar (wallet pill + gear icon + page title) had
`position: sticky` with `top: 0` set on `.app-topbar` for as
long as the AppLayout has existed, but it never actually
stuck — it scrolled away with the page on the first scroll.
Root cause: `.app-main` (the topbar's parent) was set to
`overflow-x: hidden` to swallow horizontal overflow from any
wide child. The `hidden` value silently promotes `overflow-y`
from `visible` to `auto`, which makes `.app-main` a
scroll-container ancestor for sticky-positioning purposes.
Since `.app-main` doesn't actually have a fixed height (it
just `min-height: 100vh`), it never scrolls — but sticky
tracks the nearest scroll-container scrollport, so the topbar
had nothing to stick to relative to that ancestor.

Single-line fix: `overflow-x: hidden → clip`. `clip` preserves
the horizontal-overflow guard without becoming a scroll
container, so sticky now correctly resolves against the
viewport scroll. Topbar pins to the top of the viewport while
the body scrolls behind it, exactly as the original intent.

## Sidebar header / app top bar height parity

The in-app sidebar's brand-row header had free-flowing
`padding: 20px 20px 16px` (~68 px tall) while `.app-topbar` was
fixed at `64 px`, so the horizontal divider underlining both
was 4 px misaligned across the full-width app shell. Sidebar
header now uses `height: 64px; padding: 0 20px;
box-sizing: border-box` so both elements share one continuous
divider line. The collapsed-rail and hover-expand variants got
the same treatment (only the horizontal padding flips between
those states; height stays 64 px in all three).

## Create Offer — submit button properly gated

The Create Offer submit button used to be enabled as long as
`step === "form" && form.fallbackConsent`, which meant a user
could click "Create Offer" with an empty asset address, a zero
amount, an out-of-range duration, etc. and only THEN see the
validation error appear. Eight other required fields — lending
asset address validity, amount > 0, interest rate ≥ 0, duration
in [1, 365], NFT token ID on rentals, collateral / prepay
address validity — were checked exclusively inside the post-
click `handleSubmit` handler.

The button is now disabled whenever `validateOfferForm` returns
an error, and the specific reason renders as the button's
hover-tooltip — so users see what's blocking them live as they
type, without having to click first to discover the gate.

Alongside, the validator was refactored from returning English
strings to returning a discriminated `OfferFormError` union
with typed `code` fields (`lendingAssetInvalid`,
`amountNonPositive`, `rateNegative`, `durationOutOfRange`,
`nftTokenIdRequired`, `collateralAssetInvalid`,
`prepayAssetInvalid`, `fallbackConsentRequired`). The Create
Offer page maps each code to `t('createOffer.validate.<code>')`
with the duration error interpolating the bounds via `{{min}}`
/ `{{max}}` placeholders. Validator strings are now i18n'd
across all 10 locales; the validator itself stays React-free
and can still be unit-tested without a translator.

## Asset-picker red asterisk dropped

The `<AssetPicker>` component (used for both lending and
collateral asset addresses on Create Offer) used to render a
red `*` next to its label when `required` was set. Of the
8+ required fields on the page, only those two showed any
required-marker — Amount, Interest Rate, Duration, NFT Token
ID, Collateral Amount, Quantity, Prepay Asset, and the
fallback-consent checkbox all had plain labels. The lone `*`
gave the misleading impression that only the asset address
was required.

The asterisk is gone. The new submit-button gating (above)
already disambiguates required state — disabled button + hover
tooltip beats per-field marker, especially when consistency
across all required fields would otherwise demand a much
bigger UX rewrite. The `required` prop on AssetPicker still
threads through to the underlying `<input>` / `<select>` for
browser-side validation hooks; only the visible marker
disappeared. The orphan `.asset-picker-required` CSS rule was
cleaned up too.

## Allowances — drop the Uniswap / 1inch reference

The Allowances page subtitle used to read:
*"… Revoke any you no longer need in one click — mirrors the
in-app revoke flow used by Uniswap and 1inch. Non-zero
approvals appear first; …"*

The "mirrors the in-app revoke flow used by Uniswap and 1inch"
clause is gone. The functionality stands on its own; the
competitive name-drop didn't add information for users.
Removed from both `allowances.pageSubtitle` (the live string)
and the orphan duplicate `allowancesPage.subtitle`, in all 10
locales.

## Claim Center — interaction-rewards card upgrade

The interaction-rewards card on Claim Center now shows three
streams of information instead of one:

1. **Pending** (existing) — `previewInteractionRewards(user)`.
2. **Lifetime claimed** — sum of every `InteractionRewardsClaimed`
   event in the log-index keyed to the wallet. `InteractionRewardsClaimed`
   is now in the topic OR-set; cache version bumped `v8 → v9`
   to force a one-time rescan that captures historical claims.
3. **Contributing loans** (expandable) — every loan that drives
   the wallet's daily share of the pool, lender-side and
   borrower-side rows separately. Each row links to the loan's
   full Loan Details timeline and shows ongoing
   (`{{rate}} USD/day interest`) / closed
   (`{{total}} USD over {{days}} day(s)`) / forfeited
   (visually de-emphasised) state.

Backed by a new contract view `getUserRewardEntries(user)` on
`InteractionRewardsFacet` that returns the full `RewardEntry[]`
array (loanId, side, startDay/endDay, perDayUSD18, processed,
forfeited). Selector wired into both DeployDiamond (18-element
array) and HelperTest. Two Foundry tests: empty-state shape and
populated lender + borrower split via a new `pushRewardEntry`
helper on `TestMutatorFacet`.

The display intentionally does NOT show "earned X VPFI on loan
Y" — interaction rewards aren't directly attributable to a per-
loan VPFI amount because they're daily-normalised by the global
denominator, so showing per-loan VPFI would be a fiction. The
list shows participation contribution in 18-decimal USD; the
lifetime-claimed total above shows the actual VPFI received.

## Sidebar order — Claim Center above Buy VPFI

The in-app sidebar's lending block now reads top-to-bottom:
Dashboard → Offer Book → Create Offer → Claim Center → Buy VPFI
→ Activity → Keepers → Alerts → Allowances. Claim Center sits
next to the lending-action items (collecting what loans have
settled or what platform interaction has earned belongs in the
same conceptual block as creating / managing those loans). Buy
VPFI follows as the discretionary token-purchase flow.

## Public-page Navbar clearance — Analytics, NFT Verifier, Buy VPFI

Three more public-shell pages had the same Navbar-overlap bug
the Privacy and Terms pages had earlier today: a 32 px page
top-padding versus the 72 px fixed Navbar height, so the page
heading sat behind the bar on first paint. All three fixed by
bumping to 104 px (72 + 32 breathing room):

- `.public-dashboard` `padding-top` 32 → 104 px on the Analytics
  page CSS.
- `<main>` inline `paddingTop` 32 → 104 on the `PublicNftVerifier`
  shell wrapper in `App.tsx`.
- Same fix on the `PublicBuyVPFI` shell wrapper.

## Protocol-config sweep — every hardcoded number replaced with a live read

The most-impactful piece of today's work. Every percentage,
threshold, and constant the UI used to display from a hardcoded
literal now flows from a single contract source.

**Background.** The site was full of strings like
*"5% APR"*, *"1% treasury cut"*, *"0.1% initiation fee"*,
*"6% slippage cap"*, *"5% buffer"*, *"24% off"*, *"≥ 100 VPFI"*,
*"≥ 1k"*, *"≥ 5k"*, *"> 20k"*, etc. Each of these is a
governance-mutable value (settable via `ConfigFacet` —
`setFeesConfig`, `setVpfiTierThresholds`, `setVpfiTierDiscountBps`,
`setStakingApr`, etc.) or a compile-time constant in
`LibVaipakam`. If governance ever changed a value, or the
contract was redeployed with a bumped constant, the UI would
silently lie to users until someone manually swept ~16 strings
across 10 locales.

**The plan.** The contract already exposed
`ConfigFacet.getProtocolConfigBundle()` returning 8 governance-
mutable values in one read; the only missing piece was the
compile-time constants.

**Contract change.** `ConfigFacet.getProtocolConstants()` view
added — pure, returns `MIN_HEALTH_FACTOR`,
`VPFI_STAKING_POOL_CAP`, `VPFI_INTERACTION_POOL_CAP`,
`MAX_INTERACTION_CLAIM_DAYS`. Selector wired into both
`DeployDiamond` (16-element ConfigFacet array) and the
`HelperTest` test-cuts. New Foundry test
`testGetProtocolConstantsMatchesLibrary` asserts each return
value equals its `LibVaipakam` constant declaration.

**Frontend hook.** `useProtocolConfig` (existing module-cached
hook over `getProtocolConfigBundle`) extended to also fetch
`getProtocolConstants` in parallel and surface every value
plus pre-formatted display helpers (`minHealthFactorDisplay`,
`vpfiStakingPoolCapCompact` → "55.2M", etc.). One RPC pair per
page load shared across every consumer via the existing
module-scope cache.

**Static tier table retired.** The `VPFI_TIER_TABLE` static
export — which had hardcoded `100` / `1k` / `5k` / `20k`
thresholds and `10%` / `15%` / `20%` / `24%` discount labels —
is gone. New `useVpfiTierTable()` hook derives every row's
threshold + discount label from the live `tierThresholds` +
`tierDiscountBps` arrays. The `BuyVPFI.tsx` Discount Status
card (3 consumer sites) migrated to the hook.

**`RENTAL_BUFFER_BPS` constant retired.** The `500n`
hardcoded BigInt constant in `CreateOffer.tsx` (used in the NFT-
rental prepay calculation) replaced with a read from
`protocolConfig.rentalBufferBps`.

**`<CardInfo>` auto-injection.** Rather than wire each
individual `<CardInfo id="…" />` call site to pass live
parameters to its tooltip, the component itself now reads
`useProtocolConfig` and auto-injects 18 named placeholders
into every `cardHelp.*` summary's `t()` call:
`treasuryFee`, `loanInitiationFee`, `liquidationHandlingFee`,
`maxSlippage`, `maxLiquidatorIncentive`, `volatilityLtv`,
`rentalBuffer`, `apr`, `tier1Min..tier4Min`,
`tier1Discount..tier4Discount`, `maxDiscount`,
`minHealthFactor`, `vpfiStakingPoolCap`,
`vpfiInteractionPoolCap`. Per-call `params` still override on
collision.

**i18n sweep.** ~16 strings × 10 locales updated to use
`{{placeholder}}` interpolation in the relevant keys:
- `cardHelp.dashboardFeeDiscountConsent`
- `cardHelp.buyVpfiDiscountStatus`
- `cardHelp.buyVpfiDeposit`
- `cardHelp.offerBookBorrowerOffers`
- `cardHelp.claimCenterClaimsLender`
- `cardHelp.loanDetailsActionsLender`
- `cardHelp.createOfferNftDetails`
- `cardHelp.rewardsOverview`
- `cardHelp.rewardsWithdrawStaked`
- `vpfiDiscountConsent.bodyPrefix`
- `vpfiTokenCard.shareTooltip`
- `vpfiTokenCard.escrowCountsAsStaked`
- `buyVpfiCards.escrowCountsAsStaked`
- `buyVpfiCards.unstakeWarning`
- `buyVpfiCards.inactiveBelowTier1`
- `buyVpfi.step2Info`
- `stakingRewards.subtitleEmpty`
- `lenderDiscountCard.borrowerTitle / borrowerBody1 / lenderTitle / lenderBody1`
- `banners.preflightThinSuffix`
- `createOffer.lifLabel / lifLenderBody / lifBorrowerBody`
- `createOffer.prepayAssetHint`

Net impact: governance can call `setStakingApr(700)` (or
`setVpfiTierThresholds`, or `setFeesConfig`, …) and every UI
surface — tooltips, banner copy, validation messages, tier
tables — picks up the new value on next page load with zero
frontend deploy. A future contract redeploy that bumps
`MIN_HEALTH_FACTOR` or one of the VPFI pool caps does the
same. The compile-time constants `whitepaper.md` references
(in the long-form tokenomics spec) were intentionally left
hardcoded — they're spec content, not live UI.

## LayerZero Phase-1 hardening — closing the last two gaps

The post-Kelp-incident hardening plan from earlier this month
already shipped the bulk of its work: a 3-required + 2-optional
DVN policy with a 1-of-2 threshold; the `ConfigureLZConfig.s.sol`
deploy script that writes that policy onto every (OApp, eid)
pair via `setSendLibrary` + `setReceiveLibrary` + `setConfig`;
per-chain confirmation counts (Eth 15 / Base 10 / OP 10 / Arb 10
/ zkEVM 20 / BNB 15); a chain-scope swap that drops Polygon PoS
(weaker bridge trust) in favour of Polygon zkEVM; a `Pausable`
mixin (`LZGuardianPausable`) on every LZ-facing contract with
guardian-or-owner pause + owner-only unpause; per-request +
rolling-24h rate limits on `VPFIBuyAdapter` (default
`type(uint256).max` = disabled, governance must call
`setRateLimits(50_000e18, 500_000e18)` post-deploy as documented
in CLAUDE.md's mainnet gate); and a Foundry-side conformance
test (`LZConfig.t.sol`) that asserts the policy shape against
the build artifact for every chain in the table.

Two open items remained from that plan: an off-chain monitoring
surface, and a per-packet size sanity check on the reward OApp.
Both landed today.

### `VaipakamRewardOApp._lzReceive` — 128-byte payload pin

Every legitimate REPORT or BROADCAST packet abi-encodes the
same four-field tuple (`uint8` msg-type plus three `uint256`s)
which always serialises to four 32-byte words = 128 bytes
exactly. The previous receive path called `abi.decode` directly,
which silently ignores any bytes past the head — meaning a
forged packet could carry extra trailing data and still parse.
The receiver now strict-equality-checks `_message.length ==
128` at the top of `_lzReceive` and reverts `PayloadSizeMismatch
(got, expected)` if anything else lands. The error carries the
actual length so off-chain monitoring can correlate against
LayerZero scan traces.

Two new Foundry tests in `RewardOAppDeliveryTest.t.sol` confirm
the check works in both directions — one forges an oversized
160-byte payload (5-field encode) and one forges an undersized
96-byte payload (3-field encode). Both pranks the LZ endpoint
to call `lzReceive` directly with the bad bytes (skipping the
legitimate send + DVN-verify path — what an attacker would land
if they ever bypassed peer + DVN auth) and asserts the typed
revert. The original four delivery / quote tests still pass,
so no regression on the canonical 128-byte path.

### `ops/lz-watcher` — internal-only security monitor

A new Cloudflare Worker, deliberately separated from the
existing `ops/hf-watcher`. The split matters: hf-watcher is a
**public-facing competitive surface** — it polls user HF and
also runs the autonomous keeper that anyone can clone via the
sibling `vaipakam-keeper-bot` repo. lz-watcher is **internal
ops only** — its alerts go to a private Telegram channel. Mixing
these on the same Worker would conflate audit trails and risk
leaking incident state.

Three detectors run every 5 minutes:

- **DVN-count drift.** For every `(chain × OApp × peer eid)`
  triple where `peers(eid) != 0`, read `endpoint.getConfig` for
  both the send library and the receive library, decode the
  returned `UlnConfig` bytes, and assert `requiredDVNCount == 3`,
  `optionalDVNCount == 2`, `optionalDVNThreshold == 1`. Any
  deviation indicates either an accidental misconfiguration
  (someone called `setConfig` without going through
  `ConfigureLZConfig.s.sol`) or — worst case — a successful
  compromise of the OApp delegate key writing a weakened policy.
  The Foundry-side `LZConfig.t.sol` only catches drift in the
  builder pre-deploy; this Worker catches drift in the on-chain
  state post-deploy.

- **OFT mint/burn imbalance.** The VPFI OFT design pins all real
  VPFI on Base — every cross-chain transfer locks tokens in the
  canonical adapter and mints an equal amount on the destination
  mirror; reverse path burns mirror supply and unlocks on Base.
  The invariant is therefore exact equality between
  `VPFI.balanceOf(VPFIOFTAdapter)` on Base and the sum of
  `VPFIMirror.totalSupply()` across every mirror chain. Any
  drift, even by 1 wei, means cross-chain messaging integrity
  has failed somewhere — highest-severity alert. Each check
  records a snapshot row in `oft_balance_history` (30-day
  retention) so post-incident forensics can correlate the
  drift's appearance time against on-chain events.

- **Oversized single-tx VPFI flow.** Per chain, `eth_getLogs`
  for ERC20 `Transfer` events on the VPFI / VPFIMirror contract
  since the per-(chain, contract) block cursor stored in the
  `scan_cursor` D1 table. Any event with `value >
  FLOW_THRESHOLD_VPFI` (default 100,000 VPFI in base units)
  triggers an alert with the tx hash, block number, from / to,
  and the value. Catches a successful forge that mints to an
  attacker's wallet on a mirror, a drained adapter / mirror
  moving above expected per-tx volume, or a buggy upgrade that
  lets a borrower extract above the cap. Cap on blocks scanned
  per tick (5,000) bounds the subrequest budget after RPC
  outages cause a multi-day backlog.

Alert dedup is keyed on `(kind, key)` in the `lz_alert_state` D1
table. First fire on transition to bad state, re-fire only if
the offending value changes or 1 hour elapses with the same
value, recovery clears the row + sends a one-time recovery
ping. This keeps Telegram noise low even when a bad config
persists for days.

The Worker is sized for the Cloudflare free tier — 5-min cron
uses 1.4 % of the 100k requests/day budget; steady-state
subrequest count per invocation is ≈ 18-25 (out of 50 free-tier
ceiling); D1 writes ≈ 10/day. RPC keys per chain (Alchemy /
QuickNode / Infura) are required — public RPCs rate-limit
`eth_getLogs` aggressively and the watcher will throttle into
uselessness without dedicated keys.

Three new ops-runbook updates landed alongside the Worker —
`docs/ops/DeploymentRunbook.md` §9 (one-time Worker setup),
`docs/ops/IncidentRunbook.md` §5 (per-alert response SOP for
each of the three detectors), and `docs/ops/AdminKeysAndPause.md`
(extended off-chain operator keys table covering the new
`TG_OPS_CHAT_ID` and per-chain RPC keys held by the lz-watcher
Worker).

## Dashboard — combined rewards summary card

The Dashboard previously surfaced staking rewards via a thin
inline mirror of the Buy VPFI staking-claim card and said nothing
at all about the platform-interaction reward stream. A connected
wallet had no single place to see how much VPFI it had earned
from the protocol overall — only stream-by-stream views, one
buried on Buy VPFI Step 2 and the other inside the Claim Center.

A new **Your VPFI rewards** card now sits between *Discount
Status* and *Your Loans* on the Dashboard. It shows:

- A big *Total earned* headline = staking pending + staking
  lifetime claimed + interaction pending + interaction lifetime
  claimed. Aspirational sum across both streams.
- A staking-yield row (escrow APR) with pending + claimed and
  a chevron deep-link to the Buy VPFI page anchored to
  `#staking-rewards`.
- An interaction-rewards row (per-loan rebate) with pending +
  claimed and a chevron deep-link to the Claim Center anchored
  to `#interaction-rewards`.

The card always renders for connected wallets, even at all-zero
state. A fresh user sees *Total earned: 0 VPFI* with a
"haven't earned yet — here's how to start" hint and the deep
links into both pages still active. Hiding the card on zero
state was rejected because it makes the rewards programs
effectively invisible until a user happens to wander into
either page.

A new shared hook `useRewardsClaimedHistory(address)` consolidates
the lifetime-claimed log-index scan that previously lived
duplicated inside the staking and interaction claim cards.
All three reward surfaces now read from the same scan, so a
user clicking through Dashboard → Buy VPFI → claim → return
sees the lifetime number tick up consistently across all three
on the next render. Both existing claim cards
(`<StakingRewardsClaim>` on Buy VPFI, `<InteractionRewardsClaim>`
on Claim Center) gained `id` attributes so the new card's
deep-link chevrons scroll the user to the right card on arrival.

i18n added a fresh `rewardsSummary.*` namespace (11 keys)
across all 10 locales — title, totalEarnedLabel, freshUserHint,
the per-stream titles + subtitles, pending/claimed labels, and
the "Manage on Buy VPFI" / "Claim on Claim Center" link copy.
The CardInfo (i)-tooltip registry got a matching entry under
`dashboard.rewards-summary` with auto-injected `{{apr}}`
placeholder so the description stays accurate when governance
changes the staking APR.

## VPFI tier thresholds — wei → tokens display fix

The Dashboard's **Your VPFI discount status** card was
rendering tier-threshold values as
`100,000,000,000,000,000,000` instead of `100,000`. Same bug
on the tier-table rows, the *inactive below Tier 1* status
copy, the *Deposit X more to reach Tier N* hint, and every
`<CardInfo>` (i)-tooltip that interpolates a `{{tier1Min}}` /
`{{tier2Min}}` / `{{tier3Min}}` / `{{tier4Min}}` placeholder
(e.g. the dashboard's *Fee discount consent* card help, the
Buy VPFI *Discount status* card help, the platform-level
discount-consent card body copy).

Root cause: the on-chain getter returns tier thresholds in
VPFI base units (1e18-scaled wei). Three call sites —
`useVpfiTierTable`, the `<CardInfo>` auto-injection block, and
the `<VPFIDiscountConsentCard>` body-prefix interpolation —
each ran `Number(config.tierThresholds[i])` and
`.toLocaleString()` on the raw wei bigint, getting back a
20-digit number with thousands separators that read like a
catastrophe rather than a tier minimum.

Fix: a new derived field `tierThresholdsTokens:
[number, number, number, number]` on `ProtocolConfig`,
pre-divided by 1e18 inside `useProtocolConfig` (bigint divide
first to stay lossless above 2^53, then `Number` cast). All
three call sites now consume `tierThresholdsTokens` instead
of `tierThresholds`. Same pattern as the existing
`minHealthFactor` → `minHealthFactorDisplay` and
`vpfiStakingPoolCap` → `vpfiStakingPoolCapCompact` display
helpers — the raw bigint stays available on the config object
for any future math caller, but every UI surface goes through
the pre-formatted variant.

A wider audit caught the only three affected locations
(grep for `Number(config.tierThresholds` etc. is now empty
across the whole `frontend/src/` tree). The other wei-
denominated config fields (`minHealthFactor`, the two pool
caps) were already using their `*Display` / `*Compact`
helpers so they rendered correctly all along.

## CardInfo "Learn more →" anchors — only the new card needed wiring

Every CardInfo (i)-tooltip in the app surfaces a
*Learn more →* external link to `/help/basic#<id>` or
`/help/advanced#<id>` based on the active UI mode. The
expectation: each registered id resolves to an
`<a id="<id>"></a>` anchor inside the user-guide markdown so
the click scrolls the guide to the matching section.

An initial audit today flagged this as broken across all 53
registered CardInfo ids. That diagnosis was wrong — it was
based on the stub redirect files at `docs/UserGuide-Basic.md`
and `docs/UserGuide-Advanced.md`, which have zero anchors but
also zero content. The actual canonical user-guide source
lives at `frontend/src/content/userguide/{Basic,Advanced}.<locale>.md`
(20 files: 2 modes × 10 locales) and those files already
contain anchored sections for every existing CardInfo id —
including the role-keyed `:lender` / `:borrower` variants
where the registry uses a role-keyed summary.

The only id that genuinely had no anchor was the new
`dashboard.rewards-summary` shipped today. Fix: a "Your VPFI
rewards" section was added to all 20 files (Basic + Advanced
× 10 locales) immediately after the existing fee-discount-
consent section, with the matching `<a id="dashboard.rewards-summary"></a>`
anchor and locale-appropriate body copy (Basic mode keeps the
register friendly + conversational; Advanced uses the
function-name + log-index-event-scan vocabulary that matches
that mode's voice elsewhere).

Net effect: every CardInfo (i)-tooltip in the entire app —
including the new dashboard rewards card — now scrolls the
user guide to the right section on click in every supported
locale and both modes.

## VPFI decimals — read live from the token contract, not hardcoded

The frontend had seven separate hardcoded references to the VPFI
token's 18 decimals scattered across `useProtocolConfig.ts`,
`useVPFIDiscount.ts` (`SCALE_18` constant + `formatVpfiUnits` /
`vpfiToEthWei` / `ethWeiToVpfi` helpers), `useVPFIToken.ts`
(`TOKEN_DECIMALS_SCALE`), and `useUserVPFI.ts` (a fourth copy of
the same `1e18` constant). All seven are now driven from a single
live `decimals()` read on the registered VPFI token contract.

How it works: `useProtocolConfig` already fetches the governance
bundle in parallel with the compile-time constants. It now also
reads `getVPFIToken()` to get the token address, then calls
`decimals()` on that address, and exposes the resolved value as
`vpfiDecimals: number` on the `ProtocolConfig` object. Every
display helper takes an optional `decimals` parameter that
defaults to 18 (the contract truth — every Vaipakam VPFI deploy
on every chain must use 18 by OFT-bridge requirement), and
callers that have access to the loaded config pass the live
value explicitly. A failed `decimals()` read falls back to 18
gracefully so the UI keeps rendering correctly while the read
is in flight or after a transient RPC failure.

Why it matters in principle: VPFI's decimals is fixed at 18 in
the contract source today (OpenZeppelin ERC20 default, no
override), but pinning every display path to a hardcoded 18
locks in an assumption that requires a multi-file sweep to
unwind if VPFI ever needs to be redeployed with different
decimals. Reading from the contract makes the invariant
self-enforcing — if a future deploy ever changes the value,
the UI auto-adjusts on next page load.

## VPFI Discount Status card — moved from Dashboard to Buy VPFI

The read-only `<DiscountStatusCard>` (current tier + escrow VPFI
+ shared-consent qualification status + the four-row tier
reference table) lifted from the Dashboard to the Buy VPFI page,
slotted between the page hero and Step 1 — Buy VPFI with ETH.

The move mirrors the buying-decision UX: when a user is sizing
how much VPFI to acquire, the question they're answering is
"what tier does this purchase land me in?" — and the answer
needs to be co-located with the question. The Dashboard kept
the **consent toggle** (the actionable surface where the user
opts in / out of the shared-fee-discount path); the read-only
status table is now where the buying decision happens.

The card renders only for connected wallets. A disconnected
visitor seeing "Inactive · below Tier 1 (100 VPFI in escrow)"
on the public Buy VPFI page would read as a problem rather than
a not-yet state. Same `useVPFIDiscountTier` / `useEscrowVPFIBalance`
/ `useVPFIDiscountConsent` reads as before, just rendered in a
different home.

Bonus picked up by the move: the consent-status sub-text
(*"Enable the shared discount consent above."*) is now
*"Enable the shared discount consent on the **Dashboard**."*
with the word "Dashboard" rendered as an inline `<L>` link
that drops the user one click away from the toggle. The link
is locale-aware via `react-i18next`'s `<Trans>` component with
a `<dashboardLink>` placeholder; all 10 locales updated with
the link wrapper in the matching position.

## Offer book closed view — loan-link next to the Filled pill

In OfferBook's *Closed* status view, every row has been a
filled offer (cancelled offers are filtered out at the data-
source level since `cancelOffer` deletes the on-chain storage
slot). Until today the only signal that a row was *closed*
was the green Filled pill in the action column — there was no
way to jump from the offer to the loan it became.

The action cell now reads `[ Filled ]  Loan #87 →` where the
loan id is a clickable `<L>` link to `/app/loans/87`. Data path:
the existing log-index already captures `OfferAccepted(offerId,
acceptor, loanId)` events; the OfferBook page now derives a
`Map<offerId, loanId>` once via `useMemo` over the events array,
passes it to both `<OfferTable>` instances (lender + borrower),
and the row renderer looks up the loan id when in Closed view.
Zero new RPC, zero new contract surface — pure client-side
join over data the index was already streaming.

Cancelled offers don't appear in the Closed view (the storage
slot is deleted on cancel) and so don't get a link — that case
is handled by the new Your Offers card below.

## Dashboard — Your Offers card with chip filter

The Dashboard's "Your Active Offers" card became "Your Offers"
with a four-state chip filter — `Active · Filled · Cancelled ·
All` — surfaced via the existing `<Picker>` control. The
filter switches the underlying data source between live offer
reads and event-driven reconstruction, with each row's render
gated on its lifecycle state.

This addresses the missing-feature gap that until today
**users had no way to cancel an offer from the website**.
`cancelOffer` existed on-chain but had no UI button anywhere
in the frontend. Active rows in the new card now carry a
**Cancel button** alongside the existing "Manage keepers"
deep-link; clicking it submits the `cancelOffer(offerId)`
write directly. The button disables while the tx is in
flight to prevent double-clicks. Failure toasts surface the
typed error (most commonly `OfferAlreadyAccepted` if a
concurrent `acceptOffer` won the block-ordering race —
handled cleanly on-chain so only one of the two txs ever
takes effect; the loser reverts without state corruption).

Filled rows in the new card render with the same `[ Filled ]
Loan #N →` link the OfferBook Closed view introduced — so
the user has a single canonical home for "the offers I
created and what happened to them."

The chip-filter UX defaults to **Active**, preserving the
exact behaviour of the previous Your Active Offers card. A
user who never touches the chip group sees no UX change.

## Cancelled-offer reconstruction — `OfferCanceledDetails` event + localStorage snapshot

Showing cancelled offers ran into a data-availability wall:
`cancelOffer` does `delete s.offers[offerId]` on the storage
slot, and the legacy `OfferCanceled` event only emits
`(offerId, creator)` — no financial terms. So a freshly-loaded
"Your Offers / Cancelled" view had no source for the asset,
amount, rate, duration, or collateral of the cancelled offer
beyond the user's memory.

Two complementary fixes shipped together:

**Contract change — `OfferCanceledDetails` companion event.**
A new event emitted alongside the legacy `OfferCanceled` with
the full offer-term tuple: `offerType`, `assetType`,
`lendingAsset`, `amount`, `tokenId`, `collateralAsset`,
`collateralAmount`, `interestRateBps`, `durationDays`. The
emit happens **before** the storage delete so every field is
still readable. The legacy `OfferCanceled` keeps emitting
unchanged so historical consumers that only need identity
(id + creator) work without modification — purely additive.
A new Foundry test (`testCancelOfferEmitsRichDetailsEvent`)
asserts both events fire with the expected args.

**Frontend — `offerSnapshot` localStorage helper.** A small
browser-local cache keyed by `(chainId, diamondAddress,
offerId)`. `useMyOffers` writes a snapshot on every live-fetch
of an active offer (cheap synchronous setItem per row), so by
the time a user cancels their own offer the terms are already
cached. Read at render time when a cancelled row needs
rehydration. Quota-overflow handling prunes oldest entries
when localStorage hits its limit.

**Three-tier hydration priority** for cancelled rows in
`useMyOffers`: (1) `OfferCanceledDetails` event from the
log-index — best, on-chain, works on any synced cache;
(2) `offerSnapshot` localStorage — fallback, same-browser-only,
covers offers cancelled before the new event was deployed;
(3) identity-only stub — last resort, renders compact `—`
cells with a tooltip explaining the constraint.

The `MyOffersTable` renderer branches on data availability
per cancelled row: if the row has full data (event or snapshot
hit), it renders every column normally with a dimmed style
(opacity 0.65) and a Cancelled pill in the status column. If
the row is identity-only, it falls back to compact rendering
with `—` cells.

Log-index cache version bumped v9 → v10 to force a fresh
scan that picks up the new `OfferCanceledDetails` event for
existing users without manual cache clear. The
`OfferCanceledDetails` event kind is filtered out of the
user-facing Activity feed and Loan Timeline — it's a hydrate-
only companion to `OfferCanceled` (same user action), not a
distinct timeline-worthy event.

## Unified `<PrincipalCell>` — Asset + Amount merged into one column

`OfferTable` historically split the principal display across
two columns ("Asset" — type label + symbol; "Amount" — number).
Your Loans had merged them into a single Principal column long
ago, leading to inconsistent row layouts between the two
surfaces. A new `<PrincipalCell>` component unifies the
rendering across three asset-type cases:

- **ERC20**: amount + symbol stacked (e.g. `1,000` / `USDC`).
- **ERC721**: `NFT #42` + collection symbol with an inline
  `<ExternalLink>` icon to the chain explorer's NFT-page
  viewer (`<base>/nft/<contract>/<tokenId>`) — the explorer
  page renders the image, traits, and ownership history,
  qualitatively new info beyond the symbol.
- **ERC1155**: `5 × NFT #42` + collection symbol with the
  same explorer link.

The component renders an explorer link **only for NFTs** by
intent. Adding link icons to every ERC20 row would clutter
the table for marginal payoff — major-token symbols (USDC,
ETH, USDT) are self-explanatory; pre-action token vetting
already lives on the Create Offer review surface where
`<TokenInfoTag>` shows CoinGecko rank / "unknown token"
warning.

`OfferTable` (public OfferBook), the new `MyOffersTable`
(Your Offers card), and Your Loans on the Dashboard all use
the same component. Your Loans previously rendered NFT-
principal loans (rentals) as `1 [Symbol]` — dropping the
tokenId entirely; now they render as `NFT #N` correctly.
Adding `assetType` + `principalTokenId` to `LoanSummary` and
threading them through `useUserLoans` enabled this.

## Loan ID — clickable in Your Loans

The Your Loans table's first column (the loan id, e.g.
`#142`) now wraps the id in a `<L>` link to
`/app/loans/142` instead of rendering as plain text. The
"View" button in the last column stays — same destination,
just two click targets so the leftmost cell users read first
is also the one they can act on. Removes the hidden-action
problem on narrow viewports where the action column scrolled
off-screen.

## Position NFT — name + symbol changed to "Vaipakam NFT" / `VAIPAK`

The position NFT (the ERC-721 collection that mints one token
per loan side, tracking lender / borrower positions) was
previously initialised as `name = "VaipakamNFT"`,
`symbol = "VNGK"`. Both were chosen ad-hoc early in the
project's life and never matched the protocol's brand
elsewhere — VPFI is the token, Vaipakam is the protocol, and
VNGK was an orphan abbreviation that didn't appear anywhere
else in the user-facing surface.

New values: `name = "Vaipakam NFT"`, `symbol = "VAIPAK"`. The
name reads naturally on OpenSea / wallet collection pages;
the symbol is six characters (matches DOODLE's length, sits
within the comfortable range for NFT marketplace UIs) and
stays brand-recognisable.

**Deliberately no admin setter.** `LibERC721.initialize`
already enforces one-shot via `ERC721AlreadyInitialized` —
preserving that is the right move. NFT name/symbol are part
of contract identity that marketplaces, wallets, and indexers
cache at first index; mutable identity is both an attack
surface (compromised admin → rename to scam) and a UX hazard
(wallets can't tell if it's still the same collection).
Existing testnet deploys retain the old `VaipakamNFT` /
`VNGK` baked in until redeployed; mainnet locks in the new
values at first deploy.

The on-chain test (`testNameAndSymbol` in
`VaipakamNFTFacetTest.t.sol`) was updated to assert the new
values. The frontend has zero hardcoded references to the
old name / symbol — it reads `name()` / `symbol()` live from
the contract — so all UI surfaces auto-pick up the new
values on next deploy with no frontend change required.

## Partial repayment — lender-gated opt-in

Borrower-initiated partial repayment (`RepayFacet.repayPartial`)
existed on-chain since Phase 1 but was an unconditional borrower
right — any borrower could partially pay down any loan at any
time. Today's change converts it into an explicit consent gate
between the offer's two sides: the **offer creator opts in** when
they author the offer; the acceptor consents implicitly by
accepting it. Default is off — when no one opts in, only full
repayment is accepted on-chain and any `repayPartial` attempt
reverts with a typed `PartialRepayNotAllowed` error.

The mechanic is symmetric across both offer sides because the
contract treats the offer-side as the configuration layer, not the
acceptor:

- **Lender offer with the flag set** — the lender is permitting
  partial repay up front. Any borrower who accepts is signing on to
  a loan that can be partially repaid. The lender knows their cash
  flow won't be a single lump sum at maturity.
- **Borrower offer with the flag set** — the borrower is requesting
  the right to repay in chunks. The lender either accepts (and
  thereby consents to that arrangement) or skips the offer.

There's no `acceptOffer` signature change and no acceptor-side
override. The single creator-set flag carries the entire
consent semantics; the act of accepting is the acceptor's
agreement.

**Storage shape.** A new `bool allowsPartialRepay` field on the
`Offer` struct (slot-1 packed alongside the creator address +
type/asset enums — zero gas overhead) and on the `Loan` struct
(slot-3 packed alongside the borrower address). Snapshotted from
offer to loan at `LoanFacet.initiateLoan` and immutable thereafter
— a loan's terms can't drift mid-flight from the deal both sides
agreed to.

**Enforcement.** `RepayFacet.repayPartial` reads `loan.allowsPartialRepay`
at the top of the call and reverts `PartialRepayNotAllowed()` if
false. Two new Foundry tests (`testRepayPartialRevertsWhenLenderOfferDisallowed`
+ `testRepayPartialSucceedsWhenBorrowerOfferAllowed`) lock the
default-off + opt-in-true posture for both offer sides. All 18
existing partial-repay tests stay green; full no-invariants
regression 1402 / 0 failed / 5 skipped (the 5 are fork-gated
Permit2 tests that need `FORK_URL_MAINNET`).

**UI surfaces.**

- **Create Offer** — a new checkbox in the Advanced Options card
  (alongside the keeper-access toggle) labelled *"Allow borrower-
  initiated partial repayment"*. The hint text underneath flips
  with the offer side: a lender-offer creator sees "the borrower
  can call repayPartial to pay down principal in chunks before the
  term ends"; a borrower-offer creator sees "request the right to
  repay this loan in partial chunks. The lender consents
  implicitly by accepting your offer." Both forms localised across
  all 10 locales (`createOffer.allowsPartialRepayLabel` +
  `createOffer.allowsPartialRepayHintLender` +
  `createOffer.allowsPartialRepayHintBorrower`).

- **Accept Review modal** — a new "Partial repay" row in the offer-
  terms data-list, between Liquidity and the discount-preview
  block. Renders either *"Allowed — borrower may repay this loan
  in chunks"* or *"Not allowed — only full repayment is accepted"*.
  Localised under the new `acceptReview.*` namespace
  (`partialRepayLabel` + `partialRepayAllowed` +
  `partialRepayNotAllowed`).

- **Liquidation Projection (Loan Details)** — the partial-repay
  what-if slider on the existing projection card now hides itself
  when the loan's `allowsPartialRepay` is false. Showing a slider
  whose action would revert with `PartialRepayNotAllowed` would be
  a UX trap; matching the on-chain truth is the right shape. The
  add-collateral and price-drop sliders stay regardless.

`LoanSummary` and `LoanDetails` types both gained the field;
`useUserLoans` projects it through to the Dashboard's Your Loans
table; `OfferData` and `RawOffer` carry it from `getOffer`
through `useMyOffers` to the AcceptReviewModal. ABI re-export
covered every consumer in one pass.

## Liquidation Projection — collateral-drop slider shows the resulting price

The **Collateral price drop** slider on the Liquidation Projection
card (Loan Details) used to render only the percentage value
("30%") next to the range input. A raw percent doesn't tell users
what the collateral would actually be worth at that drop — they
had to do the dollar-math in their head against the live oracle
price.

The label now interpolates the resulting absolute price alongside
the percent: `30% · $42.18`. Sourced by multiplying the cached
`collPriceUsd` (read once on mount via `OracleFacet.getAssetPrice`)
by `(1 - dropPct / 100)` on each render. Gracefully degrades to
percent-only when the oracle is unavailable
(`collPriceUsd === null`) — no `"30% — $—"` half-rendered state.

## In-app shell — ambient gradient backdrop

The in-app shell's background was a flat solid colour while the
public landing page hero carried a subtle dual radial gradient
(brand-purple top-center + brand-light bottom-right) that sets the
visual tone. Crossing the wallet-connect threshold from the
landing page into the app dropped that ambience entirely.

Two CSS pseudo-elements on `.app-layout` (`::before` + `::after`)
now mirror the same dual radial pattern as fixed-position
backdrops behind every in-app page. Brand-purple `rgba(79, 70,
229, 0.08)` ellipse top-center; brand-light `rgba(129, 140, 248,
0.06)` ellipse bottom-right. Opacity intentionally lower than the
landing page (0.08 vs 0.12) since the in-app surface carries
denser foreground content — the gradient should set tone without
competing with cards / tables / forms.

`pointer-events: none` + `z-index: -1` on both pseudo-elements so
they stay purely decorative and don't intercept interaction. The
backdrop tracks viewport (not page-content) via `position: fixed`,
so scrolling a long page doesn't drag the gradient with the
content.

## Navbar dropdown — `aria-hidden` → `inert`

Chrome DevTools was warning on every Navbar dropdown interaction:
*"Blocked aria-hidden on an element because its descendant
retained focus. The focus must not be hidden from assistive
technology users."* Triggered when a dropdown item received focus
inside a sibling group whose collapsed-state was using
`aria-hidden={true}` to hide it from assistive tech.

The intent was right (collapsed dropdown groups shouldn't be
exposed to screen readers); the implementation was wrong.
`aria-hidden` is for nodes that visually exist but should be
invisible to AT — it explicitly conflicts with focusable
descendants because focus lands on a node that screen readers
can't read out, breaking keyboard navigation.

The correct primitive for "this whole subtree is non-interactive
and should not appear in a11y tree" is the `inert` attribute,
which atomically blocks both focus and AT exposure. Replacing
`aria-hidden={openGroup !== group.id}` with
`inert={openGroup !== group.id}` resolves the warning and is the
strictly-correct semantic — `inert` is exactly the API the W3C
added in 2022 for this case.

## Log-index cache — version reset to v1, topic OR-array slimmed

Two tightly-related fixes: a versioning cleanup and a silent-bug
recovery.

**Versioning reset to v1.** The browser-side log-index cache key
had inflated to `v10` over the past two weeks of incremental
schema changes. Each change forced a full-rescan migration on the
next page load — fine on a live deploy where preserving cached
state across schema bumps is non-negotiable, but the project is
**still pre-live**: every deploy so far has been against
testnet/dev, no real user data flows through the cache, and the
inflating version number was telegraphing a maturity the codebase
doesn't have yet. Reset to `v1` with a one-line policy comment in
the source: *"This is the cache key version. The number bumps
when the schema of cached data changes in a way that requires a
full rescan to reconstruct. While pre-live, we don't bump — every
schema change just resets to v1 and forces every browser to
rescan once."* Once mainnet ships, the version-bump discipline
flips back on.

**`OfferCanceledDetails` dropped from the topic OR-array.** The
log-index `eth_getLogs` call passes a single OR-array of every
event topic the cache cares about. Adding the new
`OfferCanceledDetails` topic earlier today pushed the array past
~24 entries, which is the silent cap publicnode's free RPC
applies — past that count the call returns an empty array with
no error, no warning, and a 200 status. Symptom in the field:
offers and loans stopped loading on Sepolia despite zero browser-
console errors. Diagnosis took an hour because the failure mode
was indistinguishable from "no events match the filter."

`OfferCanceledDetails` is hydrate-only — it has no surface in the
Activity feed or Loan Timeline; its only consumer is the
"Cancelled" tab on Your Offers, which already three-tier-hydrates
from event → snapshot → identity-stub. Pulling it out of the OR-
array drops the count back below the cap; the topic constant +
its decoder branch stay defined so when the hydrate path *does*
need the rich payload (rare — only when both the localStorage
snapshot and the event-emit flow have been bypassed), it can be
re-added incrementally without re-introducing the cap problem.

## Asset linking — NFT to OpenSea / Verifier, ERC-20 to CoinGecko

Every place that renders a token symbol in the app now lets the
user click through to the most useful third-party page for that
asset, with the destination chosen automatically per asset kind +
chain:

- **Vaipakam position NFTs** (lender / borrower NFTs minted per
  loan against the Diamond's own ERC-721 surface) — link to the
  in-app `/nft-verifier` page, since OpenSea would only show the
  image; the verifier proves the position is live + un-transferred
  against the on-chain loan struct.
- **Third-party NFTs** (rental loan principals, NFT collateral) —
  route to OpenSea where the chain has a v2 surface (Ethereum,
  Base, Arbitrum, Optimism mainnet + Sepolia / Base Sepolia /
  Arbitrum Sepolia / Optimism Sepolia testnets); fall back to the
  chain explorer's `/nft/<contract>/<tokenId>` viewer on chains
  OpenSea doesn't index (BNB Chain, Polygon zkEVM, BNB testnet,
  Polygon zkEVM Cardona).
- **ERC-20 tokens** — route to CoinGecko's `/coins/<id>` page when
  the token is indexed there; fall back to the chain explorer's
  `/address/<contract>` page when CoinGecko returns "unknown."
  Resolution runs through `useVerifyContract` (existing debounced
  + localStorage-cached helper), so the first render falls back to
  the explorer link for ~400ms until the lookup lands; subsequent
  renders are free.

Three new modules drive this:

- `frontend/src/lib/nftLink.ts` — pure helper
  `nftLinkFor(chainId, contract, tokenId)` returning
  `{href, kind: 'verifier' | 'opensea' | 'explorer'}`. Diamond
  address comparison decides the verifier route; chain registry
  decides OpenSea vs explorer.
- `frontend/src/lib/erc20Link.ts` — pure helper
  `erc20LinkFor(chainId, contract, coinGeckoId | null)` returning
  `{href, kind: 'coingecko' | 'explorer'}`. Caller passes the
  CoinGecko id (or null) — keeps the helper sync + testable.
- `frontend/src/components/app/AssetLink.tsx` — React component
  that wraps `<AssetSymbol>` (or a custom label) with the right
  href; auto-fetches the CoinGecko id internally on the ERC-20
  path. Renders an inline external-link icon next to the symbol.
  In-app verifier links use `react-router` SPA navigation; the
  rest open in a new tab.

Consumers updated:

- `<PrincipalCell>` (Dashboard Your Loans, OfferBook, MyOffersTable)
  — drops the per-row `blockExplorer` prop, takes `chainId`
  instead. Both ERC-20 and NFT rows now wrap their symbol in
  `<AssetLink>`. The OfferBook public table picked up clickable
  ERC-20 links it didn't have before.
- `<OfferTable>` interface gains a `chainId` prop; both call sites
  in `OfferBook.tsx` pass `activeReadChain.chainId`.
- `<MyOffersTable>` prop renamed `blockExplorer → chainId`; the
  Dashboard caller updated.
- `LoanDetails.tsx` principal-asset and collateral-asset rows: the
  inline `<a href={blockExplorer}/address/{loan.principalAsset}>`
  patterns replaced with `<AssetLink>` that branches on
  `loan.assetType` (ERC-20 vs NFT) so rental loans correctly route
  to OpenSea / verifier instead of the address page.

i18n: 4 new keys under `assetLink.*` namespace (`openOnCoinGecko`,
`openOnOpenSea`, `openOnExplorer`, `openOnVerifier`) translated
across all 10 locales. `tsc -b` clean.

OpenSea chain coverage table for the Phase 1 chain set:

| Chain | OpenSea support | Fallback |
|---|---|---|
| Ethereum mainnet | ✅ `opensea.io/assets/ethereum` | — |
| Base | ✅ `opensea.io/assets/base` | — |
| Arbitrum | ✅ `opensea.io/assets/arbitrum` | — |
| Optimism | ✅ `opensea.io/assets/optimism` | — |
| Polygon zkEVM | ❌ no v2 surface | zkevm.polygonscan.com |
| BNB Chain | ❌ no v2 surface | bscscan.com |
| Sepolia / Base Sepolia / Arb Sepolia / Op Sepolia | ✅ `testnets.opensea.io` | — |
| BNB Testnet / zkEVM Cardona | ❌ | block explorer |

## Documentation convention

Same as carried forward from prior files: every completed phase
gets a functional, plain-English write-up under
`docs/ReleaseNotes-…md`. No code. Function names, tables, and
exact selectors live in the codebase; this file describes
behaviour to a non-engineer reader (auditor, partner team,
regulator).
