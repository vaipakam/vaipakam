# Release Notes — 2026-04-26

Functional record of everything delivered on 2026-04-26, written as
plain-English user-facing / operator-facing descriptions — no code.
Grouped by area, not by chronology. Continues from
[`ReleaseNotes-2026-04-25.md`](./ReleaseNotes-2026-04-25.md).

Coverage at a glance: **multi-chain deployment scripts + runbooks**
(early-day infrastructure cleanup), **top-bar / wallet UX overhaul**
(settings gear popover, combined wallet pill across desktop and
in-app, mobile flyout with click-to-expand, address copy on
whole-pill click, 768px breakpoint, language picker, chain-aware
security-card links), **Phase 1 + 2 of the in-app card-help system**
(info icons next to every card title across every page, central
tooltip registry, two new user-guide documents under `/docs/`,
mode-aware "Learn more →" deep-linking), and a small bundle of
fixes (build error from a stray import, mobile info-tip click-only
+ portal rendering, Dashboard chain-id and canonical/mirror tooltip
clipping).

## Multi-chain deployment scripts + runbooks

A clean cut at the deployment story for the Phase 1 chain set
(Ethereum, Base, Arbitrum, Optimism, Polygon zkEVM, BNB Chain). All
six chains now share one set of generalised Foundry deploy scripts
with chain-resolved RPCs, deterministic CREATE2 addresses where
applicable, and a consistent post-deploy verification readback.
Replaces the per-chain copy-paste scripts that had begun to drift
across constants and selector lists.

Runbooks under `ops/runbooks/` got a refreshed walkthrough — the
cutover runbook now explicitly gates on the
`ConfigureLZConfig.s.sol` script (DVN policy + confirmations +
enforced options + libraries), the Phase 7b oracle setup, and the
Phase 7a swap-adapter wiring, so a deployer running through the
runbook cannot ship a chain with default-DVN config or unwired
swap failover.

## Top-bar / wallet UX overhaul

A long-overdue sweep of the navigation chrome:

**Settings gear popover.** Mode (Basic / Advanced), Language, and
Theme are now collected in a single popover anchored to the
top-bar gear icon. Replaces the previous inline mode-toggle pill +
standalone theme button that were eating top-bar real estate.

**Combined wallet pill (desktop + in-app).** The wallet address +
chain selector + disconnect render as one clickable pill on
desktop and inside the app at any viewport above the breakpoint.
Clicking the pill opens a popover that shows the full address
(always the hex form, even when an ENS name is resolvable), a
copy-icon with a brief animated success state, and the
chain-picker as a row inside the popover. The pill's outer label
keeps the ENS name when one is available; the popover's address
display always shows the redacted hex form so a user can confirm
the actual wallet identity at a glance.

**Mobile flyout (768px and below).** The breakpoint at which the
top-bar collapses into a hamburger flyout was raised from the
prior 1200px to the industry-standard 768px. Inside the flyout
the wallet pill, chain selector, and Disconnect button render as
a centred triplet; the chain-selector dropdown matches the wallet
pill's width when open. Learn / Verify menu entries inside the
flyout collapse to single-tap-to-expand only — hover-to-open is
gated off in the flyout to side-step the iOS hover-on-first-tap
quirk. Outside the flyout (desktop), Learn / Verify still
expand on hover with an animated pseudo-element bridge so a
moving cursor doesn't fire `pointerleave` between trigger and
menu.

**Address-pill copy ergonomics.** The whole pill is now the click
target for "copy address", not just the small icon. The compact
form shifted from `0x12…abc` (2+3) to `0x1234…abcd` (2+4) — same
character budget, more recognisable. The popover always shows the
longer redacted form.

**Security-card links — chain-aware.** The "Verify on explorer"
links on the security cards now resolve to the active chain's
explorer URL rather than a hard-coded one, so a user on Arbitrum
isn't sent to BaseScan.

**LanguagePicker.** New custom dropdown that matches the
ChainPicker styling for both the outer trigger and the inner
items, so the two surface the same way. Live in the settings gear
popover.

**Dashboard VPFI panel — Advanced-mode gating + InfoTip migration.**
The chain name / chain-id badge and the canonical / mirror badge
on the Dashboard's VPFI card now appear only in Advanced mode
(Basic mode hides them as protocol-internal detail). The previous
CSS `data-tooltip` on the canonical/mirror badge was clipping on
mobile; replaced with the new InfoTip primitive (click-only,
portal-rendered, dismissable). The InfoTip primitive is the same
one that drives the info-icon rollout below.

