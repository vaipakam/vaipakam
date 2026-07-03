# Alpha01 P5 — Advanced mode reveal

## Summary

Turns on Advanced-mode density across alpha01 without new routes: portfolio strip, HF/LTV panels, receipt technical details, and position filters.

## User-visible changes

- **Home (Advanced):** Portfolio strip shows borrower/lender counts, open offers, and loans with HF below 1.5.
- **Borrow / Lend / Rent receipts (Advanced):** Collapsible technical details (HF floor, LTV class, APR, rental buffer, offer IDs).
- **Positions (Advanced):** Role and at-risk filters; loan cards show live HF and LTV.
- **Loan detail (Advanced):** Technical risk panel with on-chain HF and LTV for borrower-side debt loans.
- **Open offers:** NFT rental listings/requests use rental vocabulary instead of debt-loan copy.

## Verification

- `pnpm --filter @vaipakam/alpha01 test`
- `pnpm --filter @vaipakam/alpha01 exec tsc -b --noEmit`