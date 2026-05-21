## Thread — Borrower partial-fill ends the Phase 1 single-fill rule (PR #<n>)

Closes #102. Lifts the borrower-side single-fill rule end-to-end so the
canonical limit-order semantic ADR-0010 locked in is honoured by the
contract, not just in the UI label.

Pre-#102, a borrower offer of "borrow $1k-$10k locking up to 2 ETH"
matched once at midpoint and immediately closed via
`B.accepted = true` — the unused range was destroyed. Post-#102, the
same offer is consumed progressively across multiple lender matches
until the remaining capacity falls below the borrower's per-match
minimum, at which point it auto-closes with the residual collateral
refunded to the borrower's wallet.

### Storage shape (no new fields — uses #164's append)

- `Offer.collateralAmountFilled` (slot 19, added by #164 for
  forward-compat) starts being WRITTEN per match. Pre-#102 it stayed
  at the storage default; post-#102 it accumulates symmetrically with
  the lender-side `amountFilled`.
- No new storage fields. No migration concerns.

### What changes (contract surface)

- `LibRiskMath.maxLendingForLtvCap(collateral, principal, collat, capBps)`
  — new helper, sibling of `minCollateralForLtvCap`. Takes the
  effective init-LTV cap explicitly. The GTC default's borrower
  `amountMax = 0 → derived` fallback (ADR-0010 §3) uses this helper.
- `LibOfferMatch.previewMatch` — uses `borrowerRemaining =
  effBorrowerAmountMax - B.amountFilled` symmetric to the lender side;
  applies the `0 ⇒ derived` fallback for borrower's `amountMax`
  using `maxLendingForLtvCap(collateralAmountMax, init-LTV cap)`.
- `OfferAcceptFacet._acceptOffer` — defers `offer.accepted = true`
  on the borrower side when (matchOffers-driven path + borrower offer
  + `partialFillEnabled` on). Single-match `acceptOffer`, lender
  offers, and partial-fill-off paths keep their immediate flip.
- `OfferMatchFacet.matchOffers` — symmetric borrower-side post-match
  accounting:
  - Increments `B.amountFilled` + `B.collateralAmountFilled` per
    match.
  - Auto-closes on dust (`remaining < B.amount`); refunds residual
    collateral; emits `OfferClosed(borrowerOfferId, Dust)`.
  - The per-match collateral refund hook (added in #164) is now
    gated on `!partialFillEnabled` — under partial-fill the
    borrower's pre-escrowed collateral stays in custody until
    dust-close.
- `OfferCreateFacet._emitOfferCreatedDetails` — applies the
  `0 ⇒ derived` collapse for borrower's `amountMax` so the event
  payload always carries the LOGICAL ceiling (ADR-0010 §3 mandate).
- `DeployDiamond.s.sol` — fresh deploys now flip the four GTC master
  flags ON post-init (`rangeAmountEnabled`, `rangeRateEnabled`,
  `rangeCollateralEnabled`, `partialFillEnabled`). Contract storage
  defaults stay `false` (audit-safe convention); the deploy script
  is the canonical enablement step. Operators that want a
  conservative bake on a brand-new chain can comment those four
  lines out and call the setters manually after a review window.

### Kill-switch decision — Option A (single flag, both sides)

`partialFillEnabled` now governs both sides symmetrically. There's no
scenario where one side's partial-fill should be enabled independent
of the other — splitting into per-role flags would have added
governance surface without operational benefit. (Confirmed in the
#102 design discussion against `borrowerPartialFillEnabled` as
Option B.)

### LIF pro-ration — non-issue

Each match against a single borrower offer mints a separate `Loan`
with its own `loanId` and its own `borrowerLifRebate[loanId].vpfiHeld`
slot. The per-loan accounting structure already handles N loans per
offer naturally — no cross-match LIF bookkeeping needed.

### Cancel-cooldown — already symmetric

`OfferCancelFacet.cancelOffer`'s cancel-cooldown
(`partialFillEnabled && amountFilled == 0 && createdAt + delay >
block.timestamp`) was already applied to both sides; it just becomes
load-bearing on the borrower side now that the matcher actually
reaches into borrower amounts more than once.

### Verification

- `forge build` clean (warnings only)
- `forge test --no-match-path "test/invariants/*"` → 2012 / 0 / 5
  (legacy paths preserved bit-for-bit)
- ABI re-export — no selector changes (per-function-body changes
  only); only `packages/contracts/src/abis/_source.json` stamp moves.
- Multi-package typechecks clean (apps/defi + indexer + keeper)

### Dedicated test coverage — separate follow-up

There is no existing test infrastructure for `OfferMatchFacet.matchOffers`
or `LibOfferMatch.previewMatch` (the five `InternalMatch*.t.sol` files
cover the internal-liquidation match, a different feature). The
legacy regression validates that `partialFillEnabled = false` keeps
existing behaviour exactly. The new partial-fill ON path is **not
exercised by the current suite**. Filed as
[#173](https://github.com/vaipakam/vaipakam/issues/173) — dedicated
test infrastructure for matchOffers + previewMatch + borrower
partial-fill paths.

### Downstream

- [#165](https://github.com/vaipakam/vaipakam/issues/165) — frontend
  GTC UI is unblocked; no "single-match" warning needed for borrower
  offers anymore.
- [#172](https://github.com/vaipakam/vaipakam/issues/172) —
  `apps/keeper` matcher pass updated to seek borrower partial-fill
  opportunities; `vaipakam-keeper-bot` public reference repo follows
  the same pattern.
