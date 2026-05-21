## Thread — ADR-0010: Canonical limit-order semantics for Offer min/max fields (PR #<n>)

Closes #163. Records the decision around how the frontend maps user
intent into the contract's min/max range fields on the `Offer` struct
— what an implementer would otherwise have to reverse-engineer from
the contract code and the existing range-orders design doc.

### What this PR ships

- **`docs/adr/0010-canonical-rate-semantics.md`** — new ADR documenting:
  - The role-asymmetric mapping table (lender = ceiling, borrower =
    floor for their headline numbers; the other side of each pair is
    either pre-escrowed by the role that holds the asset or derived at
    match-time from the counterparty's offer).
  - LTV and HF are derived guidance only, never user input. Frontend
    renders color-coded risk indicators inline.
  - The borrower's `amountMax = 0` symmetry — single-value with
    match-time derivation from `collateralAmountMax × loanInitMaxLtvBps`,
    mirroring the lender-side collateral pattern that #164 already
    established. SSTORE skipped per the #169 optimisation pattern.
  - `loanInitMaxLtvBps` stays **live-at-match** (Option A from session
    discussion) rather than snapshotted on the Offer struct.
    Documented as asymmetric with `liquidationLtvBpsAtInit` (which IS
    snapshotted on `Loan`), with the rationale that init max LTV is
    an admission criterion that the AutonomousLtvAndOracleFallback
    Phase 5 design wants responsive, whereas the liquidation
    threshold is a lifetime risk envelope that must be immutable per
    loan.
  - The 1-wei placeholder on lender's `amount` — artifact of the
    contract's `params.amount > 0` invariant. Documented for auditor
    clarity; future cleanup gated on the storage repack audit (#20).
  - **Borrower partial-fill (#102) is the load-bearing dependency**
    for the frontend GTC implementation (#165). The mapping table
    only honours user intent in the contract if borrower offers can
    be incrementally consumed across multiple lender matches; #102
    lifts the Phase 1 single-fill rule. #165 cannot ship the GTC UI
    honestly until #102 lands.

- **`docs/DesignsAndPlans/RangeOffersDesign.md` §17** — design-doc
  companion section that an implementer reading the range-orders
  spec encounters first. Cross-references the ADR for the full
  rationale; surfaces the mapping table + the load-bearing
  invariants in the same document family as §16's borrower-side
  collateral range coverage.

- **`docs/adr/README.md`** — ADR index updated to include ADR-0010.

### Why this is documentation-only

The contract's storage layout doesn't change. The match math doesn't
change. No code is touched by this PR. The artefact is the **decision
lock** — once merged, every downstream implementation (#102 contract
work; #165 frontend GTC UI; future SDK / indexer migrations) references
ADR-0010 as the source of truth for what each field means at the user
layer.

### Why now (not later)

The user-facing semantic is currently implicit. PRs #167 (#164) and
#170 (#169) both made design choices (pre-escrow shapes, SSTORE-skip
patterns, indexer-friendly event payloads) that depend on a clear
mapping between user intent and contract storage. Locking that mapping
in an ADR now means #102 and #165 don't re-litigate it during
implementation. Without this artefact, the next implementer would
reverse-engineer the same decisions from `OfferCreateFacet` / `LibOfferMatch`
/ `OfferCancelFacet` reading patterns, which is exactly the
git-archaeology cost ADRs exist to eliminate (per `docs/adr/README.md`'s
"Why these exist" section).

### What this PR does NOT do

- Does not implement borrower partial-fill — that's #102, the
  load-bearing contract dependency this ADR makes explicit.
- Does not ship any frontend changes — that's #165, depending on #102.
- Does not introduce any contract storage migration. ADR-0010
  specifically rejects (Alternative A1) the option of snapshotting
  `loanInitMaxLtvBps` on the Offer struct.
- Does not relax the `amount > 0` contract invariant or remove the
  1-wei placeholder — deferred to the storage repack audit (#20).

### Round-1 Codex corrections (folded in before merge)

Codex round-1 surfaced three P2s in the first draft of ADR-0010 — all
real, all corrected in the same PR:

1. **Double-LTV-cap in the borrower `amountMax` derivation** —
   `maxLendingForCollateral` already incorporates an LTV cap
   internally; the original pseudocode multiplied by
   `loanInitMaxLtvBps / BASIS_POINTS` again. Corrected to reference a
   new `LibRiskMath.maxLendingForLtvCap(cap)` helper (a sibling of
   the existing `minCollateralForLtvCap`) that #102 will add — single
   cap applied inside the helper.
2. **Tier-capped vs. init-only LTV** — `LibRiskMath.maxLendingForCollateral`
   uses tier LIQUIDATION LTV (post-creation safety threshold), not the
   init-LTV cap admission consults (`min(loanInitMaxLtvBps, tierCap)`).
   Reusing it would advertise borrower capacity above what admission
   allows. ADR now specifies the new `maxLendingForLtvCap` helper +
   the cap derivation pattern that mirrors `previewMatch`'s existing
   synthetic-init-gate block.
3. **Worked example dust-close math** — the example incorrectly said
   the borrower's offer "stays open" then "closes via dust-close"
   after the same fill. Corrected: at first fill, remaining `1_625 >
   floor 500` → STAYS OPEN; a hypothetical second fill that drains
   remaining below `500` would trigger dust-close per the symmetric
   extension of the lender-side pattern.
