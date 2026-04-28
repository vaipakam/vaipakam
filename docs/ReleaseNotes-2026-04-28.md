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
Loans" pagination + filters** (Role / Status / Per page),
**chain-picker-style filter pills** rolled out across both the
Dashboard filters and the Offer Book filters card so all three
filter surfaces share one visual language, a **token-identification
trust block** under the Create Offer asset address fields (symbol +
name + market-cap rank + decimals + explorer link + phishing
warning when the contract isn't in the CoinGecko top 200), a
contract-side **lender-cannot-repay-own-loan guard** that closes a
self-liquidation edge case, a **custom revert** on the three risk-
math entry points when called against an illiquid loan (replaces a
generic `NonLiquidAsset` with `IlliquidLoanNoRiskMath` so the
frontend can surface a precise explainer), and a **Dashboard "your
stuff" consolidation** that moves "Your Active Offers" and "Your
VPFI Discount Status" onto the Dashboard while moving "VPFI Token
(this chain)" out to the Buy VPFI page (with the activity table
paginated 10 rows per page).

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

## Offer Book — anchor-centred default sort

The Lender and Borrower offer cards used to sort by "correct side
first, nearest-to-anchor" — a nuanced ranking that prioritised
rows on the side of the anchor matching the user's role, then
appended the wrong-side rows. In practice it produced a list
where the order of rates was hard to follow and the market anchor
didn't have a consistent visual position on the page.

Replaced with a depth-chart-style convention:

- **Lender Offers** — sorted by **rate descending** (highest rates
  on top, lowest at the bottom of the card).
- **Borrower Offers** — sorted by **rate ascending** (lowest rates
  on top, highest at the bottom of the card).

Stacked together in the "Both" view, the two cards converge at
the median rate ≈ market anchor in the visual middle, which makes
the spread immediately readable. Single-side tabs ("Lender Only"
/ "Borrower Only") inherit the same direction. Ties on rate fall
back to newest-id-first so two offers at the same rate have a
deterministic order.

The pure ranking helpers in `lib/offerBookRanking.ts` and their
unit tests were updated together. The `anchor` parameter stays in
the helper signatures for API stability — the column-level rate-
delta annotation still consults it — but no longer affects the
ordering.

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

## Token-identification trust block on Create Offer

The lending-asset and collateral-asset address fields on Create
Offer used to drop the user into a bare hex string with no help
identifying the contract. A pasted address could be the canonical
USDC, a legitimate but obscure long-tail token, or an outright
phishing copy with the same symbol — the form gave no signal
either way.

A new trust block now sits inline under each address field once a
syntactically valid `0x…40` is in the input. Per row it shows:

- **Symbol + Name** — pulled from the CoinGecko registry first
  (canonical names, market-cap rank), with an on-chain
  `symbol()` / `name()` fallback when the contract isn't on the
  registry. Either way the user sees identifying text instead of
  a bare hash.
- **Market-cap rank** — when the token is in the CoinGecko
  registry, e.g. "Rank #14".
- **Decimals** — Advanced-mode-only, since beginners don't need
  to see the technical surface and the value is non-actionable
  for them.
- **View on explorer** link — opens the active chain's block
  explorer to the contract's address page so the user can verify
  source / holders / activity directly.
- **Phishing warning** — yellow-chrome callout when the address
  is NOT in the CoinGecko registry, OR is on the registry but
  ranked outside the top 200. Copy explicitly tells the user to
  confirm the contract address itself rather than relying on the
  symbol they see in the field, since anyone can deploy a token
  with any symbol.

The on-chain "**detected ERC-20 / ERC-721 / ERC-1155**" pill that
used to render as its own line below the address is now folded
inline into the same row as the other identification fields. The
pill is still Advanced-only — it's a technical diagnostic — but
co-locating it with symbol/name/decimals avoids the previous
double-line "trust block, then technical diagnostic stripe"
visual stutter.

The block is visible to both Basic and Advanced users so a fresh
user pasting a sketchy address sees the warning at the same spot
a power user does. No phishing-protection signal is Advanced-
gated.

## Lender cannot repay own loan — contract guard

A loan's lender accepting a borrower's offer creates the standard
two-sided position. There was no on-chain guard, however,
preventing the lender from then calling `repayLoan` against their
own loan as a third-party. In a normal repay the borrower is the
caller; the on-chain code routes principal + interest from the
borrower's escrow to the lender. With the lender themselves as
caller, the contract treated them as a generous third-party
repayer — debiting the lender's escrow and crediting the lender's
escrow. Net economic effect: the lender pays themselves interest
plus the protocol's treasury fee, the loan settles closed, the
borrower's collateral becomes claimable. The borrower walks away
with collateral they didn't earn back.

