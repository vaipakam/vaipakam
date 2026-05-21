## Thread — Borrower-side collateral range on offers (PR #<n>)

Closes #164. Range Orders Phase 1 (PR #46) added lender-side ranges on
the lending **amount** and **interest rate**, and threaded those through
the matching core (`previewMatch` / `matchOffers`). The third axis — the
**borrower-side collateral** — stayed single-value. So a borrower who
wanted to express *"I'll lock between 1.0 ETH and 2.5 ETH against this
borrow, match me to whatever loan fits in that range"* had no way to do
it on-chain. This release adds the missing axis.

### What changes

**Offer storage** grows two append-only fields (slots 18, 19 of the
`Offer` struct):

- `collateralAmountMax` — borrower's upper bound on what they'll lock.
  Zero at create-time auto-collapses to `collateralAmount`, so every
  legacy single-value caller behaves byte-for-byte the same as before.
- `collateralAmountFilled` — cumulative collateral consumed across all
  matches against this offer. Borrower-side partial fills are NOT
  enabled in Phase 1 (mirrors `amountFilled`), so this field stays 0
  across all Phase 1 borrower matches. Wired in now so #102 (borrower
  partial-fill) can start writing without another storage migration.

**Match semantics — single-value preserved, clamp-up only on real
ranges.** Per Codex round-1 P1, the two cases are branched explicitly:

- **Single-value / legacy borrower offer** (`collateralAmountMax ==
  collateralAmount`, OR `collateralAmountMax == 0` for a pre-#164
  storage row): pre-#164 semantic exactly. Locked collateral equals
  the lender's pro-rated requirement; OfferMatchFacet refunds the
  overage. Borrower UX expectation ("I posted X and the protocol
  locks what's actually needed up to X") is preserved bit-for-bit.

- **Real ranged borrower offer** (`collateralAmountMax >
  collateralAmount`): clamp the locked amount UP to the borrower's
  min so a borrower who committed AT LEAST X gets at least X locked
  (better HF cushion, lender happy). Mirrors how amount overlap
  works today (`lo = max(L.amount, B.amount)` — both sides' minimums
  constrain the floor together). Match fails only when the clamped
  value exceeds the borrower's remaining ceiling.

Round-1 review also surfaced a fund-lock regression on the cancel path
(borrower had escrowed `collateralAmountMax` but
`OfferCancelFacet.cancelOffer` was still withdrawing
`collateralAmount` — the `max - min` tail would have been trapped on
cancellation of a ranged offer). Fixed in round-2 so the cancel-side
refund mirrors the create-side pre-escrow. Same legacy-fallback
(`collateralAmountMax == 0 ⇒ collateralAmount`) applies to the
OfferMatchFacet excess-refund hook as well, so a hypothetical
post-deploy upgrade onto live storage with pre-#164 offers can't trap
their collateral on the first match.

**Lender side stays single-value** on collateral. The lender's
`collateralAmount` slot is their derived requirement (at `amountMax`,
pro-rated to the matched amount); a max wouldn't add operational
meaning. `createOffer` rejects a lender offer with
`collateralAmountMax > collateralAmount` via
`LenderCollateralRangeNotAllowed`, independent of the master flag.

**Borrower asset pre-escrow** now pulls `collateralAmountMax` (the
upper bound) at create-time instead of `collateralAmount`. The
existing OfferMatchFacet excess-refund hook returns the unused tail to
the borrower's wallet at match-time — same pattern the lender-side
amount range already uses for partial-fill leftovers. On a legacy
single-value borrower offer (auto-collapsed `collateralAmountMax ==
collateralAmount`), the pulled amount and the refund both land at the
same numbers as the pre-#164 implementation, byte-for-byte.

**Master kill-switch** — `rangeCollateralEnabled` on `ProtocolConfig`
defaults `false` on a fresh deploy. While off, `createOffer` enforces
the legacy single-value collateral shape (rejecting `collateralAmountMax
> collateralAmount` with the typed `FunctionDisabled(4)` so the
frontend validator can surface a precise "feature disabled" hint
distinct from the amount/rate flags). Governance flips it via
`ConfigFacet.setRangeCollateralEnabled(true)` after the testnet bake.

### Why now — sequencing for #102

[#102](https://github.com/vaipakam/vaipakam/issues/102) (borrower
partial-fill) lifts the Phase 1 single-fill rule and lets one borrower
offer back multiple loans. That work needs `collateralAmountFilled` to
exist as load-bearing storage from match #2 onwards. Landing the field
+ the storage layout NOW — even while no Phase 1 code reads it — keeps
#102 a pure behaviour change rather than a behaviour + storage change.
Same reason `amountFilled` shipped with Phase 1 even though Phase 1's
single-fill rule meant no one wrote to it on the borrower side either.

### What's intentionally NOT in this PR

| Slot | Why deferred |
|---|---|
| Borrower partial-fill enablement | #102 — lifts the single-fill rule and starts writing `collateralAmountFilled` |
| Frontend `CreateOffer` collateral-range input | #165 — basic/advanced mode parity (queued after #164) needs the same UI surface for all three fields together |
| Match-flow integration test for the clamp-up path | No existing test covers `previewMatch` / `matchOffers` directly; that's a parallel infra gap. This PR ships unit-level createOffer-side coverage; the match-time clamp is exercised end-to-end via the existing OfferFacet integration coverage once the kill-switch is on testnet. |

### Mainnet-deploy gate

The master flag stays `false` on testnet through the bake. When
governance flips `setRangeCollateralEnabled(true)`, the new mechanic
becomes reachable; until then every offer behaves exactly like the
pre-#164 contract.
