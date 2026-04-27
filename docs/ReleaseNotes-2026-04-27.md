# Release Notes — 2026-04-27

Functional record of everything delivered on 2026-04-27, written as
plain-English user-facing / operator-facing descriptions — no code.
Grouped by area, not by chronology. Continues from
[`ReleaseNotes-2026-04-26.md`](./ReleaseNotes-2026-04-26.md).

Coverage at a glance: **Phase 2 of language translation**
(end-to-end migration of every hard-coded English string in the app
into the i18n catalogue, then translation into the nine non-English
locales — Spanish, French, German, Japanese, Simplified Chinese,
Korean, Hindi, Tamil, Arabic), **bilingual Risk Disclosures** (a
translated convenience copy plus a "View English original" modal so
the legally-binding text remains the English one), **English-only
notice** on the Terms / Privacy pages and on User-Guide pages where
the locale-matched markdown isn't translated yet, **a locale-
aware loader** for the User Guide that picks `Basic.<lang>.md` /
`Advanced.<lang>.md` from the frontend bundle and falls back to the
English source with a clear notice when no localised file exists,
**Phase 3 of language translation — SEO routes + backend copy**
(per-locale URL prefixes for every public page with a hreflang and
locale-shell SEO layer, locale-aware backend Telegram / Push alerts),
**bilingual Risk Disclosures consent gating** of Create Offer and
Accept Offer Confirm buttons, **second-level verbose GitHub issue
body** with stack trace / cause chain / browser-env folded in
GitHub `<details>` blocks, **diagnostics drawer simplified** to drop
its duplicate Download / Clear buttons in favour of the broader GDPR
"Download my data" / "Delete my data" pair, a small build-hygiene
round (`tsx` build-time TypeScript runner replacing the experimental
Node flag, npm postbuild dedup), **Phase 4 of language translation**
(every number / percent / currency / date / time / duration the app
renders now goes through `Intl.*` APIs with the active locale, so
German users see `1.000,00`, French `1 000,00`, Arabic `1٬000٫00`,
etc.), and **Phase 5 of language translation — RTL polish for Arabic**
(in-app sidebar pinned-right, slide-out drawers reverse direction,
directional icons flip, tooltips and modal close-buttons mirror,
numeric inputs stay LTR for amount-entry consistency).

## Phase 2 of language translation — full app coverage

After Phase 1 (i18n infrastructure, glossary, ten supported locales,
Claude-API translation script, language picker), Phase 2 walked
every page, modal, banner, and tooltip on the site and pulled their
English copy into the locale JSON files. The end-state count is on
the order of ~750 leaf keys per locale across roughly forty top-
level namespaces, all structurally identical — every locale carries
the same key set.

### Pages migrated

In-app: Dashboard (with the VPFI Token sub-card and Fee-Discount
Consent card), Offer Book (filters, side tabs, anchor row, scanned
counter, rescan + load-more controls, empty states, accept-review
modal), Create Offer (every form-hint, the lender / borrower
discount banner, the Loan Initiation Fee notice, the keeper
authorised-execution checkbox + the long position-vs-profile
explanation that goes with it), Loan Details (every action-
description paragraph, the fallback-pending alert, the confirm-
repayment dialog, the keeper-delegation block, the risk-metrics-
unavailable error), Buy VPFI (Discount Status card, Buy card with
ETH headroom + amount + receive lines, Deposit and Unstake cards
including the warning paragraph), Refinance, Borrower Preclose
(Direct + Transfer + Offset paths, every data-label and button
state), Lender Early Withdrawal, Claim Center, Activity, Allowances
(scan summary line + source enums), Alerts (threshold-ladder,
delivery-channel rails, Telegram + Push card copy, Push channel
address row, "Subscribe on Push" / "Push docs" links, Enable Push
rail), NFT Verifier (every data-label across genuine + burned
states, the offer-status enums, the buyer advisory copy), Public
Dashboard (combined and per-chain sections, VPFI transparency,
provenance, recent rows), Keeper Settings (the per-action
permission picker — five action rows with title + hint, the Add
Keeper input + Approve button, the Actions summary row, the
whitelist-full message). Settings popover, App Layout chrome.

