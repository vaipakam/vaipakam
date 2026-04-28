# Release Notes — 2026-04-28

Functional record of everything delivered on 2026-04-28, written as
plain-English user-facing / operator-facing descriptions — no code.
Grouped by area, not by chronology. Continues from
[`ReleaseNotes-2026-04-27.md`](./ReleaseNotes-2026-04-27.md).

Coverage at a glance: **Tamil + Simplified-Chinese user guides
(Basic + Advanced)** brought to parity with the other eight
locales, **system-default theme** (light/dark follows the user's
OS preference until they pick one), **Diagnostics → Report Issue**
rename across all 10 locales, **frontend ABI sync script** so
contract-side struct changes can never silently outpace the
frontend's call shape, **Buy VPFI page moved outside the app
shell** with a public top-bar VPFI dropdown (Buy / Stake / Unstake),
**open staking** explicitly surfaced (anyone can earn the 5% APR
yield without having to open a loan first; escrow auto-creates on
first deposit), **NFT Verifier links open in a new tab** from
inside the app with an external-tab icon, **interest-implication
warnings** on every borrower-driven exit (Preclose / Refinance) and
the lender-driven Early Withdrawal flow, **rate-delta column** on
the Offer Book swapped from a direction-stripped `(±X%)` to a
signed `(+X%)` / `(−X%)` annotation with a tooltip explaining the
market-anchor concept, **filter-scoped market anchor** (rolling
list of recent matches replaces the single global "last accepted"
rate so flipping any filter dimension no longer blanks the
column), **column sorting** on the Dashboard "Your Loans" table
(default: most recent first by ID descending), **Dashboard "Your
Loans" pagination + filters** (Role / Status / Per page), and
**chain-picker-style filter pills** rolled out across both the
Dashboard filters and the Offer Book filters card so all three
filter surfaces share one visual language.

## Tamil + Simplified-Chinese user guides

Phase 3 of the Translation programme called for Markdown-side
parity across every supported app-locale. Tamil and Simplified
Chinese were the last two without `Basic.<lang>.md` /
`Advanced.<lang>.md` files. Both pairs landed today, structurally
identical to the English originals — every anchor ID preserved
verbatim (64 anchors per file × 4 files), every glossary term
(VPFI, ERC-20, HF, LTV, APR, Health Factor, Chainlink, LayerZero,
Uniswap V3, etc.) kept in English. Each file uses its locale's
DeFi loanword conventions consistent with the existing UI strings:
Tamil mixes Tamil syntax with English crypto loanwords (escrow,
collateral, lender, borrower, swap, bridge, mint, burn, claim);
Chinese keeps the same loanwords inline within otherwise-Chinese
prose. The locale-aware User Guide loader picks them up
automatically — the English-only fallback notice no longer
renders in `/help/basic` or `/help/advanced` for Tamil or
Simplified-Chinese readers.

The Advanced files also went through one pass of code-identifier
stripping — every `dot.method` reference and CONST_NAME hex blob
was rewritten in plain prose so the long-form guide reads more
like product documentation than a code reference.

## System-default theme

Theme defaulted to **system** instead of forcing a fixed light /
dark choice on first visit. The site reads
`prefers-color-scheme` once and renders accordingly. The
existing manual override (Settings → Theme → Light / Dark) still
locks the choice and survives across sessions. Users on dark-mode
laptops no longer see a blinding light-mode flash before the
site adapts.

## "Diagnostics" → "Report Issue"

The floating-action-button at the bottom-right of every page
(plus the drawer it opens) was previously labelled "Diagnostics"
in every locale. Renamed to **"Report Issue"** (button) and
**"Issue Details"** (drawer title), since "diagnostics" reads as
intimidating engineering jargon. The actual functionality is a
self-serve generator that bundles a redacted markdown report
to paste into a GitHub issue. The new name maps closer to that
purpose without overpromising live human support.

Translated into all 10 locales:
- Arabic: الإبلاغ عن مشكلة / تفاصيل المشكلة
- German: Problem melden / Problemdetails
- Spanish: Reportar problema / Detalles del problema
- French: Signaler un problème / Détails du problème
- Hindi: समस्या रिपोर्ट करें / समस्या विवरण
- Japanese: 問題を報告 / 問題の詳細
- Korean: 문제 신고 / 문제 세부 정보
- Tamil: சிக்கலைப் புகாரளி / சிக்கல் விவரங்கள்
- Chinese: 报告问题 / 问题详情