A new revert `LenderCannotRepayOwnLoan` blocks this. The check
fires when both `msg.sender == loan.lender` AND the lender's
position NFT is still owned by the caller (the second clause
keeps the third-party repay path open after the lender has sold
their position). NFT-rental loans are explicitly skipped from the
guard — those have a different settlement model where the
"lender" address is the rental escrow and self-repay is the
intended close path.

The repay-by-third-party test in the regression suite was
updated to use a fresh non-lender address so the new guard
doesn't accidentally block a legitimate Good-Samaritan repay.

## Illiquid loans — custom revert on risk-math entry points

`calculateLTV`, `calculateHealthFactor`, and the
`isCollateralValueCollapsed` predicate inside the risk facet used
to revert with the generic `NonLiquidAsset` error when called
against a loan whose collateral was illiquid (no Chainlink feed,
no v3-style concentrated-liquidity AMM pool, or below the $1M
volume threshold). Same error code is also used by
`triggerLiquidation` for "this asset can't be 0x-swapped" — and
the frontend couldn't tell the two cases apart.

A new dedicated revert `IlliquidLoanNoRiskMath` was added for the
risk-math three. The frontend on Loan Details now decodes that
specific selector and renders a precise explainer: "this loan's
collateral is illiquid — no LTV, no Health Factor, and no HF-
based liquidation. The loan settles via the time-based default
path on grace-period expiry; both parties have already consented
to that on accept." The triggerLiquidation revert keeps its
generic `NonLiquidAsset` selector since the explainer there
points to "use the time-based default path" which is the same
call-to-action.

## Dashboard "your stuff" consolidation

The Dashboard used to be a loans-only surface. The Offer Book
held the user's own active offers (mixed in with the market book)
and the Buy VPFI page held the user's discount tier status. A
fresh user landing on the app had to navigate three pages to see
their full position.

The Dashboard now reads as a single "your stuff" surface. Three
moves:

- **Your Active Offers** card moved from the Offer Book page to
  the Dashboard. Renders only when the connected wallet has at
  least one open offer; otherwise the slot is skipped entirely
  rather than rendering an empty placeholder. The card uses the
  same `OfferTable` component the market-side cards do, with the
  user's own row showing a "Your offer" badge + Manage keepers
  link instead of an Accept button. The "New Offer" CTA was
  consolidated into this card's header — when no active offers
  exist, a fallback CTA still surfaces in the Loans card header
  so brand-new users still have one click to first offer
  creation.
- **Your VPFI Discount Status** card moved from the Buy VPFI page
  to the Dashboard, sitting directly below the Discount Consent
  toggle (which it has always paired with). Shows the live tier,
  effective discount %, and consent status without forcing the
  user to navigate to the public Buy VPFI page. The "Enable the
  shared discount consent on Dashboard" link inside the card is
  rephrased to "Enable the shared discount consent above." across
  all 10 locales, since the consent toggle now lives directly
  above this card.
- **VPFI Token (this chain)** card moved out of the Dashboard to
  the bottom of the Buy VPFI page. The card is mostly chain-
  level transparency (token contract, authorized minter, treasury
  destination, circulating supply, recent VPFI transfer activity)
  — info that's most relevant to a user already on the buy/stake/
  unstake page rather than a returning user checking their loans.

A small spacing fix between Your Active Offers and Your Loans
sits alongside (the two cards used to butt up against each other
without breathing room).

## VPFI Token transparency on Buy VPFI — paginated activity

The "Your VPFI activity" table inside the relocated VPFI Token
card now paginates 10 rows per page with a bottom paginator. The
underlying log-index already keeps the full transfer history; the
old in-card view rendered all rows in one scroll, which on
chatty wallets pushed the rest of the Buy VPFI page well below
the fold. Page index resets to 0 on chain switch or when the
underlying list grows.

The two stat tiles that previously sat at the top of this card —
**Wallet VPFI balance** and **Escrow VPFI balance** — were
removed, since the same two numbers are surfaced more
prominently on the Dashboard's Discount Status card now. The
remaining tiles (Share of circulating, Circulating this chain,
Remaining mintable) are chain-level transparency and don't
duplicate anything elsewhere.

## Documentation convention

Same as carried forward from prior files: every completed phase
gets a functional, plain-English write-up under
`docs/ReleaseNotes-…md`. No code. Function names, tables, and
exact selectors live in the codebase; this file describes
behaviour to a non-engineer reader (auditor, partner team,
regulator).