## In-app card-help system — Phase 1 + 2 + mode-aware deep-linking

Three sub-deliverables that together stand up a fully indexed
help surface across the app:

### Phase 1 — Foundation + Dashboard demo

Three new building blocks land:

- **InfoTip primitive** (`components/InfoTip.tsx`) — a click-only,
  portal-rendered tooltip bubble that escapes ancestor
  `overflow:hidden` clipping by mounting under `document.body`.
  Dismisses on outside click or after a short grace-period
  pointer-leave so a user can reach for the link inside without
  the bubble disappearing under their cursor.
- **CardInfo component** (`components/CardInfo.tsx`) — drop-in
  `<CardInfo id="<page>.<card-slug>" />` icon next to a card
  title. Looks up the registry entry, renders a small `(i)` icon,
  and on click shows a portaled InfoTip with summary copy and a
  "Learn more →" link. Returns nothing when the id has no entry,
  so adding the icon to a card before its content is drafted is
  harmless.
- **Centralised help registry** (`lib/cardHelp.ts`) — one map of
  `id → { summary, learnMoreHref }`. Single editable surface for
  non-engineers; the same blurbs are reusable on the landing
  page's Features / How-It-Works sections in Phase 3.

Wired to the four Dashboard cards (Your Escrow, Your Loans, VPFI
on this chain, Fee-discount consent) as the demo page.

### Phase 2 — Rollout to every other page

Info icons added to every card title across every remaining page
in the app:

- **Offer Book** — Filters; Your Active Offers; Lender Offers;
  Borrower Offers.
- **Create Offer** — Offer Type; Lending Asset / NFT Details;
  Collateral; Risk Disclosures; Advanced Options.
- **Activity** — feed page-title.
- **Claim Center** — claims page-title.
- **Buy VPFI** — page-title; Discount Status; Step 1 (Buy with
  ETH); Step 2 (Deposit to escrow); Step 3 (Unstake).
- **Rewards** — page-title; Claim Rewards; Withdraw Staked VPFI.
- **Loan Details** — page-title; Loan Terms; Collateral & Risk;
  Parties; Actions.
- **Allowances** — list page-title.
- **Alerts** — page-title; Threshold ladder; Delivery channels.
- **NFT Verifier** — verifier page-title.
- **Keeper Settings** (Advanced mode only) — page-title; Approved
  keepers list.
- **Public Analytics Dashboard** — page-title; Combined — All
  Chains; Per-Chain Breakdown; VPFI Token Transparency;
  Transparency & Source.
- **Refinance** — page-title; Position Summary; Step 1 (Post
  Offer); Step 2 (Complete).
- **Preclose** — page-title; Position Summary; Offset In Progress;
  Choose Path.
- **Early Withdrawal** — page-title; Position Summary; Initiate
  Sale.

Total: 52 registered card-help entries spanning 16 pages, all
wired and type-checking clean.

### User-guide documents — Basic + Advanced

Two new long-form documents at `docs/UserGuide-Basic.md` and
`docs/UserGuide-Advanced.md`. Same structure, same anchor ids
matching the registry — every card id has a corresponding
`<a id="<page>.<card-slug>"></a>` anchor in both files so the
fragment resolves deterministically on GitHub's renderer.

- **Basic** — friendly plain-English. Avoids protocol jargon
  (Diamond, UUPS proxy, OFT) where a metaphor works
  ("private vault" for escrow). Covers all 52 cards across 16
  pages.
- **Advanced** — technically precise. Cites facets, exact
  selectors, constants (HF threshold 1.5e18, treasury cut 100 bps,
  rental buffer 500 bps, max keepers 5), DVN policy (3 required +
  2 optional, threshold 1-of-2 post the April 2026 hardening),
  and 4-DEX swap failover order. Cross-references to
  `README.md`, `TokenomicsTechSpec.md`, and `CLAUDE.md` are
  inline where they save the reader a hop.

### Role-aware language rule