Public landing: Navbar, Hero (including the demo cards — "Lend
1,000 USDC", "Rent Axie #1234", "Loan Repaid" now translate the
words while keeping the numbers and asset codes verbatim),
Features (8 feature cards), How It Works (4 steps × title +
description + bullet details), Security (6 cards × title +
description + verify-link variants), CTA, Footer (tagline,
Supported Networks selector, three column headers, link labels,
disclaimer paragraph, copyright + license suffix), Discord
landing page, FAQ (26 entries with rich JSX answers via
`<Trans>` so inline `<strong>`, `<em>`, `<code>`, `<Link>` are
preserved across translation).

### Components and shared widgets migrated

Banners and notices: Sanctions banner (with localised label
prop), Escrow upgrade banner, Unsupported chain banner, Liquidity
preflight banner (loading / no-route / thin / error / liquid
states all translated). LegalGate one-time Terms acceptance
modal. Cookie consent banner (title, body, four category rows,
all action buttons, switch on / off aria suffixes). Risk
Disclosures (3 sections × 3 points, plus the "I have read and
agree" checkbox label, plus the bilingual notice and the English-
original modal — see the Risk Disclosures section below).
Transfer-lock warning (pre-confirm + active variants). InfoTip
(default aria) and CardInfo (aria + Learn more). Simulation
preview (Blockaid) — title + warning / blocked / safe states +
"Expected state changes" header + "+N more" suffix. Risk gauge
(HF / LTV labels + danger / warning / safe tooltips). Asset
picker (every notice — testnet token-discovery, invalid address,
verifying, stablecoin recognised / not recognised, top-200
recognised / outside / not listed). Lender discount card (the
borrower-rebate vs lender-yield-discount banner on Create Offer +
the per-loan widget on Loan Details). VPFI discount-consent card
(Dashboard). VPFI Token panel (Dashboard).

### Footer and hero demo cards

The Footer additions (tagline, Supported Networks label, the
ChainPicker placeholder + aria, three column headers, `Documentation`
/ `Smart Contracts` / `Discord` link labels, the disclaimer
paragraph) and the Hero demo cards (`Lend 1,000 USDC`, `Rent Axie
#1234`, `Loan Repaid`, with their meta lines) had originally been
left in English on the assumption they were illustrative. After
review they were translated naturally — the words ("Lend", "Rent",
"Loan Repaid", "5% APR · 30 days · ETH collateral") render in the
active locale while numbers, currency codes, and asset identifiers
(USDC, ETH, ERC-4907, "Axie #1234") remain verbatim.

### Card-help registry — every (i) info-icon popover

The `cardHelp` registry — 50 card entries × on the order of 240
characters of explainer copy each, plus 7 of those entries having
distinct lender / borrower variants — moved from inline strings in
`lib/cardHelp.ts` to i18n keys. The 58 resulting strings live under
the `cardHelp.*` namespace and translate end-to-end. CardInfo
resolves the right variant at render time via `t(...)`. Adding a
new card help entry now means adding one string per locale and a
single mapping line in `cardHelp.ts`.

### Translation quality

