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
borrower entry back to its full Loan Details page).

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

## Documentation convention

Same as carried forward from prior files: every completed phase
gets a functional, plain-English write-up under
`docs/ReleaseNotes-…md`. No code. Function names, tables, and
exact selectors live in the codebase; this file describes
behaviour to a non-engineer reader (auditor, partner team,
regulator).