## Frontend ABI sync script + runbook entry

Earlier this week a contract-side struct change (Phase 6 dropped
`keeperAccessEnabled` from `CreateOfferParams`) outpaced the
frontend's hand-imported ABI bundles, and the result was an
opaque "exceeds max transaction gas limit" failure on Base Sepolia
public RPCs (those RPCs wrap a calldata-shape mismatch as a
generic gas-limit error, not as a revert reason). The fix is a
sync script — parallel to the existing keeper-bot ABI sync.

`contracts/script/exportFrontendAbis.sh`, run after `forge build`,
re-exports every facet ABI the frontend imports (27 today) into
`frontend/src/contracts/abis/` and stamps `_source.json` with the
contracts-repo commit hash so a frontend bundle can be correlated
back to a specific contracts state.

CLAUDE.md grew a new section that documents when to run it. The
deployment runbook (`docs/ops/DeploymentRunbook.md` §7.5 — covers
both consumers in one place) and the per-chain
Base-Sepolia runbook (`§14`) call out the sync as a mandatory
post-deploy step on any release that touches a public selector or
struct shape. Per-chain runbooks now inherit from §7.5 instead of
duplicating the long form.

## Buy VPFI moved outside the app

Previously `/app/buy-vpfi` was an in-app page reached through
the sidebar nav. Buying VPFI is permissionless — anyone with ETH
on a supported chain can swap for VPFI, no wallet-internal state
needed at browse time. The page now lives at the public route
`/buy-vpfi` (Navbar + Footer chrome, like the NFT Verifier),
discoverable directly from the landing page without going
through the in-app sidebar.

The same `<BuyVPFI>` component renders in both contexts; only
the chrome around it changed. The in-app sidebar still has the
"Buy VPFI" entry, but it now opens the public page in a new tab
(an external-link icon next to the label communicates this). The
Hero CTA on the landing page also points to the public route.

Every other place inside the app that linked to Buy VPFI was
updated to open in a new tab too — the Lender Discount banner on
Create Offer, the offset-collateral hint on the Offer Book accept
flow, the discount banner on Loan Details, and the Discount
Consent card on the Dashboard.

## Top-bar VPFI dropdown on the landing page

The public Navbar gained a third dropdown group — **VPFI** —
sitting alongside the existing Learn and Verify groups. Three
items:

- **Buy** → `/buy-vpfi#step-1`
- **Stake** → `/buy-vpfi#step-2`
- **Unstake** → `/buy-vpfi#step-3`

All three deep-link to the same page using anchor scroll, so a
visitor who specifically wants to stake or unstake jumps straight
to that card without having to scroll past the buy step.

## Open staking — explicit messaging

The contract side has always supported this — `_prepareDeposit`
in the VPFI Discount facet calls `getOrCreateUserEscrow(msg.sender)`
on every deposit, which creates the escrow on first call. But
the user-facing messaging implied an existing loan was a
prerequisite, leaving a class of users (passive holders who just
want the 5% APR staking yield without becoming a lender or
borrower) feeling locked out of the program.

A new positioning callout sits below the Buy VPFI page subtitle,
wired into all 10 locales: *"Staking is open to anyone — you
don't need an existing loan to participate. Depositing VPFI into
your escrow earns the 5% APR yield, and the protocol auto-creates
an escrow for you on first deposit."*

The Step 2 and Step 3 cards were also relabelled:

- **Step 2** — "Deposit VPFI into your escrow" → "Deposit / Stake
  VPFI into your escrow", subtitle now mentions the 5% APR yield
  while the VPFI sits there, info note explicitly mentions
  auto-create-on-first-deposit.
- **Step 3** — "Unstake VPFI from your escrow" → "Withdraw /
  Unstake VPFI from your escrow".

All three messages translated into the 9 non-English locales.

## NFT Verifier — open in new tab from inside the app

Three places inside the app linked to the NFT Verifier (which
lives outside the app shell) but didn't open it in a new tab:
the Lender / Borrower NFT-id rows on Loan Details, and the
Position-NFT row on the Dashboard "Your Loans" table.

