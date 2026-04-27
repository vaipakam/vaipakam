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
the locale-matched markdown isn't translated yet, and **a locale-
aware loader** for the User Guide that picks `Basic.<lang>.md` /
`Advanced.<lang>.md` from the frontend bundle and falls back to the
English source with a clear notice when no localised file exists.

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

## Status snapshot at end-of-day 2026-04-27

- **Language coverage**: 10 locales (en, es, fr, de, ja, zh, ko,
  hi, ta, ar) at structural parity. Every interactive control,
  form hint, banner, error toast, card-title tooltip, and FAQ
  entry translates. Long-prose pages (Terms, Privacy, User
  Guide) carry an explicit English-only / translation-pending
  notice when the active locale doesn't have a translated
  version — they don't silently fall back without telling the
  user.
- **Bilingual legal text**: Risk Disclosures has a one-click
  "View English original" path on every locale, so the legal-
  text-in-English property is preserved even though the
  on-screen copy is localised.
- **User Guide**: locale-aware loader live; English files in
  place; per-locale translation files are a drop-in addition,
  no code change needed when added.
- **Mainnet deployment**: deferred per the prior days'
  status. No translation-related blocker added today.

## Documentation convention

Same as carried forward from prior files: every completed phase
gets a functional, plain-English write-up under
`docs/ReleaseNotes-…md`. No code. Function names, tables, and
exact selectors live in the codebase; this file describes
behaviour to a non-engineer reader (auditor, partner team,
regulator).
