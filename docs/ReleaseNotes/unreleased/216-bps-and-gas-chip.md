## Shared BPS helper + GasChip component (Issue #216)

Per the UX direction ADR Tier A.6 + A.8 (`docs/DesignsAndPlans/UxDirectionDexCexHybrid.md`, merged via PR #201), every rate / fee surface in `apps/defi` should render a percent display with a basis-points qualifier on hover, and every state-mutating confirm modal should disclose an estimated network fee in a uniform visual shape pinned above the primary CTA. Pre-#216 those two needs were met by ad-hoc inline expressions scattered across five pages (`Dashboard`, `LenderEarlyWithdrawal`, `NftVerifier`, `PublicDashboard`, `OfferBook` — for the BPS side) and two surfaces (`LiquidateButton`, Permit2 preview — for the gas side), each in its own visual treatment.

This release adds the two cross-cutting unblockers the #166 ADR called out as sub-card 8:

- **`apps/defi/src/lib/bpsFormat.ts`** — pure-function `formatBps(bps, opts)` returning `{ display, tooltip }` (e.g. `"5.05 %"` + `"5.05 % (505 bps)"`). Configurable precision (default 2, with documented per-surface overrides — HF / LTV chips at 1, fee rows at 2, tier-comparison tables at 3) and an opt-out for surfaces where the BPS qualifier would confuse a non-DeFi reader. Convenience wrappers `bpsToDisplay` / `bpsToTooltip` for surfaces that only need one side. Handles negative, zero, NaN, and Infinity inputs explicitly.
- **`apps/defi/src/components/app/BpsValue.tsx`** — thin React wrapper that renders a `<span>` with the display in the visible slot and the tooltip text in `title=`. Composable: `<BpsValue bps={505} />` replaces every ad-hoc `${(bps / 100).toFixed(2)} %` expression.
- **`apps/defi/src/components/app/GasChip.tsx`** — pure-presentational network-fee chip. Takes pre-computed `gasUnits` + `gasPriceWei` + `nativePriceUsd` props and renders `"0.00063 ETH (~ $1.89)"`. Auto-shows an em-dash placeholder when the estimate is in flight so the consuming modal layout doesn't flicker. The chip deliberately makes NO RPC calls — the consuming page owns the estimate fetch + the refresh-pre-sign policy.
- **`apps/defi/src/components/app/GasChip.css`** — neutral grey chip with `tabular-nums` digit metric so consecutive renders during refresh-pre-sign don't cause the chip width to dance.

Tests: 11 cases for `formatBps` (typical / sub-1% / zero / negative / custom precision / withBpsHint / NaN / Infinity / convenience wrappers), 7 cases for `BpsValue` (display / tooltip / precision / withTitle / className / NaN placeholder), 11 cases for `GasChip` (native amount + USD qualifier + non-18-dec / pending states / non-finite price guard / accessibility / className / trailing-zero trimming).

NO consumer migrations in this release — each of the ~10 consuming sub-cards (most #166 sub-cards consume one or both) lands its own minimal diff that swaps the ad-hoc pattern for `<BpsValue/>` / `<GasChip/>`. This card ships the components alone.

Accessibility:

- `BpsValue` exposes the BPS qualifier via the standard `title=` attribute (native tooltip on hover; AT picks it up via the accessible-name fallback chain).
- `GasChip` exposes the chip as `role="status"` with an `aria-label` (default `Estimated network fee`; consumers can override for cross-chain or CCIP-fee surfaces).

Closes #216. Unblocks the remaining #166 sub-cards (#204, #206, #207, #208, #210, #211, #212, #218, #219) — every one of them consumes one or both of these components.