All three now open in a new tab (`target="_blank"`) and carry a
small external-link icon next to the link text. Tooltip text
updated to reflect the new behaviour. Previously these links
also pointed to `/app/nft-verifier`, a path that didn't actually
match any route — fixed alongside, all three now point to
`/nft-verifier` (the real public route).

## Interest-implication warnings — before the user signs

Borrowers and lenders historically had no inline UI cue about the
interest-side cost of strategic-exit flows. The contract docs and
workflow paths describe the math precisely, but the math is dense
and a user clicking "Confirm and create sale offer" on the
Lender Early Withdrawal page didn't see, anywhere in the UI, that
they were forfeiting all accrued interest by doing so.

A new `<InterestImplicationWarning>` callout was placed on every
strategic-exit confirm step, with copy specific to the flow:

- **Lender Early Withdrawal**: "By selling your lender position
  now, you give up all interest accrued so far on this loan. The
  forfeited amount goes to the protocol treasury (or is applied
  toward the rate shortfall first if the new lender's rate is
  lower)."
- **Borrower Preclose — Direct path**: "Closing the loan now via
  the Direct path requires you to pay the FULL TERM interest as
  if the loan ran to maturity — not just the interest accrued so
  far."
- **Borrower Preclose — Transfer path**: "Transferring the
  obligation to a new borrower requires you to pay the interest
  accrued to date plus a shortfall — the difference between what
  the lender expected to earn over the remaining term at your
  original rate and what they will earn from the new borrower's
  offer."
- **Borrower Preclose — Offset path**: "The Offset path settles
  your loan against a fresh lender offer that you create. Up
  front you pay the interest accrued so far plus any rate
  shortfall to the original lender, and you must deposit fresh
  principal as collateral for the offset offer."
- **Borrower Refinance**: "Refinancing repays the old lender
  with principal plus FULL TERM interest (not just accrued) plus
  any rate shortfall."

Each callout uses the same yellow-warning chrome as the existing
Transfer-Lock warning, so the visual language stays consistent
across pre-confirm callouts. All five copy bodies translated
across the 9 non-English locales.

The math each callout describes was cross-checked against
`docs/VaipakamAllWorkflowPaths.md` §8-§9 to confirm parity with
the documented design.

## Offer Book Rate column — signed delta + market-anchor tooltip

The Rate column previously rendered a `(±X%)` annotation alongside
each offer's rate. The annotation came from `absDelta()` against
the most-recently-accepted offer's rate, so the magnitude was
correct but the direction was lost (a lender offer at
`anchor + 0.5%` looked the same as one at `anchor − 0.5%`, but
those are very different propositions for a borrower browsing).

Two changes:

- **Signed delta**: `(+X%)` for offers above the market anchor
  (more expensive borrow / more lucrative lend); `(−X%)` for
  offers below market. Colour cue too — red for above, green for
  below — so direction registers at a glance.
- **Tooltip** (mobile-friendly, click-to-toggle, portal-rendered)
  added to the Rate column header explaining the market-anchor
  concept: *"The number in brackets shows how far this offer's
  rate sits from the market anchor — the rate of the most recently
  accepted offer matching the current filters. +X% means above
  market; −X% means below market."*

The tooltip uses the existing `<InfoTip>` component for
consistency with the rest of the page-level info icons.

## Filter-scoped market anchor — rolling list of recent matches

The market anchor used to be **the single global most-recently-
accepted offer's rate**. If that offer happened to be illiquid
and a user flipped the Liquidity filter to "Liquid only", the
anchor would vanish (the predicate filtered the global anchor
out) and every offer's rate-delta annotation disappeared with it.
Same problem when narrowing on lending asset, collateral asset,
or duration range — a single global anchor that fell outside the
filter set wiped the column.

The log-index now keeps a **rolling list of the last ~20
accepted offer IDs** alongside the existing single-most-recent
field. The OfferBook fetches their full offer data in one
multicall and at lookup time picks the freshest entry that passes
the current filter (using the same `matchesFilter` predicate the
visible offer list uses). This survives narrowing on any one
filter axis as long as a recent match still exists somewhere in
the trailing window.

## Dashboard "Your Loans" — pagination, filters, and sortable columns

The Dashboard's loan table grew three layers of UX:

1. **Pagination**: a paginator at the bottom of the card, with a
   per-page picker (10 default, 25, 50). Page snaps back to 0
   when filters or page size change.
