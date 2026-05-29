## T-086 — friendly error when a repay races a buyer's OpenSea fill

Closes a UX rough edge introduced by T-086's same-block race semantics. When a borrower clicks "Repay in Full" on a loan that has a live OpenSea prepay listing, and a buyer's `Seaport.fulfillOrder` lands earlier in the same block, EVM determinism resolves the race cleanly:

- Buyer's tx settles the prepay sale (pays lender + treasury + refunds borrower's remainder into the borrower vault)
- Borrower's repay tx then sees `loan.status != Active` and reverts `InvalidLoanStatus()`

Pre-this-change the dapp surfaced this as a generic "Repayment failed" message via the standard `decodeContractError` decoder. That's technically accurate but bad UX — the borrower's loan is in fact already settled, they've been paid out, and there's nothing to retry. Without a tailored message they'd reasonably assume something is wrong and try to re-submit (which would just revert again).

This change extends `LoanDetails.handleRepay` with a small post-revert check: it re-reads the loan from the diamond and, if `status === Settled`, replaces the generic error with a JSX message:

> Your loan has already been settled — a buyer filled your OpenSea prepay listing in the same block, paying the lender + treasury and refunding the remainder to your vault. Your repay didn't go through (no funds moved), and you don't need to retry. **View claimables →**

The "View claimables" text is a router link to `/claims` so the borrower can grab the refunded remainder in one click. The page-level `loadLoan()` also runs in the catch path so the banner + actions card flip to the post-Settled view immediately, not just on the next refresh.

### Why this is conservative

The Settled status is exclusively the prepay-sale terminal in T-086 — every other close path uses Repaid / Defaulted / Liquidated / FallbackPending. A false positive would require a status flip to Settled with the borrower's repay still in flight, which only happens via the prepay-sale executor callback. So the detection is essentially deterministic.

If the post-revert chain read fails for any reason (RPC blip, etc.), the code falls through to the generic `decodeContractError` path unchanged.

### Scope

- `apps/defi/src/pages/LoanDetails.tsx` — `handleRepay` catch path, plus `actionError` state type widened from `string` to `ReactNode` so it can carry the JSX message + link
- `apps/defi/src/i18n/locales/en.json` — two new translation keys

Preclose and refinance call sites are NOT updated. The MEV race window for those paths is narrower (preclose needs the borrower-NFT lock cleared first; refinance has its own preconditions that block during a live listing), and they live on dedicated pages with their own error surfaces. If the equivalent UX gap shows up in practice for those, it lands as a small follow-up — the helper here is local to `LoanDetails.tsx` and can be lifted to a shared util if needed.
