# ADR-0010: Canonical limit-order semantics for Offer min/max fields

**Status:** Accepted
**Date:** 2026-05-21

## Context

Range Orders Phase 1 (PR #46) introduced min/max range fields on the
`Offer` struct — `amount` + `amountMax`, `interestRateBps` +
`interestRateBpsMax`. Issue #164 (PR #167) extended the same shape to
the borrower-side collateral with `collateralAmount` + `collateralAmountMax`.
The contract's read/write layer expresses every field as a **floor +
ceiling** pair: the literal `amount` field is the floor, `amountMax` is
the ceiling, and the match path computes overlap as
`[max(L.amount, B.amount), min(L.amountMax-filled, B.amountMax)]`.

The **user-facing semantic varies by role** in a way the storage layout
doesn't make obvious:

- A lender thinks *"I'll lend up to X"* — their headline number is the
  ceiling.
- A borrower thinks *"I'll borrow at least Y"* — their headline number
  is the floor.
- A lender thinks *"I require at least Z collateral"* — their headline
  number is the floor.
- A borrower thinks *"I'll lock up to W collateral"* — their headline
  number is the ceiling.

Without an explicit mapping, every consumer (frontend, indexer,
keeper-bot, future SDK) has to re-derive which contract field carries
which user-meaning per role. The risk of drift is real and audit-
relevant — a frontend that flips the lender's "amount" semantic and
ships `amount = X` instead of `amountMax = X` would pre-escrow `1 wei`
instead of `X` and the lender would silently get matched at a tiny
size.

A secondary problem is **LTV input**. Earlier #163 design exploration
sketched two paths: (A) users pick LTV explicitly; (B) the protocol's
`loanInitMaxLtvBps` per-asset ceiling is the implicit cap and LTV is
derived from the user's amount/collateral inputs. The session that
produced this ADR landed firmly on (B): users never see LTV/HF as
inputs — only as derived risk indicators.

A third question is whether `loanInitMaxLtvBps` (the per-asset init-time
admission ceiling) should be **snapshotted on the Offer at create-time**
or **read live at match-time**. Today's contract reads it live. The
AutonomousLtvAndOracleFallback Phase 5 design explicitly wants this
value to track market evidence (peer-derived + bound-checked +
refreshable permissionlessly), so snapshotting would freeze offers
against the responsiveness the LTV system is designed for.

## Decision

We adopt **canonical limit-order semantics** at the frontend
translation layer, leaving the contract's storage layout unchanged.

### 1. Mapping table — user input → contract fields

| Field | Lender's UI input (GTC default) | Lender's contract write | Borrower's UI input (GTC default) | Borrower's contract write |
|---|---|---|---|---|
| **Lending amount** | "Lend up to **X**" | `amount = 1 wei`, `amountMax = X` (pre-escrows X) | "Borrow at least **Y**" | `amount = Y`, `amountMax = 0` (derived at match-time) |
| **Collateral amount** | "Require at least **Z**" | `collateralAmount = Z` (single-value per #164 lender invariant) | "Lock up to **W**" | `collateralAmount = 0 (or 1 wei)`, `collateralAmountMax = W` (pre-escrows W) |
| **Rate** | "At min **P%**" | `interestRateBps = P×100`, `interestRateBpsMax = 10_000` (= `MAX_INTEREST_BPS`, the protocol cap) | "At max **Q%**" | `interestRateBps = 0`, `interestRateBpsMax = Q×100` |

The pattern: **the side that pre-escrows the asset declares the ceiling
explicitly; the other side's ceiling is conceptually unbounded and
derived at match-time from the counterparty's offer + the protocol's
risk parameters**.

### 2. LTV and HF are derived guidance only — never user input

Users do not pick "LTV target" or "HF target" as form inputs. The
frontend computes LTV and HF live at each meaningful match point
(at `amount`, at `amountMax`, at the midpoint of the most-likely
counterparty overlap) and renders them as **color-coded risk
indicators inline**:

- Green: LTV ≤ 50%
- Yellow: 50% < LTV ≤ 65%
- Orange: 65% < LTV ≤ protocol max
- Red: above protocol max (would revert at `MaxLendingAboveCeiling` /
  `MinCollateralBelowFloor`)

The protocol's per-asset `loanInitMaxLtvBps` acts as a **safety upper
bound** that the contract enforces, NOT as a user-facing default
target. Users in advanced mode can override the inputs but never enter
LTV/HF directly.

### 3. Borrower's `amountMax` is single-value with match-time derivation

By symmetry with how #164 treats lender's `collateralAmount` (single
value; lender's effective collateral max = ∞, capped at match-time by
the borrower's `collateralAmountMax`), the borrower's `amountMax` field
follows the same pattern:

- **Borrower's GTC default ships `amountMax = 0`** (storage default;
  SSTORE skipped, mirroring the #169 `collateralAmountMax` optimisation).
- **Match-time read applies the fallback**:
  ```
  effBorrowerAmountMax = B.amountMax == 0
      ? (LibRiskMath.maxLendingForCollateral(effBorrowerCollMax(B),
                                             B.lendingAsset,
                                             B.collateralAsset)
         * effLoanInitMaxLtvBps(B.collateralAsset))
        / BASIS_POINTS
      : B.amountMax;
  ```
- Advanced-mode borrowers can ship an explicit tighter `amountMax`
  override; the contract honours it.
- `_emitOfferCreatedDetails` applies the same `0 ⇒ derived` collapse
  before emitting `OfferCreatedDetails`, so indexers see the LOGICAL
  ceiling, never the storage default. Same pattern as #169 used for
  `collateralAmountMax`.

This brings the four "axes × sides" storage into clean symmetry —
each side has ONE field carrying a literal ceiling (the pre-escrowed
one) and ONE field whose ceiling is derived at match-time:

| Side | Pre-escrowed (must store literally) | Guardrail (storage default `0`, derived at match) |
|---|---|---|
| Lender | `amountMax` (the principal pre-escrowed) | `collateralAmountMax` (= `collateralAmount`; lender single-value per #164) |
| Borrower | `collateralAmountMax` (the collateral pre-escrowed) | `amountMax` (derived from `collateralAmountMax × loanInitMaxLtvBps`) |

### 4. `loanInitMaxLtvBps` stays live-at-match (NOT snapshotted on Offer)

The per-asset `loanInitMaxLtvBps` is read **live at every consultation**
— both at `createOffer` (for the `MinCollateralBelowFloor` /
`MaxLendingAboveCeiling` create-time gates) and at match-time (for
`LoanFacet._checkInitialLtvAndHf` and the new borrower `amountMax`
derivation in §3 above). It is **not** snapshotted on the Offer
struct.

This is deliberately asymmetric with `liquidationLtvBpsAtInit`, which
IS snapshotted on `Loan` at `initiateLoan`. The asymmetry reflects the
two values' different roles:

- `liquidationLtvBpsAtInit` defines the **lifetime risk envelope of a
  loan**. Once a loan exists, this threshold is what determines
  whether the position is healthy, so it must be immutable for the
  loan's lifetime regardless of any governance / autonomous LTV
  refinement.
- `loanInitMaxLtvBps` is an **admission ceiling**. It gates whether a
  loan can be created from a given (offer, match) pair, but
  post-admission, the loan's identity is governed by the liquidation
  threshold instead. Snapshotting it on the Offer would freeze offers
  against the live peer-derived LTV refinements that the
  AutonomousLtvAndOracleFallback Phase 5 design explicitly wants
  offers to track.

Users can cancel an offer (subject to `MIN_OFFER_CANCEL_DELAY`
cooldown) if market conditions tighten between create and match. The
existing safety guard at `_checkInitialLtvAndHf` ensures a match
exceeding the CURRENT ceiling reverts cleanly at `LoanFacet.initiateLoan`.

### 5. The 1-wei placeholder on lender's `amount`

`OfferCreateFacet._createOfferSetup` enforces `params.amount > 0`.
Under the GTC mapping, lenders enter only their ceiling (`amountMax`)
and the floor is conceptually zero (any size up to the ceiling). To
satisfy the contract invariant, the frontend ships **`amount = 1 wei`**
on lender offers under the GTC default.

The match overlap math (`lo = max(L.amount, B.amount)`) collapses
`max(1, B.amount) = B.amount` for any practical borrower (whose floor
is many orders of magnitude above 1 wei), so the placeholder is
operationally equivalent to "no floor on the lender side". This is
documented here so a future auditor reading the contract data
(`amount = 1` on every lender offer) understands the intent rather
than reverse-engineering it.

A future cleanup (filed against the storage repack audit prep — see
[#20](https://github.com/vaipakam/vaipakam/issues/20)) MAY relax the
`amount > 0` invariant to `amount >= 0` and drop the 1-wei
placeholder. Not done here because it is audit-touching and the
placeholder costs effectively zero gas.

### 6. Borrower partial-fill (#102) is a load-bearing dependency

The canonical-limit-order semantics described in §1-§3 require
borrower offers to be **multi-fill** — a borrower posting *"borrow at
least Y, lock up to W"* expects MULTIPLE lender offers to be able to
fill that range progressively, the same way a borrower in a DEX
limit-order book has their order incrementally consumed.

Phase 1 single-fill rule (borrower offer becomes `accepted = true` on
the first match, destroying the unused range) makes the canonical
semantics **honest in the UI but dishonest in the contract**. Issue
[#102](https://github.com/vaipakam/vaipakam/issues/102) lifts this
rule. Until #102 lands, frontend implementations of the GTC UI MUST
either:

- Display a "single-match" warning prominently on borrower offers, OR
- Wait for #102 to merge before shipping the GTC UI.

This ADR records #102 as **the gating dependency for
[#165](https://github.com/vaipakam/vaipakam/issues/165)** (the frontend
GTC implementation). #102's design should also (i) extend
cancel-cooldown to borrower offers symmetrically, (ii) decide whether
to extend the existing `partialFillEnabled` master kill-switch flag
to cover both sides or split into per-role flags, and (iii) account
for the per-match LIF prepay pro-ration on the borrower side (the
existing `borrowerLifRebate[loanId].vpfiHeld` slot is per-loan; one
borrower offer minting N loans needs N slots).

## Consequences

### Positive

- **Single source of truth for user intent.** The frontend's
  translation layer is the canonical mapping; every consumer
  (indexer, keeper-bot, SDK) reads the contract's literal storage and
  applies the same fallback rules (`amountMax == 0 ⇒ derived`,
  `collateralAmountMax == 0 ⇒ collateralAmount`).
- **Symmetric storage shape.** Each side has one pre-escrowed field
  and one derived field. Audit clarity.
- **Offers stay responsive to autonomous LTV refinements.** Live
  `loanInitMaxLtvBps` means an offer aged across a governance /
  peer-derived LTV update tracks current safety conditions.
- **GTC behaviour matches DEX limit-order intuition** — lenders =
  ceiling, borrowers = floor. Reduces onboarding friction for users
  arriving from DEX surfaces (Uniswap / 1inch / Binance).
- **Smaller #165 frontend scope.** Both basic and advanced modes show
  one input per field per role; no min/max slider duplication. Mode
  toggle is risk-display only (basic hides live HF/LTV; advanced
  shows).
- **`initialLtvBps` storage slot not needed on Offer.** The earlier
  Interpretation B (snapshot user-chosen LTV on the Offer) is
  dissolved by the live-at-match decision; #102's design phase
  doesn't have to add a new field.

### Negative / accepted

- **The 1-wei placeholder on lender's `amount`** is a small abstraction
  leak. An auditor reading the contract data sees `amount = 1` on every
  lender offer and may be confused. Mitigated by NatSpec + this ADR.
  Future cleanup gated on the storage repack audit (#20).
- **Indexer / event-consumer migration.** Consumers of
  `OfferCreatedDetails` must understand that `amountMax == 0` on
  borrower offers means "derived" — though the event payload itself
  applies the collapse so this is transparent for the common case.
  Direct storage-readers (subgraphs, on-chain consumers) need to
  apply the same fallback.
- **Match-time gas cost for the borrower amountMax derivation.**
  Adding `maxLendingForCollateral` to the `previewMatch` hot path
  adds one oracle SLOAD + one Chainlink feed STATICCALL per call.
  The HF check downstream already invokes the oracle, so the
  marginal cost is bounded.
- **Borrower offer can be matched at a higher effective LTV than at
  create-time** if `loanInitMaxLtvBps` is RAISED between create and
  match. Accepted because (i) the raised ceiling reflects autonomous
  evidence that the asset is safer, and (ii) borrower can always
  cancel an offer if uncomfortable with the new ceiling.

### Defer-and-revisit

- **Snapshot `loanInitMaxLtvBps` on Offer with `MIN(snapshot, current)`
  safety rule.** Defensive against governance / autonomous LTV
  LOOSENING (the current decision accepts a slightly higher effective
  LTV in that case). Considered and rejected for now to preserve the
  AutonomousLtvAndOracleFallback design intent. Revisit if observed
  drift causes user complaints.
- **Relax `amount > 0` invariant.** Cleanup that drops the 1-wei
  placeholder; folds into the storage repack audit prep (#20).

## Alternatives considered

### A1. Snapshot `loanInitMaxLtvBps` on the Offer (Interpretation B from session)

Add `Offer.loanInitMaxLtvBpsAtCreate: uint16` (packed with `createdAt`
in slot 17's 24-byte headroom). Every match uses the snapshot value.

Rejected because:
- Conflicts with AutonomousLtvAndOracleFallback Phase 5's responsive-
  LTV design intent.
- Stale offers stay at old (looser or tighter) LTVs indefinitely —
  manual cancel-and-recreate required to refresh.
- A snapshot more PERMISSIVE than the current LTV is a safety risk
  (accepting loans at old higher LTV when market has tightened).
  Mitigation (`MIN(snapshot, current)`) adds complexity for marginal
  benefit.

If observed drift behaviour proves disruptive, this option can be
adopted in a follow-up ADR with the `MIN(snapshot, current)` safety
rule.

### A2. User picks LTV explicitly (Interpretation A from session)

Frontend asks user for "target LTV" as a slider; derives the
amount-or-collateral dependent field. Contract sees the resulting
literal values.

Rejected because:
- LTV is a derived concept users find confusing on first encounter
  ("what's a good LTV?"). Asking for it as input increases form
  friction without reducing risk.
- The user's actual primary intent is "I want to lend $X" or "I want
  to borrow $Y" — LTV is a consequence, not a goal.
- Risk-indicator visualisation (green/yellow/orange/red zones)
  surfaces the LTV information without making it an input.

### A3. Make lender's `collateralAmount` floor also derivable

Symmetric refinement to §3: lender ships `collateralAmount = 0` and
the match-time derives `effFloor = minCollateralForLending(amountMax)`
at protocol's max LTV.

Rejected because:
- The lender's collateral floor is the lender's RISK TOLERANCE
  declaration. A lender saying "I require at least 1 ETH" is an
  intentional over-requirement above the protocol minimum.
  Derivation would silently set the floor to the protocol's most-
  permissive setting, masking the lender's intent.
- Asymmetric with the pre-escrowed-field pattern: lenders express
  positive collateral demand (their floor); borrowers express
  positive collateral commitment (their ceiling). Both pre-escrow
  the field on their side that matters, and the "other" field is
  derived. The user-meaning split is intentional.

### A4. Reframe the contract field names

Rename `amount` → `amountFloor`, `amountMax` → `amountCeiling` (etc.)
to make the floor/ceiling semantics self-documenting.

Rejected because:
- Audit cost of a rename touching the storage layout exceeds the
  documentation benefit.
- This ADR + NatSpec comments achieve the same documentation goal at
  zero contract cost.
- Renaming would break every existing consumer (frontend, indexer,
  keeper-bot, SDK) — large blast radius for a cosmetic change.

## Cross-links

- [`docs/DesignsAndPlans/RangeOffersDesign.md`](../DesignsAndPlans/RangeOffersDesign.md)
  — adds a `§17` documenting the GTC default mapping in design-doc form,
  cross-referencing this ADR.
- [Issue #20](https://github.com/vaipakam/vaipakam/issues/20) — storage
  repack audit prep; the 1-wei placeholder + future relaxation belong
  in that arc.
- [Issue #102](https://github.com/vaipakam/vaipakam/issues/102) —
  borrower partial-fill; load-bearing dependency for #165 to ship the
  GTC UI honestly. #102's design phase implements §3 (borrower
  `amountMax` fallback + event-payload collapse) and §6 (cancel-
  cooldown extension + partial-fill kill-switch decision + LIF
  pro-ration).
- [Issue #163](https://github.com/vaipakam/vaipakam/issues/163) — the
  design-exploration card that this ADR closes. The card moves to
  Done when this ADR merges.
- [Issue #164](https://github.com/vaipakam/vaipakam/issues/164) — the
  borrower-side collateral range that this ADR builds on. PR #167
  added the `collateralAmount` + `collateralAmountMax` fields; this
  ADR maps the user input flow.
- [Issue #165](https://github.com/vaipakam/vaipakam/issues/165) —
  frontend GTC implementation; consumes this ADR's mapping table.
- [Issue #166](https://github.com/vaipakam/vaipakam/issues/166) —
  DEX/CEX conventions; this ADR's "lender = ceiling, borrower =
  floor" framing is the canonical Tier-A vocabulary borrow that #166
  catalogues.
- [PR #170](https://github.com/vaipakam/vaipakam/pull/170) — the
  SSTORE-skip pattern for `collateralAmountMax` that this ADR's §3
  extends to `amountMax`.

## Worked example (verification of the GTC mapping)

A lender creates a GTC offer: *"Lend up to $10,000 at min 4% APR;
require at least 1 ETH collateral."*

Frontend writes:
- `amount = 1 wei`
- `amountMax = 10_000 × 1e6` (USDC, 6-dec)
- `interestRateBps = 400` (4%)
- `interestRateBpsMax = 10_000` (100%, protocol cap)
- `collateralAmount = 1 ether` (single-value per #164 lender invariant)
- `collateralAmountMax = 0` (auto-collapse; SSTORE skipped per #169)

A borrower creates a GTC offer: *"Borrow at least $500 at max 8% APR;
lock up to 2 ETH collateral."*

Frontend writes:
- `amount = 500 × 1e6` (USDC)
- `amountMax = 0` (derived at match)
- `interestRateBps = 0`
- `interestRateBpsMax = 800` (8%)
- `collateralAmount = 0` (or 1 wei to satisfy invariants if any)
- `collateralAmountMax = 2 ether` (pre-escrowed)

Match-time computation:
- `effLenderAmountMax = 10_000` USDC
- `effBorrowerAmountMax = maxLendingForCollateral(2 ETH) × 7500 / 10_000`
  ≈ $3_750 (at $2,500/ETH × 75% LTV).
- Amount overlap: `[max(1, 500), min(10_000, 3_750)] = [500, 3_750]`.
  Match at midpoint = $2_125.
- Rate overlap: `[max(400, 0), min(10_000, 800)] = [400, 800]`. Match at
  midpoint = 600 bps (6%).
- `reqFromLender = 1 ETH × 2_125 / 10_000` ≈ 0.21 ETH.
- `picked = max(reqFromLender = 0.21, B.collateralAmount = 0)` = 0.21 ETH.
- Excess refund: `2 ETH - 0.21 ETH = 1.79 ETH` returned to borrower.

Loan minted with principal $2_125 at 6% APR, collateral 0.21 ETH locked.
Lender's `amountFilled = 2_125`; offer stays open with $7_875 remaining
(partial-fill enabled per `cfg.partialFillEnabled`). Borrower's offer
closes via the single-fill rule until #102 lands.

Post-#102, the borrower's `amountFilled = 2_125` and the offer stays
open with remaining capacity `[500 - 2_125, $3_750 - 2_125]` →
`max(0, -1625) = 0` floor exhausted → close via dust-close (matches
the existing lender-side pattern at `OfferMatchFacet.matchOffers`).
