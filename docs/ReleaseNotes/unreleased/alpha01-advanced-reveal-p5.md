# Alpha01 P5 — Advanced mode reveal

## Summary

Turns on Advanced-mode density across alpha01 without new routes: portfolio strip, HF/LTV panels, receipt technical details, and position filters.

## User-visible changes

- **Home (Advanced):** Portfolio strip plus shortcuts to Claims, VPFI vault, allowances, and analytics.
- **Borrow / Lend / Rent (Advanced):** Bounds/construction panels on wizard steps; browse cards show offer IDs, liquidity class, and rental buffer; receipts include collapsible technical details.
- **Positions (Advanced):** Role and at-risk filters; loan cards show live HF and LTV.
- **Loan detail (Advanced):** Technical risk panel; link-out to classic app for add-collateral, preclose, and refinance.
- **Claims (Advanced):** Settlement breakdown panel with status, claim asset, and VPFI LIF rebate when applicable.
- **More (Advanced):** Keeper settings, risk access, allowances, analytics, and NFT verifier link to `defi.vaipakam.com`.
- **Open offers:** NFT rental listings/requests use rental vocabulary instead of debt-loan copy.

## Verification

- `pnpm --filter @vaipakam/alpha01 test`
- `pnpm --filter @vaipakam/alpha01 exec tsc -b --noEmit`