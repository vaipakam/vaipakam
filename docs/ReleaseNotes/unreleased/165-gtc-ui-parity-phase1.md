## Thread — Canonical limit-order UI on the offer-create form (Phase 1 of #165) (PR #<n>)

Closes the implementation half of [#165](https://github.com/vaipakam/vaipakam/issues/165), Phase 1: pure frontend. The contract already supports the canonical limit-order semantic via #102's borrower partial-fill + #164's collateral range + Phase 1's amount/rate range. This PR makes the offer-create UI on `apps/defi` actually USE that semantic.

### What changes

The form on `CreateOffer.tsx` now presents role-asymmetric headline numbers per [ADR-0010 §17.1](https://github.com/vaipakam/vaipakam/blob/main/docs/adr/0010-canonical-rate-semantics.md). One input per field; the user enters the bound that matters from their side; `toCreateOfferPayload` routes it into the contract's `amount` / `amountMax` / `collateralAmount` / `collateralAmountMax` / `interestRateBps` / `interestRateBpsMax` floor/ceiling fields per the mapping table.

| Side | Field | What the user sees | What the contract gets |
|---|---|---|---|
| Lender | Amount | "Lend up to (tokens)" | `amount = 1 wei`, `amountMax = X` (pre-escrowed) |
| Lender | Rate | "At minimum interest rate (APR %)" | `interestRateBps = P×100`, `interestRateBpsMax = 10_000` (= MAX_INTEREST_BPS) |
| Lender | Collateral | "Require at least (collateral)" | `collateralAmount = Z` (single-value per #164 lender invariant) |
| Borrower | Amount | "Borrow at least (tokens)" | `amount = Y`, `amountMax = 0` (contract derives from collateral × init-LTV cap) |
| Borrower | Rate | "At maximum interest rate (APR %)" | `interestRateBps = 0`, `interestRateBpsMax = Q×100` |
| Borrower | Collateral | "Lock up to (collateral)" | `collateralAmount = 0`, `collateralAmountMax = W` (pre-escrowed) |

### What's removed / hidden

The Advanced-mode dual min/max input row (the previous way users expressed a range — separate "Min" and "Max" inputs visible only in Advanced mode and only when governance had flipped the relevant master flag) is **forced hidden**. The form-state fields `amountMax` / `interestRateMax` / `collateralAmountMax` remain in `OfferFormState` for backwards-compat with any deep-linked URL that still carries them, but `toCreateOfferPayload` ignores them under the canonical-GTC mapping.

### What's added

- `offerSchema.ts`'s `toCreateOfferPayload` now implements role-asymmetric translation. Single-source-of-truth for the mapping; consumers (frontend form submit, future SDK clients) get the same translation by going through this function.
- `MAX_INTEREST_BPS = 10_000` mirrored from `LibVaipakam.MAX_INTEREST_BPS`. Documented inline.
- 12 new i18n keys (6 per role across 10 locales) for the role-asymmetric labels. Style follows each locale's existing `amountMin` / `amountMax` precedent.

### What stays in `OfferFormState` (for now)

`amountMax` / `interestRateMax` / `collateralAmountMax` remain as form-state fields. Three reasons:

1. **Deep-linked URLs from before this PR** carry them in their state shape; removing the type fields would cause runtime errors when those URLs deserialize.
2. **Phase 2 of #165 (a follow-up)** will add live LTV/HF risk indicators (green/yellow/orange/red zones per ADR-0010 §17.2). Those indicators MAY want an "override mode" where advanced users explicitly enter a tighter cap. Keeping the fields in state for now leaves the door open.
3. **No payload impact** — the GTC mapping in `toCreateOfferPayload` reads only the single user-entered values; the `*Max` form-state fields are dead in the new mapping.

If Phase 2 lands without using them, they can be removed cleanly in a follow-up.

### Phase 2 of #165 (separate follow-up PR)

What's NOT in this PR — explicitly deferred to a Phase 2 follow-up so this MVP can land:
- Live LTV / HF risk indicator (the green/yellow/orange/red zone display)
- Basic-mode toggle re-purpose (currently still gates the Advanced sliders that are now hidden; should become a risk-display-verbosity toggle)
- Per-field placeholder + hint copy refresh to match the new role-asymmetric meaning
- Cross-link in `apps/defi/src/pages/OfferBook.tsx` if the book view's column labels imply the old min/max semantic

### Verification

- ✅ `pnpm --filter @vaipakam/defi exec tsc -b --noEmit` clean
- ✅ 10/10 locale JSON files valid; 6/6 new keys per locale
- Manual: lender / borrower toggle on `CreateOffer.tsx` swaps the field labels live; payload submit translates the user's single-value input through the new role-asymmetric mapping
- Contract-side: ADR-0010 mapping is what the deployed contracts already honor (via PRs #167 / #170 / #174)

### Round-1 Codex correction — payload reverts to single-value

Codex round-1 on PR #175 caught five P1s + one P2 that collectively revealed: the ADR-0010 §17.1 split-floor/ceiling mapping was written assuming `OfferMatchFacet.matchOffers` is the canonical match flow, but the contract still exposes `OfferAcceptFacet.acceptOffer` for direct single-match accepts. The direct-accept path reads `offer.amount`, `offer.interestRateBps`, and `offer.collateralAmount` literally — not via the matchOverride derivation. Shipping the ADR split-mapping would have let:

- a borrower direct-accept a lender offer with `amount = 1 wei` and walk away with a 1-wei loan;
- a lender direct-accept a borrower offer with `interestRateBps = 0` at 0 % APR;
- a lender direct-accept a borrower offer with `collateralAmount = 0` without pulling any collateral.

All real underpayment / fund-loss vectors caught pre-merge.

**Phase 1 corrected scope** (what this PR ships): role-asymmetric LABELS over **single-value** payloads. The user's headline number lands in the floor field (`amount` / `interestRateBps` / `collateralAmount`); the `*Max` ceilings auto-collapse to zero. The contract reads `*Max == 0` as "treat as single-value at the floor", so both the direct-accept path AND `matchOffers` land at the same loan terms. The UX shift (lender thinks "Lend up to X", borrower thinks "Borrow at least Y") is purely labels — fully audit-safe.

**Phase 2 will revisit the full ADR-0010 §17.1 mapping** — either by gating legacy `acceptOffer` on a flag at the contract level (prevents the underpayment class structurally), or by adding explicit min/max range inputs for users that want true range orders. Both are contract-touching follow-ups out of #165 Phase 1's scope.

### Dependencies

- ✅ #102 (PR #174) — borrower partial-fill (the contract surface that #165 Phase 2 will plumb through)
- ✅ #163.A (PR #171) — ADR-0010 (the design lock; Phase 1 implements the LABELS half; Phase 2 implements the contract-mapping half)
- ✅ #164 (PR #167) — borrower collateral range
- ✅ #169 (PR #170) — single-cold-compile CI shape

Downstream: [#172](https://github.com/vaipakam/vaipakam/issues/172) — apps/keeper matcher updates to seek borrower partial-fill candidates (parallel-track PR).