2. **Filters**: Role (All / Lender / Borrower) and Status (All /
   Active / Repaid / Defaulted / Settled / Fallback Pending) —
   all rendered as the same pill-style picker as the chain
   picker on the Analytics page. Empty-match state surfaces a
   "No loans match the current filters" message with a one-click
   Clear button.
3. **Sortable columns**: every column header (ID, Role, Position
   NFT, Principal, Rate, Duration, LTV, HF, Status) is now
   clickable. Active column shows a chevron up / chevron down
   indicator; inactive columns show a faint two-headed chevron
   to advertise sortability. Default sort is **ID descending**
   (most recent loans on top). Clicking a different column
   starts ascending; clicking the same column flips to descending.

The risk multicall (`calculateLTV` + `calculateHealthFactor`) was
moved from "fetch for the visible page only" to "fetch for the
entire filtered set" so HF / LTV sorts work on the full list, not
just the rows currently on screen. Two RPCs total regardless of
list size — same multicall pattern.

Illiquid loans (no LTV / HF reading) sink to the bottom of the
LTV / HF sort regardless of direction, so they don't bubble to
the top of an ascending sort.

A small React-18 strict-mode trap was caught and fixed during
implementation: the original `toggleSort` nested a `setSortDir`
call inside the `setSortBy` updater, which strict mode invokes
twice for invariant checking — the nested setter then double-fires
and cancels the flip. Both setters are now at the same level
(no nesting), and the toggle behaves correctly under strict mode.

## Offer Book "Your Active Offers" — default sort by recent ID

The user's own active offers card now sorts by **ID descending**
(most recent first) by default. Per direction, no clickable column
controls were added — only the default sort changed. The market-
side Lender / Borrower offer cards keep their existing
anchor-relative ranking (correct-side rate first, sorted by
distance to the market anchor).

## Offer Book filters — pill chrome end-to-end

The Filters card on the Offer Book page used to mix free-form
inputs and a `<select>` dropdown for liquidity. Two changes for
consistency with the chain-picker visual language:

- **Liquidity filter**: switched to the same `<Picker>` pill
  used by the Dashboard filters and the chain picker, with a
  "Liquidity" prefix on the trigger and a leading droplet icon.
- **Per-side selector**: was a free-form numeric input below the
  filter row. Replaced with a `<Picker>` showing discrete
  options [10, 20 (default), 50, 100], filtered by the current
  tab's `maxPerSide` cap (50 for "both" tab, 100 for single-side
  tabs).
- **Free-form inputs (lending asset, collateral asset, min
  duration, max duration)** stay free-form but now wear pill
  chrome — same `border-radius: var(--radius-full)`,
  `bg-card`, brand-coloured focus ring as the picker pills. The
  filter row reads as a single visual band instead of a
  hodge-podge of input shapes.
- **Min / max duration placeholder text**: "e.g., 7" for min and
  "e.g., 365" for max — the contract enforces only `> 0` on
  duration so 0 was a misleading placeholder. The 1-365 cap
  itself remains a frontend-only product convention enforced by
  `validateOfferForm` and the Create-Offer input attrs, both of
  which now read from a single shared constant pair in
  `offerSchema.ts` instead of duplicated magic numbers.
- **Vertical-baseline alignment** of the Liquidity pill against
  the inputs in adjacent grid cells fixed via an invisible
  label-row spacer + a `width: 100%` rule that stretches the
  pill to fill its column.

## Security hygiene — leaked Anvil dev keys removed

A GitHub Secret Scanning alert flagged three `PRIVATE_KEY=0x…`
entries inside `.claude/settings.json` (the Bash-command allowlist
that lets local-anvil deploy commands skip the permission prompt).
The keys themselves are well-known Anvil dev-mnemonic defaults
with zero real-world value, but Secret Scanning correctly flags
any 64-char hex `PRIVATE_KEY=` regardless of source. The three
entries were removed from `HEAD`. Keys remain in git history
(public dev-mnemonic defaults — a `git filter-repo` rewrite is
overkill); the alert closes once the pattern no longer appears
on `HEAD`.

## Documentation convention

Same as carried forward from prior files: every completed phase
gets a functional, plain-English write-up under
`docs/ReleaseNotes-…md`. No code. Function names, tables, and
exact selectors live in the codebase; this file describes
behaviour to a non-engineer reader (auditor, partner team,
regulator).