A consistent rule applied across the registry summaries and both
user guides: the Offer Book lender-offers / borrower-offers cards
and every Create Offer flow card name the role explicitly
(lender, borrower, renter) rather than using "you", because both
sides may read those cards and "you" is ambiguous when the role
flips at acceptance time. Other cards use "you" naturally —
that's where the audience is unambiguous.

The five tooltip summaries that previously used role-flipping
"you" wording were rewritten:

- `offer-book.lender-offers`
- `offer-book.borrower-offers`
- `create-offer.offer-type`
- `create-offer.lending-asset`
- `create-offer.nft-details`

### Rebate banner extension on Create Offer

The "Earn up to 24% VPFI rebate on the initiation fee" banner
on the Create Offer page was previously borrower-only. It now
shows for the lender side too, with role-specific copy: lenders
see "Earn up to 24% VPFI discount on the yield fee", which
describes the time-weighted reduction in the 1% treasury cut on
interest at settlement. Borrowers continue to see the original
copy describing the up-front 0.1% LIF in VPFI plus
time-weighted rebate at proper close.

The banner was also moved from the top of the page to display
**below** the Offer Type card, so it lands in the user's eyeline
immediately after they pick a side rather than scrolling past
before the role choice has been made.

### Mode-aware "Learn more →" deep-linking

The "Learn more →" link inside every CardInfo tooltip resolves
at click-time from the user's UI mode and the card's id. A user
in Basic mode lands in `UserGuide-Basic.md` at the matching
anchor; flipping the Mode toggle to Advanced flips every link
target to `UserGuide-Advanced.md` at the same anchor. No
per-card change is needed when the docs migrate from
GitHub-rendered Markdown to an in-app `/help/<id>` route in
Phase 3 — only the URL builder in CardInfo changes; the
registry stays untouched.

## Bug fixes

**Mobile InfoTip behaviour.** InfoTip was rewritten to be
click-only on every device (no hover handlers at all) after iOS
reproducibly required two taps to open the tooltip and
intermittently swallowed clicks on links inside the bubble. The
bubble now renders through a React portal under `document.body`
so it escapes ancestor `overflow:hidden` containers; the trigger
no longer calls `stopPropagation` on `pointerdown`, which was
suppressing the iOS synthetic click on the inner link. Hover
rules on the trigger and the "Learn more" link are gated by
`@media (hover: hover)` so iOS doesn't synthesise hover-on-first-
tap.

**Build fix — stale CHAIN_REGISTRY import.** Cloudflare Pages
preview build was failing on a stray `CHAIN_REGISTRY` import in
`Security.tsx` left over from an earlier refactor. Removed; build
green again.

**Dashboard tooltip clipping.** The tooltip anchored to the
canonical / mirror badge on the Dashboard's VPFI card was being
clipped by the card's `overflow:hidden`. Migrated to the new
InfoTip primitive, which renders through a portal and so escapes
the clipping ancestor cleanly. The fix is the same migration that
handles the Advanced-mode gating mentioned above.

## Status snapshot at end-of-day 2026-04-26

- **Multi-chain deployment scripts**: generalised script and
  matching runbook landed for the Phase 1 chain set. Phase-1
  chain set unchanged.
- **Top-bar / wallet UX**: shipped. 768px breakpoint, combined
  wallet pill desktop+in-app, mobile flyout collapse with
  click-to-expand for Learn / Verify, address copy on whole-pill
  click, LanguagePicker, settings gear popover.
- **In-app card-help system (Phase 1 + 2)**: shipped. 52 cards ×
  2 user-guide modes wired through one registry. Mode toggle now
  flips every "Learn more →" target without a per-page change.
- **User guides**: `UserGuide-Basic.md` and `UserGuide-Advanced.md`
  checked in under `/docs/`. Role-aware language rule applied
  consistently across the registry summaries and both guides.
- **Phase 8a alerts** (carried from 2026-04-25): both rails
  functional end-to-end. Push remains gated on the on-chain
  channel registration step pending mainnet cutover.

Mainnet deployment remains deferred. No blockers added today; the
LZ / DVN / oracle / swap-adapter pre-flight items are all
unaffected.

## Documentation convention

Same as carried forward from the prior file: every completed
phase gets a functional, plain-English write-up under
`docs/ReleaseNotes-…md`. No code. Function names, tables, and
exact selectors live in the codebase; this file describes
behaviour to a non-engineer reader (auditor, partner team,
regulator).