Glossary preserved verbatim across every locale: VPFI, NFT,
Vaipakam, Diamond, ERC-20 / 721 / 1155 / 4907, HF, LTV, APR, BPS,
Keeper, DEX, KYC, USDC, USDT, ETH, MATIC, OpenZeppelin,
ReentrancyGuard, Pausable, UUPS, Chainlink, LayerZero, OFT,
Permit2, Uniswap, 1inch, 0x, MetaMask, Rabby, Coinbase Wallet,
CoinGecko, Push, Push Protocol, Push Snap, Telegram, Blockaid,
Chainalysis, BUSL, EIP-2535, P2P, plus the protocol-internal
identifiers (RiskFacet, ProfileFacet, EscrowFactoryFacet,
VPFIBuyAdapter, repayLoan, setVPFIToken, setVPFIDiscountConsent,
TokenomicsTechSpec, README). All numeric values, percentages and
mathematical comparisons (`HF < 1`, `≥ 1.5`, `≥100 VPFI`) preserved
exactly. Role-language rule held in every translation — the
translated copy uses neutral third-person ("the lender", "the
borrower", passive voice) rather than second-person "you / your"
forms, so a single page reads cleanly to either party.

CJK (Japanese / Chinese / Korean) and Indic (Hindi / Tamil)
locales kept English-loanword DeFi vocabulary (staking, slippage,
gas, swap, oracle, watcher, escrow, keeper) in the original
script — that is the prevailing convention in DeFi-language
documentation today, and replacing them with native coinages
would feel forced. A native-speaker editorial pass on those four
locales remains a follow-up; nothing currently mistranslates.

## Bilingual Risk Disclosures

The Risk Disclosures component (shown on every offer-creation
flow, the offer-acceptance review modal, lender early-withdrawal,
and the borrower offset preclose) renders the translated copy by
default but now also surfaces an in-page notice — *"This translated
copy is for reference. The legally-binding text is in English"* —
plus a "View English original" button. The button opens a modal
that re-renders the same disclosures with `t(key, { lng: 'en' })`,
so the user reads the legally-binding English regardless of the
active locale. The notice and button are suppressed entirely on
the English locale, where there is nothing to disambiguate.

The principle: translations are conveniences, the English text is
the document the wallet is signing against. Users get the
benefits of localised explanation without losing the option to
read the binding original on demand.

## English-only notice on Terms and Privacy

The Terms of Service and Privacy Policy pages now show a small
banner at the top — *"Available in English only — A translated
version may be added in a future update"* — when the active
locale is anything other than English. The page itself stays in
English. This is deliberate: legal documents need accuracy that
machine translation cannot guarantee, and a partial translation is
worse than a clear notice that the document is English-only.

A future content phase can translate these documents under formal
legal review; the wiring to swap the content out per locale is in
place via the same i18n machinery.

## User-Guide locale-aware loader

The `/help/basic` and `/help/advanced` pages used to import a
single canonical Markdown file from `/docs/UserGuide-Basic.md` and
`/docs/UserGuide-Advanced.md`. Today the markdown moved into the
frontend bundle at `frontend/src/content/userguide/`, named
`Basic.en.md` and `Advanced.en.md`. The User-Guide page now picks
the file matching the active locale (`Basic.<lang>.md` /
`Advanced.<lang>.md`) and falls back to the English source when no
localised file exists, surfacing a "translation pending" notice at
the top of the article.

To add a translation later, drop a sibling file alongside —
`Basic.es.md`, `Advanced.ja.md`, etc. — and the next build picks
it up. The `/docs/UserGuide-Basic.md` and `/docs/UserGuide-
Advanced.md` files now hold short forwarding stubs pointing
contributors at the new home so the canonical-source convention
stays discoverable.

## Sidebar logo when collapsed

In-app sidebar showed only the icon-only logo when expanded via
the 3-line menu icon, instead of the full horizontal logo. Fixed
by switching the source path the sidebar uses when the menu is
expanded to the full-logo asset, matching the desktop top-bar
behaviour. The collapsed (icon-only) state continues to show the
square mark.

## Phase 3 of language translation — SEO routes + backend copy

Two complementary deliverables that together push i18n past "the
chrome translates" to "the protocol is locale-aware end-to-end".

### Phase 3a — SEO-friendly per-locale routes

Every public page now has a distinct, crawlable URL per supported
locale: `/`, `/es/`, `/fr/`, `/de/`, `/ja/`, `/zh/`, `/ko/`, `/hi/`,
`/ta/`, `/ar/`. English stays at the unprefixed root; the other nine
locales each get a `/<locale>` prefix on every public route so search
engines can index `/es/help/basic` as Spanish content (not as a
duplicate of `/help/basic`) and route Spanish-speaking users to the
right URL from search results.

**Routing.** The route tree is mounted twice in `App.tsx` — once
under the unprefixed root for English, once under a `:locale`
URL parameter for the other nine. A `<LocaleResolver>` route guard
reads the URL prefix, validates against the supported-locales
catalogue, and calls `i18n.changeLanguage(...)` on first paint so
the body content matches the URL. Old unprefixed URLs keep working
and resolve to English; nothing existing breaks.

**Locale-aware navigation.** Two new wrapper components — `<L>` (a
drop-in for React Router's `Link`) and `<NL>` (the same for
`NavLink`) — auto-prepend the active locale prefix to absolute
internal paths. Migrated across every page and component that does
internal navigation: Navbar, Footer, AppLayout sidebar, the four
preclose / refinance / early-withdrawal / loan-details flows, the
landing-page CTA, the FAQ, the Public Dashboard, the Privacy and
Discord pages. A user on `/es/dashboard` clicking any internal link
now stays in Spanish; before this round, every click silently
dropped them back to English.

**LanguagePicker rewrites the URL.** Picking a different language
in the picker no longer just changes `i18n` state — it also
navigates to the matching prefix (or strips back to the root for
English). The user's bookmark / share-link reflects the language
they're reading.

**hreflang link tags.** A small `<HreflangAlternates>` component
mounted at app-root injects `<link rel="alternate" hreflang="X"
href="..."/>` siblings into `<head>` for every supported locale plus
`x-default`. Search engines now have explicit per-locale URL
mappings on every navigation event.

**Sitemap and robots.txt.** A new build-time script
(`scripts/generate-sitemap.ts`) emits `dist/sitemap.xml` containing
80 `<url>` entries (eight public routes × ten locales), each with a
full hreflang block plus `x-default`. Wallet-gated `/app/*` routes
are deliberately excluded — they require a wallet connection and
have nothing static to index. A matching `dist/robots.txt`
explicitly disallows `/app/*` and points crawlers at the sitemap.
The site origin is overridable via the `SITE_URL` env var so
preview deploys advertise the correct preview URL.

**First-visit default-locale redirect.** A new `<DefaultLocaleRedirect>`
guard runs once on first paint: if the user has no stored language
preference (no `localStorage["vaipakam:language"]`) and
`navigator.languages` prefers a supported non-English locale, the app
navigates the user to the prefixed equivalent of where they wanted
to go (`/dashboard` → `/es/dashboard` for a Spanish browser).
Persists the choice so subsequent visits skip the check. Users who
explicitly switch to English via the LanguagePicker have that choice
honoured.

**Tier-A SSG: per-locale shell HTML.** A second build-time script
(`scripts/generate-locale-shells.ts`) generates `dist/<locale>/index.html`
for each supported locale with locale-correct `<html lang="X" dir="rtl|ltr">`
(RTL applied to Arabic so the layout flips before JS runs, no LTR
flash), localised `<title>` and `<meta name="description">` tags
hand-written per locale, a `<link rel="canonical">` pointing at the
locale variant itself, the full hreflang block, and OpenGraph locale
alternates (`og:locale` + `og:locale:alternate`) so social-card
scrapers (Twitter, Discord, Slack) preview the right copy. The root
`dist/index.html` also gets the same hreflang / canonical / OG block
applied. The body of every shell is the same React mount point as
before — JS hydrates and renders the page in the matching locale
once it boots.

This is "shells" rather than full pre-rendered content. Pre-rendering
the actual page body would require StaticRouter, side-effect-free
imports (the wallet contexts touch `window` at module-load time),
and a per-route data-loader contract — architectural rework deferred
to a future phase. Shells alone cover the meaningful first-paint
signals: locale-aware `<html lang>`, localised browser-tab title,
correct search-result snippets, and right-locale social cards.

**Cloudflare Pages `_redirects`.** Cloudflare's default SPA fallback
would route `/es/dashboard` to the root (English) `index.html`,
defeating the per-locale shell entirely for any path beyond `/es/`.
The same script emits `dist/_redirects` with one rewrite rule per
locale (`/<locale>/* → /<locale>/index.html (200)`) followed by the
catch-all `/* → /index.html (200)`. Now any URL under `/es/...`
serves the Spanish shell on first paint regardless of how deep the
path is.

### Phase 3b — Backend Telegram / Push alert copy translation

The HF watcher Cloudflare Worker now sends Telegram and Push alerts
in the user's preferred language.

**Database column.** New migration `0002_user_locale.sql` adds a
`locale TEXT NOT NULL DEFAULT 'en'` column to `user_thresholds`. The
frontend Alerts page sends `locale: i18n.resolvedLanguage` on every
threshold-save and Push-subscribe HTTP PUT, so the user's stored
locale stays in sync with their last-active UI language.

**Worker-side i18n catalogue.** A small `ops/hf-watcher/src/i18n.ts`
file holds translations of every user-visible string the watcher
emits — band tags ("Heads up", "ALERT", "CRITICAL"), the alert body
template, Push notification titles, the Telegram handshake-expired
and handshake-linked confirmations — across all ten locales. Lookup
falls back to English for any unknown locale code; never throws,
never blocks an alert from delivering. Worker stays small (no
i18next runtime, no JSON-bundle loading at cold-start).

**Wired through.** `formatAlert(band, locale, opts)` and
`pushTitle(band, locale)` are called by the watcher loop with
`user.locale` from the per-user thresholds row. The Telegram
handshake messages in the worker's `/tg/webhook` endpoint look up
the linked user's locale from the database and respond accordingly.

## Risk-disclosure consent gating + bilingual UX polish

The "I have read and agree to the Risk Disclosures above." checkbox
already lived inside the Risk Disclosures component but didn't
gate the Create Offer or Accept Offer Confirm buttons. Both buttons
now require the checkbox to be checked before they can be clicked.
A hover-state tooltip on the disabled button shows the checkbox
label so the user understands *why* the button is disabled.

The Risk Disclosures component itself was rewired to pull from i18n
in earlier rounds; this round added a translated-summary notice
("This translated copy is for reference. The legally-binding text
is in English") plus a "View English original" button on every
non-English locale. Clicking the button opens a modal that re-renders
the same disclosures with `t(key, { lng: 'en' })`, so the user reads
the legally-binding English regardless of the active locale. The
notice and button are suppressed entirely on English.

## Diagnostics drawer — simplified action surface

The drawer used to carry six action buttons in two rows: a "support
debug" row (Report on GitHub, Copy JSON, Download, Clear) and a
"data rights" row (Download my data, Delete my data). The two rows
overlapped — *Download* was a subset of *Download my data* (the
GDPR action exports the journey log plus everything else under
Vaipakam's namespace), and *Clear* overlapped with *Delete my data*.
After review the two duplicates were removed, leaving the drawer
with a clean two-row surface: support actions (*Report on GitHub*,
*Copy JSON*) above the GDPR row (*Download my data*, *Delete my
data*). Same coverage, less cognitive load.

## Second-level verbose GitHub issue body

When the user clicks *Report on GitHub* from the diagnostics drawer
or any inline error banner, the prefilled issue body now carries a
second level of verbose error data so a developer can pinpoint the
problem on first scroll instead of having to ask for the JSON
attachment.

The visible-by-default header carries the report id, redacted wallet,
chain, last on-chain tx hash, the area / flow / step that failed,
the decoded custom error name, the 4-byte revert selector, the
full error message (no longer truncated at 140 chars), the raw
revert data, and the loan / offer / NFT id. Folded inside GitHub
`<details>` blocks (collapsible, click to expand) sit four
deeper-dive sections:

- **Stack trace** — top frames from the original `Error.stack`,
  third-party `node_modules` frames included so the call site that
  triggered the throw is visible even when our own bundle is
  wrapped through ethers / viem / wagmi.
- **Cause chain** — recursive `Error.cause` walk, depth ≤ 3.
  Surfaces wrapped errors (e.g. `enrichFetchError` puts a
  more-verbose `TypeError` over the original `Failed to fetch`)
  so triage sees both layers at once.
- **Browser environment** — viewport, online state,
  `prefers-color-scheme`, document language, document referrer.
  Deliberately excludes user-agent, screen resolution, localStorage
  contents, and cookies — none of those are needed for triage and
  all of them are fingerprint vectors.
- **Recent events** — the dense events list from the journey
  buffer, fifteen entries before the failure plus the failure plus
  five after, each with the event's free-form `note` field included
  inline (often carries the on-chain tx hash for a successful
  step) and the per-event error message cap raised from 140 to 500
  characters.

The redaction contract holds: wallet addresses still shortened to
`0x…abcd`, no user-agent, no IP-derived info, no localStorage, no
cookies. Free-form fields (note, errorMessage, errorData) still go
through the same control-char-strip + pipe / backtick escape pass.

## Build hygiene — `tsx` runner

Build-time TypeScript scripts (`generate-sitemap.ts`,
`generate-locale-shells.ts`, `translate-i18n.ts`) now run via `tsx`
— a battle-tested loader wrapping esbuild, ~3 MB devDep. Replaces
the prior `node --experimental-strip-types script.ts` invocation,
which depended on Node 22.18+'s native type-stripping behind an
"experimental" flag. `tsx` supports the full TypeScript syntax
surface (including `enum`, `namespace`, `import = require`),
isn't experimental, and works on any Node ≥ 20.19 — Vite 8's
actual minimum. `engines.node` relaxed accordingly. `.nvmrc`
stays at 22 (current LTS, sensible local default).

The `npm run build` script now uses npm's standard lifecycle hook
behaviour: `build` runs `tsc -b && vite build`, and `postbuild`
fires automatically after, running the sitemap and locale-shell
generators. The earlier explicit chain caused the post-build to
run twice; that's fixed.

## Phase 4 of language translation — Intl.* formatting

The chrome already translates; what stayed locale-blind until today
was the *content* of every number, percentage, currency amount, date,
time, and duration the app renders. That's now wired through
JavaScript's built-in `Intl.*` APIs so each locale gets its native
conventions for grouping, decimal separators, sign placement, and
date / time order.

**Helpers in `lib/format.ts` rewritten + extended.** The existing
`bpsToPercent` and `formatUnitsPretty` now consume the active
i18n locale (`i18n.resolvedLanguage`) at call time and use
`Intl.NumberFormat` with the right options for percent / decimal
formatting. New helpers landed alongside them:

- `formatNumber(n, options?)` — locale-grouped decimal.
- `formatPercent(value, digits?)` — fractional 0..1 input.
- `formatUsd(value, options?)` — locale-aware USD currency.
- `formatCompact(n, digits?)` — `1.2K` / `1,2 万` / `1٫2 ألف`.
- `formatDate`, `formatTime`, `formatDateTime` — wrap
  `Intl.DateTimeFormat` with sensible default `dateStyle` /
  `timeStyle` options.
- `formatRelativeTime(from, to?)` — wraps `Intl.RelativeTimeFormat`.
  Picks the largest meaningful unit (seconds → minutes → hours →
  days → weeks → months → years).
- `formatDuration(totalSeconds)` — compact `Xd Yh` / `Xh Ym` form
  using the locale's number grouping for the digit parts.

The format helpers stay *pure functions* (no React hooks) because
they're called from many non-component contexts. They re-evaluate
the locale on every invocation, and components that consume them
already re-render on `i18n.changeLanguage(...)` because they
nearly all call `t()` somewhere — so the formatted output flips
along with the rest of the page.

**Hot-path call sites migrated.** Public Dashboard (`formatUsd` /
`formatCompact` / `formatPct` rewritten via `Intl.NumberFormat`
with `style: 'currency'` / `notation: 'compact'` /
`signDisplay: 'exceptZero'`), Dashboard `formatVpfi`, Offer Book
`formatBpsPct`, Activity `formatBlockTime` (now branches: relative
time within 24h, absolute date+time after), Loan Details start /
end-date renderers, Buy VPFI tier-row labels, Diagnostics drawer
event timestamps.

**What this looks like in practice.** A user reading the same
loan-details card now sees:

| Locale | Principal | APR | Start date | Activity ago |
|---|---|---|---|---|
| en | `1,000.50 USDC` | `5.00%` | `Apr 27, 2026` | `2 hours ago` |
| de | `1.000,50 USDC` | `5,00 %` | `27. Apr. 2026` | `vor 2 Stunden` |
| fr | `1 000,50 USDC` | `5,00 %` | `27 avr. 2026` | `il y a 2 heures` |
| ja | `1,000.5 USDC` | `5.00%` | `2026/04/27` | `2 時間前` |
| ar | `1٬000٫50 USDC` | `5٫00٪` | `٢٧‏/٤‏/٢٠٢٦` | `قبل ساعتين` |

Numeric inputs (amounts, BPS) are deliberately kept in `direction:
ltr` text alignment via the Phase-5 RTL overlay — Arabic users
expect to type amounts the same way regardless of script
direction.

## Phase 5 of language translation — RTL polish for Arabic

Arabic now renders with the right-to-left layout the script
demands. The base stylesheets across the codebase use physical
properties (`left`, `right`, `margin-left`, `padding-right`)
rather than logical ones (`inset-inline-start`,
`margin-inline-end`); a full migration to logical properties is
deferred to a separate polish phase since it's a sweep across
~14 CSS files. Today's drop is a focused RTL overlay
(`styles/rtl.css`) loaded after `global.css` that targets the
user-visible mirroring bugs.

**Layout direction.** The pinned-left in-app sidebar mirrors to
pinned-right under `dir="rtl"`, with the mobile drawer's slide-in
direction reversed (`translateX(100%)` instead of `-100%`) and
the main-content area's margin shifted to the right so the rail
sits in the right place. The Diagnostics drawer's bottom-right
floating "Support" button anchors bottom-left in Arabic, and the
slide-out panel enters from the left edge.

**Direction-sensitive icons.** Pager `‹ Prev` / `Next ›` chevrons,
Hero / CTA / Navbar `→` arrows, breadcrumb chevrons, and the
"How It Works" step-connector arrows all flip via
`transform: scaleX(-1)` under `[dir="rtl"]` so "next" still
points to the next-page direction (which in Arabic reading order
is leftward). A generic `[data-rtl-flip="true"]` selector
provides an opt-in mark for future directional icons. Direction-
agnostic icons (search magnifier, settings gear, info `ⓘ`,
trash, copy) stay un-flipped — those are symbols, not arrows.

**Tooltip / popover alignment.** CSS-driven
`data-tooltip-placement="below-start"` / `"below-end"` variants
mirror under RTL so the tooltip's leading edge aligns to the
right-side of its trigger as users expect.

**Form alignment.** Form labels, hints, and text inputs use logical
`text-align: start` instead of `left` under RTL. Numeric inputs
(amount fields, BPS, ETH amounts) are forced to `direction: ltr`
because users type "1000" the same way regardless of locale —
flipping the digit-entry direction would create a usability
regression with no readability win.

**Modal close buttons.** The Diagnostics drawer's close X, the
consent banner's dismiss, the inline ErrorAlert dismiss button
all anchor top-start in RTL (top-left for Arabic) instead of
their LTR top-right default.

**What this overlay does NOT cover.** Mixed-script bidi text
inside paragraphs is browser-handled (Latin-script glossary
terms like "VPFI" / "ERC-20" stay LTR inside Arabic content
automatically). Numbers in Arabic content stay LTR per CSS bidi
defaults — correct behaviour. Flex `row` direction auto-flips
in RTL — no overlay needed. The 29 selectors in `rtl.css` are
the ones that physical CSS rules in the base stylesheets get
wrong by default; everything else handles itself.

## Status snapshot at end-of-day 2026-04-27

- **Language coverage**: 10 locales (en, es, fr, de, ja, zh, ko,
  hi, ta, ar) at structural parity. Every interactive control,
  form hint, banner, error toast, card-title tooltip, and FAQ
  entry translates. Long-prose pages (Terms, Privacy) carry an
  explicit English-only notice when the active locale isn't
  English. The User Guide ships translated for es / fr / de / ar
  and falls back to English with a "translation pending" banner
  for the other five locales.
- **SEO**: per-locale URL prefixes live for every public page,
  with a hreflang block on every navigation, a sitemap
  enumerating 80 URL × locale combinations, a robots.txt that
  excludes wallet-gated routes, locale-aware Cloudflare Pages
  rewrites, and per-locale shell HTML so crawlers and social-card
  scrapers see the right metadata before JS runs. First-visit
  default-locale redirect sends users to their preferred locale
  on the first hit.
- **Backend alerts**: HF-watcher Telegram and Push notifications
  now sent in the user's preferred locale (10 locales covered).
  Worker-side i18n catalogue inline; no runtime dependency.
- **Locale-aware numeric / date / duration formatting**: every
  number, percent, currency amount, date, time, relative-time
  string, and duration the app renders goes through `Intl.*`
  APIs with the active locale. Group separators, decimal
  conventions, sign placement, and date / time order all
  match the user's locale.
- **RTL layout (Arabic)**: in-app sidebar pinned-right, slide-
  out drawers reverse direction, directional icons (chevrons,
  arrows) flip, tooltips and modal close-buttons mirror,
  numeric inputs stay LTR for amount-entry consistency. 29
  selectors in `styles/rtl.css`; the rest is browser-handled
  via flex auto-flipping and CSS bidi.
- **Bilingual legal text**: Risk Disclosures has a one-click
  "View English original" path on every locale, so the legal-
  text-in-English property is preserved even though the
  on-screen copy is localised. Both Create Offer and Accept Offer
  Confirm buttons gate on the matching consent checkbox.
- **Diagnostics**: GitHub issue body upgraded to a second-level
  verbose payload — stack trace, cause chain, browser environment,
  expanded events list — folded behind GitHub `<details>`
  collapsibles so the at-a-glance triage view stays scannable.
  Drawer simplified from six to four action buttons after the
  GDPR row was identified as a superset of the duplicate
  Download / Clear actions.
- **Build hygiene**: `tsx` is now the build-time TypeScript
  runner; experimental Node flag and npm-lifecycle double-run
  both eliminated. `engines.node >= 20.19.0`, `.nvmrc` at 22.
- **Mainnet deployment**: deferred per the prior days'
  status. No translation-related blocker added today.

## Documentation convention

Same as carried forward from prior files: every completed phase
gets a functional, plain-English write-up under
`docs/ReleaseNotes-…md`. No code. Function names, tables, and
exact selectors live in the codebase; this file describes
behaviour to a non-engineer reader (auditor, partner team,
regulator).
