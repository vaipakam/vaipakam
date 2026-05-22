# UX Direction — DEX/CEX Conventions Where They Map, Lending-Native Where They Don't

**Issue:** [#166](https://github.com/vaipakam/vaipakam/issues/166)
**Status:** Design pass — accepted (pending PR review)
**Author:** Vaipakam Developer Team
**Date:** 2026-05-22

---

## TL;DR

Vaipakam's UI should reuse user muscle memory from the major DEX / CEX
surfaces **where the semantics actually match**, and consciously diverge
— with clear naming and tooltips — **only where lending primitives have
no DEX analog**. This document is the chokepoint that catches the
cargo-cult version: it names every Tier-A vocabulary borrow (where we
adopt DEX / CEX wording AND idioms 1:1) and every Tier-B retention
(where we keep lending-native names but adopt DEX visual idioms so the
surface feels familiar). A per-page checklist follows the framing; each
significant per-page rework gets its own follow-up issue.

The retail UI does NOT mention KYC / sanctions / country-pair gates on
marketing or first-impression surfaces — those are policy decisions
already locked in CLAUDE.md ("Retail-deploy policy" section). The
framing in this document respects that constraint throughout.

---

## Context

DeFi onboarding pain mostly comes from "the words / shapes I'm used to
from Uniswap / 1inch / Binance suddenly don't mean what I think they
mean." Vaipakam is order-book by nature (P2P matched offers + the
canonical limit-order shape shipped via #163 / #164 / #187), not an
AMM, so several DEX conventions map cleanly and should be borrowed. But
Vaipakam also has primitives — Health Factor, liquidation grace,
collateral top-up, NFT rental — that DEXs don't have at all; pretending
those are "margin ratio" or "stop-loss" introduces silent semantic
drift that costs users money on the first wrong assumption.

The two-tier framing below avoids both failure modes: borrow vocabulary
where it maps; borrow visual idioms but not vocabulary where the
semantics differ.

The Phase 2 contract work (#187) already locked in the underlying
shapes — ranged offers with explicit `*Max` fields, role-aware reads,
`matchOffers` with `previewMatch` + partial-fill + dust-close,
LIF kickback to matchers. This document is the UI counterpart to
those backend decisions.

---

## Decision

**Two-tier hybrid:**

- **Tier A** — concepts that map 1:1 to DEX / CEX surfaces. Adopt the
  source vocabulary AND the visual idiom. The user's existing muscle
  memory transfers; tooltips reinforce.
- **Tier B** — concepts with no DEX analog OR with semantically different
  meanings. Keep the lending-native name (the term Vaipakam users will
  learn). Borrow the visual idiom from the DEX surface a user would
  reach for, so the layout / chip / CTA placement still feels familiar.

Each entry below ships with a current-state note (what the page does
today) and a target-state note (what the page should do after the
per-page rework).

---

## Tier A — Vocabulary Borrows

These are the parts where Vaipakam IS doing the same thing a DEX / CEX
already does, and the user is well-served by the wording matching.

### A.1 — Range / limit-order entry shape

| Source | Shape | Vaipakam mapping |
|---|---|---|
| Uniswap V3 limit-order panel, dYdX limit panel, Binance / Bybit limit-order ticket | Min / max on amount + price + (sometimes) collateral; side toggle → asset pair → amount → price → expiry | `CreateOffer`'s `amount / amountMax`, `interestRateBps / interestRateBpsMax`, `collateralAmount / collateralAmountMax` (#163 / #164 / #187) |

**Current state:** `CreateOffer.tsx` exposes the ranged fields via the
Advanced toggle (#165), but the layout mixes lending vocabulary into a
single form. Sliders / number inputs aren't laid out the way a DEX
limit ticket is.

**Target state:** Order-entry layout shaped as `[Side toggle] → [Asset
pair] → [Amount range] → [Rate range] → [Collateral range] → [Expiry
preset]` so it scans visually identical to a DEX limit-order panel.
Tooltips on each field reference the matching DEX surface ("This is
your minimum and maximum, like a Uniswap V3 limit order").

### A.2 — Fill modes (AON / IOC / FOK / POST)

| Source | Shape | Vaipakam mapping |
|---|---|---|
| Binance / Bybit / CEX-style fill-mode toggle (AON = all-or-none, IOC = immediate-or-cancel, FOK = fill-or-kill, POST = post-only) | Modifier chip below the limit ticket | Contract surface tracked in [#125](https://github.com/vaipakam/vaipakam/issues/125); UI vocabulary lands alongside |

**Current state:** Not yet exposed; today every offer is implicitly
GTC + partial-fill-allowed (the matchOffers default).

**Target state:** Fill-mode chip on `CreateOffer` once #125 lands the
contract surface. Vocabulary matches the source exactly (AON / IOC /
FOK / POST). Tooltips name the matching DEX / CEX behaviour.

### A.3 — Order expiry (GTC / GTT / DAY)

| Source | Shape | Vaipakam mapping |
|---|---|---|
| Every DEX limit panel, every CEX ticket | Expiry dropdown (Never / 1d / 7d / 30d / custom) | GTC today (default); GTT / GTD via [#195](https://github.com/vaipakam/vaipakam/issues/195) |

**Current state:** All offers are GTC (no expiry field on `Offer`).

**Target state:** Once #195 lands, `CreateOffer` gains an "Expiry"
field with quick presets (Never / 24h / 7d / 30d / custom). "Never"
maps to GTC. `OfferBook` shows a relative idiom ("expires in 3h 12m")
on rows with non-zero expiry. `OfferDetails` shows the absolute date.

### A.4 — In-place order modification

| Source | Shape | Vaipakam mapping |
|---|---|---|
| dYdX, Bybit, some Uniswap V3 LP managers (modify range without cancel + recreate) | Pencil icon on an own-side row → modal with editable fields → "Save" | Contract surface tracked in [#193](https://github.com/vaipakam/vaipakam/issues/193) |

**Current state:** Modifying an open offer requires `cancelOffer` +
`createOffer` (two transactions, two gas charges). The UI doesn't
offer an explicit modify path.

**Target state:** Pencil icon on the row when the connected wallet
owns the offer. Modal with the same fields as `CreateOffer` pre-filled
from the live offer. Saves via `setOfferAmount` / `setOfferRate` /
`setOfferCollateral` once #193 lands.

### A.5 — Slippage tolerance display + override

| Source | Shape | Vaipakam mapping |
|---|---|---|
| Every DEX swap surface | "Slippage %" with a sensible default and a tweakable input | Already present on the liquidation surface (`LiquidateButton`); the convention should be uniform across every aggregator-routed flow |

**Current state:** Slippage is exposed on the liquidator surface but
inconsistent on other aggregator paths (treasury convert, internal
swap routes).

**Target state:** Same slippage chip + tooltip everywhere an aggregator
is involved. Default value driven by `liquiditySlippageBps`-equivalent
config; user override capped at a sane ceiling.

### A.6 — Basis points display

| Source | Shape | Vaipakam mapping |
|---|---|---|
| Rate-based AMMs, perp funding tickers, CEX fee tiers | "%" on the surface, BPS exposed on hover | The protocol uses BPS exclusively — `interestRateBps`, `liquidationLtvBps`, etc. |

**Current state:** UI shows "%" without exposing the BPS underneath.
For a user crossing between a Vaipakam interest-rate input and the
protocol's stored value, the unit conversion is invisible.

**Target state:** Every "%"-rendered figure carries a `title=` /
tooltip with the BPS value ("5.05 % (505 bps)"). The chip on hover
mirrors how Binance / Bybit surface "0.10% (10 bps)" on fee-tier
hovers.

### A.7 — Base / quote pair selector

| Source | Shape | Vaipakam mapping |
|---|---|---|
| Every DEX | Base/quote chip at the top of the order book ("ETH/USDC", "WBTC/USDC") | `OfferBook` is intrinsically about lending / collateral pairs; the pair-pivot view makes it scannable |

**Current state:** `OfferBook` is a flat table; `CreateOffer`'s
dropdowns are "lending asset" + "collateral asset". The pair view
isn't exposed at all.

**Target state:** `OfferBook` gains a base/quote chip row above the
table (e.g., "WETH / USDC", "WBTC / USDC", "WETH / DAI") with click-to-
filter. The table below filters to the selected pair. Optional default
view = "All pairs".

### A.8 — Gas / network-fee disclosure

| Source | Shape | Vaipakam mapping |
|---|---|---|
| Every DEX swap-confirm modal | Estimated gas in native + USD, slippage-aware, refreshes pre-sign | Every state-mutating entry point (accept, create, repay, preclose, refinance, claim, add-collateral, partial-withdraw, early-withdraw) |

**Current state:** Permit2 preview + `LiquidateButton` already show
gas; many other entry points don't.

**Target state:** Gas chip appears on every confirm-modal as a uniform
visual; the chip is consistent in placement (bottom of the modal,
above the primary CTA) across every state-mutating path.

### A.9 — Order-book idioms on `OfferBook`

| Source | Shape | Vaipakam mapping |
|---|---|---|
| Binance / Bybit / Coinbase orderbook | Bid (green) / ask (red) side colouring; sortable columns; fill-progress bars on partially-filled rows | `OfferBook` is order-book by nature — P2P matched offers |

**Current state:** The OfferBook is a generic data table without
order-book-style idioms.

**Target state:** Borrower offers (asks) and lender offers (bids)
visually distinct via colour or column; sortable on amount / rate /
collateral / expiry; partial-fill progress as a thin bar on each row
(reads `amountFilled / amountMax`).

### A.10 — Notional / quantity toggle

| Source | Shape | Vaipakam mapping |
|---|---|---|
| Bybit / Binance limit-order panels | Toggle: "I want to enter [Quantity] OR [Notional]"; the other field auto-computes | `CreateOffer` accepts `amount` (quantity); many users think in notional ("I want to lend $5k worth of ETH") |

**Current state:** `CreateOffer` only accepts quantity. The user
mentally converts notional → quantity using the oracle price.

**Target state:** Toggle on `CreateOffer` between "Enter as token
amount" and "Enter as $ notional". The non-selected field auto-computes
from the chain's price oracle (same oracle the protocol already reads
at accept time).

### A.11 — "You sell / You buy" notation on confirm modals

| Source | Shape | Vaipakam mapping |
|---|---|---|
| Uniswap / 1inch / Cowswap swap-confirm modals | Two bold lines: "You sell: X TOKEN_A", "You receive: Y TOKEN_B" | Every accept / create / repay / preclose / refinance / early-withdraw / partial-withdraw / add-collateral confirm modal |

**Current state:** Confirm-modal copy varies per page.

**Target state:** Every confirm modal renders the asset movement in
the same two-line shape: "You will [give / lock / lend]: X TOKEN_A",
"You will [receive / borrow]: Y TOKEN_B". The verbs change per surface
but the visual shape doesn't.

### A.12 — Risk-disclosure / consent-modal idiom

| Source | Shape | Vaipakam mapping |
|---|---|---|
| Uniswap V3 LP page's "I understand impermanent loss" checkbox; Uniswap warning banner on low-liquidity tokens | Inline checkbox + short risk callout above the primary CTA | Every state-mutating path where user funds move (accept, refinance, preclose, early-withdraw) needs the consistent risk-callout shape |

**Current state:** `riskAndTermsConsent` is captured at offer-create
time; the visual shape varies per page.

**Target state:** Single shared `RiskCallout` component reused on every
state-mutating confirm; same colour band, same inline checkbox, same
"Confirm risks" copy pattern.

### A.13 — KYC-tier-up inline callout

| Source | Shape | Vaipakam mapping |
|---|---|---|
| Uniswap "Slippage too high, increase tolerance?" inline yellow callout (non-blocking modal) | Inline notification with one-click action | When the user crosses one of the tiered numeraire thresholds (`LibVaipakam.getKycTier0Threshold()` / `getKycTier1Threshold()`) mid-flow on the industrial-deploy fork |

**Current state — industrial-deploy fork only:** KYC-tier crossing
surfaces as a blocking error on the industrial-deploy fork (the only
deploy where the runtime KYC gate is enabled). On the retail deploy
the KYC enforcement is runtime-disabled (`s.kycEnforcementEnabled =
false` per CLAUDE.md's "Retail-deploy policy"); the callout shape
here is not exercised because no KYC check fires.

**Target state — industrial-deploy fork only:** Inline yellow
callout: "This loan size needs Tier-2 KYC. [Verify] to continue."
Same shape as a DEX slippage-too-high nudge, never a full-page modal.
This Tier-A entry is captured for the industrial deploy; the retail
deploy keeps the runtime gate off and never renders the callout.

---

## Tier B — Retentions (Lending-Native Naming, DEX Visual Idioms)

These are the parts where the lending semantics genuinely differ from
the closest DEX surface, but the visual idiom should still feel
familiar.

### B.1 — Health Factor (HF) + LTV

DEXs don't have an HF concept (their nearest is "liquidation price",
which is a different scalar). CEXs have "margin ratio", which is
NUMERICALLY different from HF. Keep "Health Factor" as the name.

**Borrow:** Aave / Compound / Morpho's HF rendering — colour bands
(green ≥ 2.0, yellow 1.5 – 2.0, orange 1.0 – 1.5, red < 1.0),
sparkline of recent HF, "Advanced details" disclosure for the
component readings (collateral value, debt value, liquidation
threshold).

### B.2 — Liquidation grace, time-based default

No DEX concept. Keep the lending-native names ("Grace period",
"Time-based default"). **Borrow** the visual idiom from a CEX's
"Position expiry countdown" — a clear countdown chip on `LoanDetails`
once grace has started, transitioning colour as the deadline
approaches.

### B.3 — Offer accept

DEXs don't have a discrete "accept an offer" action (their orders
match continuously). Keep "Accept" naming.

**Borrow:** Uniswap / 1inch swap-confirm-modal layout — terms summary
at the top → asset-movement two-line (Tier A.11) → risk callouts
(Tier A.12) → gas chip (Tier A.8) → primary CTA pinned at the bottom.

### B.4 — Collateral (add / withdraw / partial)

DEXs don't have collateral (spot swap is unsecured by definition).
Keep "Collateral" naming.

**Borrow:** Aave / Morpho's "Your Position" panel layout — a single
card showing current collateral, available headroom, locked vs.
withdrawable. `AddCollateral` and `PartialWithdraw` plug into the same
panel as "Top up" / "Withdraw" CTAs in the standard Aave-style spot.

### B.5 — Loan settlement / preclose / refinance

Vaipakam-specific terms. Keep distinct naming.

**Borrow:** the visual idiom of a CEX position-close ticket — terms
summary → settlement amount preview → fee breakdown → primary CTA.
"Repay" / "Preclose" / "Refinance" CTAs sit where DEX "Approve / Sign"
CTAs sit (bottom of panel, primary colour).

### B.6 — Liquidation auction / dust close

Protocol mechanics. Name distinctly — never "stop-loss" (which means
something else CEX-side and would mislead).

**Borrow:** the "Limit order filled" notification shape from DEXs —
toast / inline notification with the trade summary, plus a link to
`LoanDetails` for the post-mortem.

### B.7 — Early withdrawal haircut

No DEX cousin (DEX limit orders just cancel; there's no penalty to
unwind a position early). Keep "Early withdrawal" naming.

**Borrow:** the "Slippage impact warning" shape DEXs render when a
swap is about to take significant price impact — same colour band,
same inline copy pattern showing the haircut percentage.

### B.8 — Match (mid-loan internal-liquidation matching, if shipped)

Vaipakam-roadmap-specific. Name "Match" (DEXs use "match" for
order-book fills too — semantically close). Borrow the CEX
matching-engine telemetry idiom — depth bar showing how much of the
loan can be matched, fill confirmation animation.

### B.9 — NFT rental prepay + buffer

Entirely lending / rental-native. No DEX cousin.

**Borrow:** the "Gas fee + slippage + fee total" line shape DEXs use
above the primary CTA. Render the prepay-due-now figure in the same
slot ("Prepay due: 30 × 0.5 USDC = 15 USDC, plus 5% buffer = 15.75
USDC").

### B.10 — Claim (post-settle / post-default / post-liquidation)

"Claim" exists in DEX context too (fee / reward sweeps), so the term
is shared. Keep the name. **Borrow** the CTA placement + post-claim
confirmation idiom from DEX yield-aggregator fee-claim flows.

---

## Page-by-Page Checklist

Each row names a page, the Tier-A / Tier-B borrows that apply, and
what concretely changes. Sub-card column lists the implementation
follow-up issue that will track the work. ETA estimates are rough.

| Page | Current state | Tier-A borrows that apply | Tier-B retentions / visual idioms | Concrete changes | Sub-card |
|---|---|---|---|---|---|
| **`CreateOffer.tsx`** | Form mixes lending vocab; Advanced toggle exposes ranges | A.1, A.2, A.3, A.5, A.6, A.10, A.12 | — | Re-layout to DEX limit-ticket shape; expiry preset; fill-mode chip (post-#125); notional/quantity toggle; BPS tooltips; consistent RiskCallout component | Issue TBD |
| **`OfferBook.tsx`** | Generic table; no pair pivot; no fill-progress bars | A.6, A.7, A.9, A.4 | — | Base/quote pair chip row; bid/ask colour; fill-progress bars; sortable columns; pencil-icon-modify on own-side rows (post-#193) | Issue TBD |
| **`OfferDetails.tsx`** | Acceptance UI lives here (confirm modal embedded) | A.6, A.8, A.11, A.12 | B.3 | DEX-swap-confirm-shape modal: terms summary → two-line asset movement → RiskCallout → gas chip → primary CTA at bottom | Issue TBD |
| **`Dashboard.tsx`** | Position list + KPIs | A.6 | B.1, B.4 | HF colour band + sparkline on every loan row; Aave-style "Your Position" panel; KPIs in DEX-portfolio-page layout | Issue TBD |
| **`LoanDetails.tsx`** | Loan KPIs + actions (repay / preclose / refinance) | A.6, A.8, A.11 | B.1, B.2, B.5, B.6 | HF panel with colour band + sparkline; grace countdown chip when applicable; CEX-position-close-shape modal for repay / preclose / refinance; B.6 toast on liquidation | Issue TBD |
| **`Refinance.tsx`** | Lender-pick + counter-offer flow | A.1, A.6, A.8, A.11, A.12 | B.5 | Pre-filled limit-ticket-shape form; HF preview with colour band; consistent RiskCallout | Issue TBD |
| **`BorrowerPreclose.tsx`** | Mutual / direct / offset preclose paths | A.6, A.8, A.11, A.12 | B.5 | CEX-position-close-shape modal for each preclose path; clear delta of "What you receive" / "What you pay" | Issue TBD |
| **`LenderEarlyWithdrawal.tsx`** | Lender early-exit-with-haircut | A.6, A.8, A.11, A.12 | B.7 | Haircut % rendered like DEX slippage impact (colour band + warning copy); confirm-modal shape from B.3 | Issue TBD |
| **`AddCollateral.tsx` (currently inside Dashboard or LoanDetails — may split)** | Borrower HF-rescue | A.6, A.8, A.11 | B.4 | Aave-style "Top up" CTA on the Your Position panel; HF-after preview | Issue TBD |
| **`PartialWithdraw.tsx` (currently inside LoanDetails — may split)** | Borrower partial collateral pull | A.6, A.8, A.11 | B.4 | Aave-style "Withdraw" CTA on the Your Position panel; HF-after preview as a colour band | Issue TBD |
| **`Repay.tsx` (currently inside LoanDetails)** | Full / partial repay | A.6, A.8, A.11, A.12 | B.5 | CEX-position-close-shape modal; full vs. partial chosen by chip | Issue TBD |
| **`ClaimCenter.tsx`** | Post-settle / -default / -liquidation withdraw | A.6, A.8, A.11 | B.10 | DEX-yield-aggregator-fee-claim-shape; clear list of "X claimable" items with bulk-claim option | Issue TBD |
| **`MatchOffers UI` (post-#187 partial-fill; may live inside OfferBook or its own page)** | matchOffers + previewMatch | A.6, A.8, A.9 | B.8 | Order-book idioms on partial-fill rows; previewMatch surfaced as a CEX-matching-engine depth view | Issue TBD |
| **NFT rental flow (within CreateOffer / OfferDetails)** | Rental fee + prepay buffer | A.6, A.8, A.11 | B.9 | Prepay-due-now line in the same slot DEXs render the gas-fee total; BPS tooltip on the rental rate | Issue TBD |
| **`SanctionsBanner` / KYC-gate / country-pair-deny surfaces** | Conditionally rendered banners | A.13 | — | Inline-yellow-callout shape (not blocking modal). Sanctions copy stays narrow per CLAUDE.md retail-deploy policy. KYC + country gates stay runtime-disabled on retail; the callout shape exists for the industrial-deploy fork. | Issue TBD |
| **`Activity.tsx`** | Recent loan / offer events | A.6, A.9 | — | DEX-order-history-shape — clear status chips, base/quote pair chip per row, click-into-loan/offer | Issue TBD |
| **`Allowances.tsx`** | ERC20 approvals manager | A.8, A.11 | — | DEX-approvals-manager-shape (Revoke.cash style) — one row per (token, spender) with revoke CTA | Issue TBD |
| **`BuyVPFI.tsx`** | Direct-buy + cross-chain buy flow | A.5, A.8, A.11 | — | DEX-swap-shape on the direct-buy leg; slippage chip; clear "Receive on chain X" disclosure on cross-chain | Issue TBD |
| **`Alerts.tsx`** | HF / liquidation / settlement alerts config | — | B.1 | Same HF colour bands used in B.1 — alert threshold UI references the same band rendering | Issue TBD |
| **`KeeperSettings.tsx`** | Per-keeper approvals + per-action authorisation | A.6 | — | Tabular shape; explicit on/off chips per (keeper, action); same as a CEX API-key permissions matrix | Issue TBD |
| **Admin / utility / chrome pages (`AppLayout`, `AdminDashboard`, `EscrowAssets`, `EscrowRecover`, `NftVerifier`, `DataRights`, `PublicDashboard`)** | Routing shell + operator + utility shape | A.6, A.8 | — | Out of scope for this UX direction pass. `AppLayout` is the shared routing shell (nav / chrome); chrome reworks are a separate concern from the per-page rework this ADR scopes. Admin + utility surfaces don't need the retail-DEX visual idioms. Standardise BPS + gas idioms only across the row. | Out of scope |

The sub-cards are deliberately left as "Issue TBD" in this PR. They'll
be filed as a batch in the same wave that this ADR PR merges, so the
ADR is the single source the sub-cards reference for "what's the
target state".

---

## Sub-Cards to File (when this ADR merges)

One implementation card per significant per-page rework, each linking
back to this ADR for context. The cards land grouped by user journey
so review can prioritise:

**Order-entry journey:**
- Sub-card 1: `CreateOffer.tsx` re-layout to DEX limit-ticket shape
  (Tier A.1, A.6, A.10, A.12).
- Sub-card 2: `OfferBook.tsx` order-book idioms (Tier A.7, A.9) +
  pencil-icon-modify (Tier A.4, gated on #193).
- Sub-card 3: `OfferDetails.tsx` confirm modal in DEX-swap-confirm
  shape (Tier A.11, A.12 + B.3).

**Active-loan journey:**
- Sub-card 4: `Dashboard.tsx` Aave-style "Your Position" panel + HF
  colour bands (Tier B.1, B.4).
- Sub-card 5: `LoanDetails.tsx` rework — HF panel + grace countdown +
  CEX-position-close confirm shape on the LoanDetails surface itself
  (Tier B.1, B.2, B.5, B.6); the per-action sub-pages (repay /
  preclose / refinance / early-withdraw / add-collateral /
  partial-withdraw) each get their own sub-card below so the
  traceability from checklist row to execution ticket is 1:1.
- Sub-card 5a: in-page `Repay` flow (full + partial) — CEX-position-
  close-shape modal; full vs. partial chosen by chip (Tier B.5).
- Sub-card 5b: `Refinance.tsx` — pre-filled limit-ticket-shape form;
  HF preview with colour band; consistent RiskCallout (Tier A.1,
  A.12, B.5).
- Sub-card 5c: `BorrowerPreclose.tsx` — mutual / direct / offset
  preclose CEX-position-close-shape modal per path (Tier A.11,
  A.12, B.5).
- Sub-card 5d: `LenderEarlyWithdrawal.tsx` — haircut % rendered like
  DEX slippage impact (colour band + warning copy); confirm-modal
  shape from B.3 (Tier A.11, A.12, B.7).
- Sub-card 5e: in-page `AddCollateral` + `PartialWithdraw` flows —
  Aave-style "Top up" / "Withdraw" CTAs on the Your Position panel;
  HF-after preview (Tier B.4). Two flows in one card because they
  share the same panel slot and the same HF-preview component.

**Post-loan journey:**
- Sub-card 6: `ClaimCenter.tsx` claim shape (Tier B.10).

**Cross-cutting components:**
- Sub-card 7: shared `RiskCallout` component + the consent-modal idiom
  rolled out everywhere a state-mutating path consumes consent (Tier
  A.12). Lands once and every page consumes it.
- Sub-card 8: BPS / `%` rendering helper (Tier A.6) + the gas-chip
  component (Tier A.8) — both shared, both reused everywhere.

**Conditional surfaces:**
- Sub-card 9: `SanctionsBanner` and the conditional callout shape for
  KYC-tier-crossing + country-pair-deny (Tier A.13). The KYC + country
  gates stay runtime-disabled on retail per CLAUDE.md; the component
  shape exists for the industrial-deploy fork only.

**Adjacent surfaces:**
- Sub-card 10: `BuyVPFI.tsx` DEX-swap shape + cross-chain disclosure
  (Tier A.5, A.8, A.11).
- Sub-card 11: `Activity.tsx` + `Allowances.tsx` DEX-history /
  approvals-manager shape (Tier A.6, A.9).
- Sub-card 12: `KeeperSettings.tsx` + `Alerts.tsx` — tabular
  on/off-chip permissions matrix for keeper settings (CEX API-key-
  permissions idiom); HF colour-band threshold UI for alerts that
  reuses B.1's component (Tier A.6 + B.1). One card because both
  are settings surfaces a typical user touches together.

Each sub-card carries a one-paragraph reference back to the relevant
sections of this ADR, the matching DEX / CEX surfaces it's modelled
on, and the concrete shipping deliverables.

---

## Out of Scope (Not Borrowed)

For the record, the following DEX / CEX vocabulary borrows were
considered and rejected:

- **"Margin ratio"** instead of Health Factor — semantically different
  scalar; would silently mislead a user crossing over from a perp
  surface where margin ratio means liquidation-distance-as-a-multiple-
  of-position-size.
- **"Stop-loss"** instead of Liquidation — DEX stop-losses are
  user-set and discretionary; liquidation is protocol-enforced and
  HF-driven. Different action, different timing, different price
  trigger.
- **"AMM-style pool depth view"** on the `OfferBook` — Vaipakam is
  order-book, not AMM. Borrowing the AMM depth idiom would suggest
  continuous-fill semantics that don't exist here.
- **"Funding rate"** copy on the interest-rate field — `interestRateBps`
  is fixed for the loan's lifetime (snapshotted at accept time), unlike
  a perp's funding rate which floats. Same word would mislead.
- **"Wallet 'Total balance'" idiom from CEX dashboards** — DEXs are
  intrinsically multi-chain and Vaipakam is too; a single "Total
  balance" number obscures the per-chain breakdown the user actually
  needs.

---

## Consequences

**Positive:**
- Onboarding speed for users coming from Uniswap / 1inch / dYdX /
  Binance — the muscle memory transfers in Tier A.
- Lower error rate on Tier B because the visual idiom is familiar,
  even if the concept is new.
- Per-page reworks have a single source of truth (this ADR) for
  "what's the target state".
- The sub-cards stay scoped — each ships a focused rework, not a
  vocabulary debate.

**Negative / Trade-offs:**
- ~11 sub-cards of UI work to land the full vision. Each can ship
  independently behind a feature flag (the protocol already uses
  kill-switch flags for backend work; the same pattern applies to
  rolled-out UI revamps).
- Some Tier-A borrows depend on contract surfaces that haven't shipped
  yet (#125 for A.2, #193 for A.4, #195 for A.3). Those sub-cards must
  block on the contract surface; the ADR's framing is good for "what
  this should look like" even before the contract is in place.

**Neutral:**
- The Cross-Chain Security Policy section of CLAUDE.md, the retail-
  deploy policy, and the existing FunctionalSpecs are unchanged. This
  ADR is UI-direction-only.

---

## Sequencing

This ADR is design-only. The first implementation sub-card can pick up
the moment this PR merges — no other dependencies. The per-page sub-
cards have their own dependencies (some need #125 / #193 / #195 on the
contract side first) and will be filed in the same wave as the merge.

Per the Roadmap, this is positioned **before** #125 / #126 / #103 in
the work queue. #103 (push-based webhook) will consume the visual
idioms catalogued here (Tier B latency-update shape).

---

## Related

- **#163 / #164** — canonical limit-order range fields the Tier-A
  shapes operate on.
- **#187** — Phase 2 role-aware reads + matchOffers GTC that the order-
  book and partial-fill idioms surface.
- **#125** — fill modes (AON / IOC / FOK / POST) sub-card depends on.
- **#193** — in-place offer modification (Tier A.4 sub-card depends on).
- **#195** — GTT / offer-expiry (Tier A.3 sub-card depends on).
- **#103** — push-based value-update channel (UX polish — affects the
  visual idioms in Tier B).
- **CLAUDE.md** — retail-deploy policy (sanctions / KYC / country-pair
  surface constraints) the framing in this doc respects throughout.
