# Canonical Limit-Order — Phase 2 Design

**Status**: Draft, awaiting ratification.
**Tracking card**: [#183](https://github.com/vaipakam/vaipakam/issues/183).
**Closes / resolves**: the `_acceptOffer` direct-accept deferral from PR
[#175](https://github.com/vaipakam/vaipakam/pull/175) (Codex P1×5 round-1
finding), the `test_borrowerAmountMaxZeroDerivation` SKIP from
[#173](https://github.com/vaipakam/vaipakam/issues/173) (becomes a
permanent skip under this design, with the dead derivation removed),
and the implicit "what is the canonical limit-order shape" question
that ADR-0010 §17.1 left open.

---

## 1. Context & motivation

### 1.1 Where Phase 1 left us

The canonical limit-order arc started with
[ADR-0010](../adr/0010-canonical-rate-semantics.md): lender headlines
are *ceilings* (max provide), borrower headlines are *floors* (min
need). PR #175 attempted to apply that mapping at the frontend by
shipping `amount = 1 wei + amountMax = X` for lenders and `amount = Y
+ amountMax = 0` for borrowers.

Codex's round-1 P1 caught that the legacy direct-accept entry
`OfferAcceptFacet.acceptOffer(offerId, consent)` reads `offer.amount`
to determine the principal transfer. A lender offer with `amount = 1
wei` would route through direct-accept transferring **1 wei of
principal** but still pulling the borrower's full collateral —
catastrophic. PR #175 reverted to single-value payloads (`amount =
amountMax`) with role-asymmetric labels but symmetric data. The
canonical mapping was deferred to "Phase 2", which is this doc.

### 1.2 What this design unblocks

- The borrower `amountMax = 0` derivation in
  `LibOfferMatch._effBorrowerAmountMax` is currently dead code
  through the public `createOffer` interface (auto-collapse rewrites
  `params.amountMax = 0 → params.amount` before SSTORE). This design
  **deletes** the derivation rather than unblocking it — see §5.
- The `test_borrowerAmountMaxZeroDerivation` SKIP in
  `BorrowerPartialFillTest.t.sol` becomes a **permanent skip**, with
  its docstring updated to reflect "design decision: derivation path
  rejected".
- Frontend `CreateOffer.tsx` stops the PR #175 fallback (`amount =
  amountMax` everywhere) and ships **canonical role-asymmetric
  values** as Phase 1 originally intended — but with a different
  contract-side mechanism (role-aware `_acceptOffer` reads) so the
  Codex P1 vector stays sealed.

### 1.3 Relationship to ADR-0010

This design **implements** ADR-0010 §17.1's intent (lender headline =
ceiling, borrower headline = floor) without using ADR-0010's specific
storage encoding (`amount = 1 wei` etc.). The §17.1 split-mapping is
*one* way to express the canonical limit-order shape; this design is
another that's safer for direct-accept.

ADR-0010 §17.1 should be flagged as "superseded by Phase 2 design"
once this lands.

---

## 2. The write-side model

### 2.1 Frontend single-input-per-role mapping

Frontend `CreateOffer.tsx` shows **one input per dimension per role**.
No Basic/Advanced toggle on the range axis; no min/max display side
by side. The single input maps to different storage fields per role,
encoded by the frontend:

| Role | User-facing input | Maps to storage |
|---|---|---|
| Lender | `lendingAmount` ("I'll lend up to X") | `amountMax = X` |
| Lender | `collateralAmount` ("collateral I require") | `collateralAmount = collateralAmountMax = X` (lender single-value on collateral) |
| Lender | `interestRate` ("I want at least Y%") | `interestRateBps = Y` (lender's floor / limit) |
| Lender | optional `minPartialFillAmount` ("each match must be ≥ Z") | `amount = Z` |
| Borrower | `lendingAmount` ("I need at least X") | `amount = X` |
| Borrower | `collateralAmount` ("max collateral I'll commit") | `collateralAmountMax = X` |
| Borrower | `interestRate` ("I'll pay up to Y%") | `interestRateBpsMax = Y` (borrower's ceiling / limit) |

The OTHER storage fields are **derived** by the frontend before
submission (see §2.4) so the contract receives explicit, non-zero
values for every field.

### 2.2 Storage layout per role (locked)

Every offer in storage carries these fields with role-specific
meaning under the canonical mapping:

| Storage field | Lender offer | Borrower offer |
|---|---|---|
| `amount` | `minPartialFillAmount` (= 10% of `amountMax` default) | user's `lendingAmount` (min need) |
| `amountMax` | user's `lendingAmount` (max provide) | derived (`collateralAmountMax × tier-LTV-cap`) |
| `interestRateBps` | user's rate input (lender's floor = limit) | `1` (~0% — near-zero floor, no lower limit) |
| `interestRateBpsMax` | `MAX_INTEREST_BPS` (no upper limit) | user's rate input (borrower's ceiling = limit) |
| `collateralAmount` | user's `collateralAmount` (required, single-value) | derived (`amount / tier-LTV-cap`, the floor commit) |
| `collateralAmountMax` | same as `collateralAmount` (single-value on lender side) | user's `collateralAmount` (max commit) |
| `amountFilled` | 0 initially | 0 initially |
| `collateralAmountFilled` | 0 initially | 0 initially |

**Invariants enforced at create time**:
- `amount > 0`
- `amountMax >= amount`
- `interestRateBpsMax >= interestRateBps`
- `interestRateBpsMax <= MAX_INTEREST_BPS`
- `collateralAmount > 0`
- `collateralAmountMax >= collateralAmount`

The `> 0` invariant is **strict**: any offer shipping a zero in
`amount`, `amountMax`, `collateralAmount`, or `collateralAmountMax`
reverts at create time (no auto-collapse). See §2.6.

### 2.3 `minPartialFillAmount` default

The lender's `amount` field has dual meaning post-Phase 2:
- It's the **per-match minimum** the lender will accept (matchOffers
  dust-close fires when `lenderRemaining < amount`).
- It's the **smallest fill granularity** the lender exposes.

Default: `amount = max(1, amountMax × 10 / 100)`, i.e., 10% of the
lender's max — rounded down, with a minimum of 1 wei so the
`amount > 0` invariant always holds.

Lenders who want a different fill granularity (e.g., $1k matches on a
$10k offer = 10% default, or $5k matches = 50%) can specify it
explicitly. Borrowers don't have a separate `minPartialFillAmount`
field — their `amount` (their min lending need) plays the same role
in dust-close math.

**Rationale for 10%**:
- Conservative default — prevents dust-spam matches.
- Easy mental model: "you'll see at most 10 partial fills before the
  offer is fully consumed."
- The lender can always override (set higher to require chunkier
  matches, lower to allow finer-grained matches).

### 2.4 Frontend-side derivations

The frontend computes the implicit storage fields client-side using
the connected wallet's read-access to:
- Asset oracle prices (via `OracleFacet.getAssetPrice`).
- Tier-LTV caps (via `OracleFacet.getEffectiveLiquidityTier` +
  `LibVaipakam.tierLtvLibraryDefaultBps` constants).

#### Lender derivations

The lender side carries minimal derivations:

- `amount = max(1, user.amountMax × 10 / 100)` — the
  `minPartialFillAmount` default. If the user explicitly sets one,
  use that instead.
- `collateralAmountMax = collateralAmount` — lender's collateral is
  single-value by design (see issue [#164](https://github.com/vaipakam/vaipakam/issues/164) — "Lender side stays single-value because the lender's `collateralAmount` slot already represents their derived requirement").
- `interestRateBpsMax = MAX_INTEREST_BPS` — lender accepts any rate
  at or above their floor.

#### Borrower derivations

The borrower side carries more substantive derivations:

```
tier             = readOnChain(getEffectiveLiquidityTier(collateralAsset))
ltvCap           = tierLtvLibraryDefaultBps(tier)
collateralUSD    = collateralAmountMax × oracle(collateralAsset)
maxLendingUSD    = collateralUSD × ltvCap / BASIS_POINTS
amountMax        = maxLendingUSD / oracle(lendingAsset)
collateralAmount = max(1, ⌈amount × oracle(lendingAsset) / oracle(collateralAsset) / ltvCap⌉)
                   // The collateral floor that backs the borrower's minimum loan.
interestRateBps  = 1
```

The derivation runs at the moment the borrower submits the offer.
Stored values are **explicit and non-zero**. matchOffers and
`_acceptOffer` read storage values directly; no on-chain derivation
happens at match time.

#### Stale-oracle late-binding safety

The derived values are based on the oracle at the moment of offer
creation. If the oracle moves later, the stored values can become
stale:
- If `oracle(collateralAsset)` drops, the borrower's `amountMax` is
  now too aggressive (claims more loan than current collateral
  supports). The `LoanFacet._checkInitialLtvAndHf` check at the
  match path will **reject** the match — soft failure, offer goes
  un-matcheable until oracle recovers or the borrower amends.
- No value is lost; the worst case is offers sit idle.

This is the architecturally-clean trade-off vs on-chain derivation:
the contract becomes simpler (storage holds explicit values, no
derivation logic at match time), the operator (borrower) accepts that
their offer can become stale.

### 2.5 Invariant: `amountMax >= amount > 0`

Enforced at `OfferCreateFacet._writeOfferPrincipalFields` /
`_writeOfferCollateralFields`. New typed reverts:

```solidity
error AmountMustBePositive();
error AmountMaxBelowAmount(uint256 amount, uint256 amountMax);
error InterestRateMaxBelowMin(uint256 rateBps, uint256 rateMaxBps);
error InterestRateAboveCeiling(uint256 rateMaxBps, uint256 ceiling);
error CollateralMustBePositive();
error CollateralAmountMaxBelowCollateral(uint256 collateralAmount, uint256 collateralAmountMax);
```

These replace the existing `InvalidAmountRange` / `InvalidRateRange`
where appropriate. The new errors carry the offending values for
debuggability.

### 2.6 Drop auto-collapse in OfferCreateFacet

The lines around `_writeOfferPrincipalFields:~1000` that today
auto-collapse `params.amountMax == 0 → params.amount` (and the
parallel rate + collateral auto-collapses) are **deleted**. Callers
shipping zero in any *Max field get an immediate `*MustBePositive`
revert.

Same for `_writeOfferCollateralFields` (the `collateralAmountMax`
auto-collapse).

**Why drop instead of keep-as-fallback**:
- The auto-collapse was a Phase 0 / legacy-compat artifact. With the
  canonical frontend always shipping explicit values, it never fires
  for canonical callers.
- Keeping it means non-canonical callers (scripts, third-party
  integrations) silently get the wrong shape (single-value when
  they meant a range). Failing loud is safer.
- Removing it lets us delete the `_effBorrowerAmountMax` derivation
  (see §5) — the derivation only exists because storage might hold
  `0` and need to be derived; under the new model storage always
  holds explicit values.

---

## 3. Direct-accept semantics (role-aware `_acceptOffer`)

The breaking change from Phase 1: `_acceptOffer` reads **different
fields per role** to determine the loan terms.

### 3.1 Amount: maker-favoring

Direct-accept locks the loan at the offer creator's headline (the
field representing what they explicitly posted):

| Acceptor side | Reads | Loan principal locks at |
|---|---|---|
| Borrower accepts lender offer | `offer.amountMax` | Lender's max provide (e.g., `$10k`) |
| Lender accepts borrower offer | `offer.amount` | Borrower's min need (e.g., `$1k`) |

Rationale: the maker (offer creator) posted "this is what I want";
direct-accept fulfils that exact headline. Partial fills go through
matchOffers, not direct-accept.

### 3.2 Rate: taker-favoring (limit-order DEX standard)

Direct-accept locks the rate at the offer creator's **limit** — the
worst rate they'll accept, which is the taker's best rate:

| Acceptor side | Reads | Loan rate locks at |
|---|---|---|
| Borrower accepts lender offer | `offer.interestRateBps` | Lender's floor (lowest rate they accept) |
| Lender accepts borrower offer | `offer.interestRateBpsMax` | Borrower's ceiling (highest rate they pay) |

Rationale: standard DEX limit-order semantic. Maker posts a limit
("at least Y%" for lender, "at most Y%" for borrower); taker takes
at the limit. The taker's incentive to hit a resting offer is they
get a rate strictly inside the maker's acceptance range. This
asymmetry from §3.1's maker-favoring amount rule is intentional and
matches every limit-order DEX/CEX.

### 3.3 Collateral: per-role

| Acceptor side | Reads | Collateral locked |
|---|---|---|
| Borrower accepts lender offer | `offer.collateralAmount` | Lender's single-value required collateral |
| Lender accepts borrower offer | `offer.collateralAmount` (the derived floor) | The borrower's pre-escrowed floor (matches the `amount` principal) |

Note both reads use `collateralAmount`, not `collateralAmountMax`.
For the lender path that's the lender's single value. For the
borrower path that's the derived floor matching the borrower's `amount`.

### 3.4 `acceptOfferWithPermit` inheritance

`acceptOfferWithPermit` (Permit2 variant) calls the same `_acceptOffer`
plumbing — it inherits the role-aware reads automatically. No new
selector. No new ABI surface. Range offers usable with Permit2 from
day 1.

### 3.5 Worked example

**Lender posts**: rate 7%, lendingAmount $10k, collateral 8 ETH required.

Storage:
- `amount = $1k` (10% default of $10k)
- `amountMax = $10k`
- `interestRateBps = 700` (lender's floor / limit)
- `interestRateBpsMax = MAX_INTEREST_BPS` (no upper limit)
- `collateralAmount = 8 ETH`
- `collateralAmountMax = 8 ETH`

**Borrower direct-accepts the lender offer**:
- Reads `amountMax = $10k` → transfers $10k principal to borrower
- Reads `interestRateBps = 7%` → loan locks at 7% (the lender's floor, the borrower's best case)
- Reads `collateralAmount = 8 ETH` → borrower locks 8 ETH collateral
- One-click "Accept full" UX. ✓

**Borrower posts**: rate 5%, lendingAmount $1k min, collateral 5 ETH max.

Storage (with derivation):
- `amount = $1k`
- `amountMax = $2.5k` (derived: 5 ETH × $500 × 50% LTV / $1 = $1250, then adjusted per tier; numbers illustrative)
- `interestRateBps = 1` (~0% — near-zero floor)
- `interestRateBpsMax = 500` (borrower's ceiling / limit)
- `collateralAmount = ~2 ETH` (derived)
- `collateralAmountMax = 5 ETH`

**Lender direct-accepts the borrower offer**:
- Reads `amount = $1k` → lender extends $1k principal
- Reads `interestRateBpsMax = 5%` → loan locks at 5% (the borrower's ceiling, the lender's best case)
- Reads `collateralAmount = ~2 ETH` → ~2 ETH backs the loan, remaining 3 ETH stays in borrower escrow (refunded on dust-close at the borrower offer's terminal)

---

## 4. MatchOffers semantics (largely unchanged)

`OfferMatchFacet.matchOffers` continues to operate on the **range
intersection** between a lender's `[amount, amountMax]` and a
borrower's `[amount, amountMax]`, with `[interestRateBps,
interestRateBpsMax]` overlap for rate.

### 4.1 Midpoint rate discovery

When matchOffers finds rate-range overlap, it picks the **midpoint**
of the intersection — neither maker-favoring nor taker-favoring;
it's a price-discovery convention. Existing implementation in
`LibOfferMatch.previewMatch` is unchanged.

Example: lender [5%, MAX_BPS], borrower [1, 7%]:
- Overlap = [5%, 7%]
- Midpoint = 6%
- Match rate = 6%

### 4.2 Range overlap with the new storage layout

Under the canonical mapping:
- Lender's `[interestRateBps, MAX_BPS]` = "5% or higher"
- Borrower's `[1, interestRateBpsMax]` = "up to 7%"
- Overlap = `[max(5%, 1), min(MAX_BPS, 7%)] = [5%, 7%]`

This works naturally — the "no limit on the other side" sentinels
(`MAX_BPS` for lender ceiling, `1` for borrower floor) participate
in the standard intersection math without special casing.

### 4.3 `minPartialFillAmount` as dust-close floor

Dust-close already fires when the offer's remaining capacity drops
below its `amount` floor. Under the canonical mapping `amount` on a
lender offer IS `minPartialFillAmount`, so the dust-close mechanism
operates exactly as intended — the lender gets dust-refunded when
the residual can't satisfy another partial fill.

Borrower side dust-close uses `amount` (the borrower's min need) as
the floor — same as today. Symmetric.

---

## 5. The dropped derivation

### 5.1 Delete `_effBorrowerAmountMax` + tests

`LibOfferMatch._effBorrowerAmountMax` is deleted. The function exists
specifically to derive `B.amountMax` when storage holds `0` (the GTC
sentinel). Under the new invariant `amountMax > 0`, storage NEVER
holds `0`, so the derivation can never fire.

Sites that called `_effBorrowerAmountMax` are updated to read
`B.amountMax` directly:

```solidity
// Before (LibOfferMatch.previewMatch ~ line 280):
uint256 effBorrowerAmountMax = _effBorrowerAmountMax(s, B);

// After:
uint256 effBorrowerAmountMax = B.amountMax;
```

Same simplification in `OfferMatchFacet.matchOffers` post-block.

The `if (effBorrowerAmountMax == 0)` branches go away — they can
never fire under the new invariant.

### 5.2 Why this is permanent

The derivation path was forward-looking code from #102's borrower
partial-fill work, anticipating a GTC mode where storage holds 0
and the contract derives at match time. Phase 2 chose the alternate
path: storage always explicit, derivations live in the frontend.

The trade-offs:
- **Storage-holds-zero derivation** (deleted): smaller storage,
  always-current derivation, requires every consumer to handle the
  zero sentinel.
- **Frontend-derived explicit storage** (chosen): bigger storage,
  potentially stale derivation, every consumer reads storage
  directly without special casing.

Phase 2's choice was driven by:
1. Smaller contract surface (less code to audit).
2. Cleaner storage (no zero sentinels to special-case).
3. Late-binding safety net at match time (HF/LTV recheck catches
   stale derivations as soft failures).
4. Direct-accept semantics work naturally with explicit storage.

### 5.3 `test_borrowerAmountMaxZeroDerivation` SKIP update

The SKIP in
`contracts/test/BorrowerPartialFillTest.t.sol` was previously
documented as "Phase 2 prereq — unblock after auto-collapse is dropped
and storage holds the canonical sentinel." Under Phase 2's design,
that's wrong: the derivation path is being **deleted, not unblocked**.

The SKIP's docstring updates to:

> Permanent skip. Phase 2 (issue #183, Canonical Limit-Order Design)
> deleted `LibOfferMatch._effBorrowerAmountMax`. The borrower
> `amountMax = 0` derivation path is no longer reachable through any
> entry point — `createOffer` enforces `amountMax > 0` (no
> auto-collapse), so storage can never hold the GTC sentinel. The
> test stays as a future-proofing assertion that the path remains
> deleted; if a future PR re-adds derivation, this test should be
> updated to assert the new path's behavior.

The test body becomes a `vm.skip(true, "...")` with the updated reason
string. No code execution.

---

## 6. Display side (extends existing OfferBook)

### 6.1 What stays unchanged

The existing `OfferBook.tsx` already implements the DEX-style
two-sided layout we want:

| Existing feature | Stays |
|---|---|
| 3-tab view: `both` / `lender` / `borrower` | ✓ |
| Anchor-rate ranking (most economically relevant first) | ✓ |
| Sort: lender DESC / borrower ASC → anchor-in-middle | ✓ |
| Asset / collateral / duration filters | ✓ |
| Per-side caps (50 in `both`, 100 in single) | ✓ |
| Accept flow (the modal + simulation preview) | ✓ — but the contract reads change to role-aware |
| Permit2 path detection | ✓ |

### 6.2 Column updates (lender side)

| Column | Before | After |
|---|---|---|
| ID | offer ID | unchanged |
| Type | "Lender" / "Borrower" badge | unchanged |
| Asset | lending asset (with logo) | unchanged |
| Principal | reads `offer.amount` | **read `offer.amountMax`** (max provide; direct-accept locks here) |
| Rate | reads `offer.interestRateBps` | reads `offer.interestRateBps` (now formally the floor / limit — same field, clearer semantic) |
| **NEW: Depth at this rate** | — | Cumulative `amountMax` across all lender offers at this rate or lower (better-for-borrower-or-equal) |
| Duration | reads `offer.durationDays` | unchanged |
| Collateral | reads `offer.collateralAmount` | unchanged (lender single-value) |
| Liquidity | liquid / illiquid badge | unchanged |
| Action | "Accept" | unchanged surface; role-aware reads in `_acceptOffer` |

Min Partial Amount is **NOT** shown in the row — it's surfaced in
OfferDetails (§6.4).

### 6.3 Column updates (borrower side)

| Column | Before | After |
|---|---|---|
| ID | offer ID | unchanged |
| Type | badge | unchanged |
| Asset | lending asset | unchanged |
| Principal | reads `offer.amount` | shows `offer.amount` (min need) **and the derived `amountMax` as a sub-display**: `"$1k–$2.5k"` |
| Rate | reads `offer.interestRateBps` | reads `offer.interestRateBpsMax` (now formally the ceiling / limit — semantic swap per role) |
| **NEW: Depth at this rate** | — | Cumulative `amount` across all borrower offers at this rate or higher (better-for-lender-or-equal) |
| Duration | unchanged | unchanged |
| Collateral | reads `offer.collateralAmount` | **Split into two values**: `"Committed: <collateralAmount>  ·  Available: <collateralAmountMax>"` |
| Liquidity | badge | unchanged |
| Action | "Accept" | unchanged surface; role-aware reads |

### 6.4 OfferDetails (deep-dive page)

Surface additional context not in the row:

- **Min Partial Fill** (`offer.amount` for lender offers; same field is the borrower's min need)
- **The other rate-slot value** (e.g., for a lender offer, show
  "Lender's upper bound: 100% (no upper limit)" so power users
  reading the page understand the implicit range)
- **Filled-to-date** (`amountFilled`, `collateralAmountFilled`) for
  partially-matched offers
- **Implicit derivations** (for borrower offers, show "Derived max
  based on collateral × tier-LTV: $2.5k (at oracle snapshot
  block #N)")
- **Tier-LTV applicable** to the collateral asset
- **Creator address / ENS** (already there; sharpen labeling)
- **"Accept" CTA** with explicit terms: "You will receive $10,000 at
  7% APR for 30 days, locking 8 ETH collateral."

### 6.5 Depth chart visualization — follow-up card

A small cumulative-depth chart (rate on Y-axis, cumulative amount on
X-axis) above the order book is the natural Phase 2.5 enhancement.
Out of scope here — file as a separate card after Phase 2 lands.

---

## 7. Migration & ABI

### 7.1 Prelive — fresh testnet redeploy

The platform is prelive. Existing testnet offer storage (where
`amount = amountMax` under Phase 1's revert) is discarded by a fresh
contract redeploy. No legacy storage migration path needed.

### 7.2 ABI export targets

Phase 2 changes propagate to:

- `OfferCreateFacet` — new typed reverts (`AmountMustBePositive`,
  `AmountMaxBelowAmount`, etc.) appear in the ABI.
- `OfferAcceptFacet` — function signatures unchanged; only internal
  reads change (no ABI delta).
- `LibOfferMatch` — internal library; no ABI surface.
- Frontend `packages/contracts/src/abis/index.ts` — regenerate via
  `bash contracts/script/exportFrontendAbis.sh`.

The shared keeper-bot at `vaipakam-keeper-bot` reads `previewMatch`
+ `matchOffers` — selectors unchanged, no sync PR needed (but the
new revert types should be added to the bot's error-decoder if any
caller-side error handling exists).

### 7.3 No legacy storage migration path

Confirmed with operator (session 2026-05-21): prelive → fresh
redeploy. The migration concern from earlier design discussion (any
scripts shipping `amount < amountMax` historically) is resolved by
re-running scripts post-redeploy against the new invariants.

---

## 8. Implementation plan

### 8.1 Contracts

Files to change:

| File | Change | Estimated LOC |
|---|---|---|
| `contracts/src/facets/OfferCreateFacet.sol` | Drop auto-collapse; add invariant reverts; add typed errors | ~60 (delete ~40, add ~100) |
| `contracts/src/facets/OfferAcceptFacet.sol` | Role-aware reads in `_acceptOffer`: `amountMax` for lender / `amount` for borrower; `interestRateBps` for lender / `interestRateBpsMax` for borrower | ~30 (delete ~5, add ~35) |
| `contracts/src/libraries/LibOfferMatch.sol` | Delete `_effBorrowerAmountMax` + all call sites; simplify previewMatch | ~80 (delete ~60, add ~20) |
| `contracts/src/facets/OfferMatchFacet.sol` | Delete the post-match block's derivation branch; simplify | ~50 (delete ~30, add ~20) |

Total contract diff: ~220 LOC net.

### 8.2 Tests

Files to change:

| File | Change |
|---|---|
| `contracts/test/BorrowerPartialFillTest.t.sol` | Update `test_borrowerAmountMaxZeroDerivation` SKIP docstring (§5.3); update test data to use canonical role-aware storage (lender `amount = minPartialFill`, `amountMax = lendingAmount`, etc.) |
| `contracts/test/OfferFacetTest.t.sol` | Update create-offer happy paths; add tests for the new invariant reverts |
| `contracts/test/MatchOffersScaffoldTest.t.sol` | Update smoke tests to use canonical storage |
| `contracts/test/RoleAwareAcceptOfferTest.t.sol` (new) | Comprehensive coverage of the role-aware reads: lender direct-accept, borrower direct-accept, Permit2 variant inherits |
| `contracts/test/CreateOfferInvariantsTest.t.sol` (new) | Each new typed revert exercised at its boundary |

### 8.3 Frontend

Files to change:

| File | Change |
|---|---|
| `apps/defi/src/lib/offerSchema.ts` | Stop the PR #175 fallback (`amount = amountMax`); ship canonical role-asymmetric values; compute derivations client-side |
| `apps/defi/src/pages/CreateOffer.tsx` | Drop the Basic/Advanced range toggle; single-field inputs per role; show derived values as info-text alongside the user input |
| `apps/defi/src/pages/OfferBook.tsx` | Column updates per §6.2 / §6.3; new cumulative-depth column; role-aware field reads |
| `apps/defi/src/pages/OfferDetails.tsx` | Additional fields per §6.4 |
| `apps/defi/src/i18n/locales/*.json` (10 locales) | New column headers; new copy for canonical mapping; updated accept-CTA labels |

### 8.4 i18n updates

Affected keys (rough sketch):

```
offerTable.colDepth                = "Depth"
offerTable.colDepthHint            = "Cumulative size at this rate or better"
offerTable.colCollateralCommitted  = "Committed"
offerTable.colCollateralAvailable  = "Available"
offerDetails.minPartialFill        = "Minimum partial fill"
offerDetails.derivedMaxBasis       = "Derived from collateral × tier-LTV"
createOffer.lender.lendingAmount   = "Max amount you'll lend"
createOffer.borrower.lendingAmount = "Min amount you need"
createOffer.lender.rate            = "Minimum rate you'll accept"
createOffer.borrower.rate          = "Maximum rate you'll pay"
```

All 10 locales updated in lockstep.

---

## 9. Risk register

### 9.1 Stale-oracle on stored derivations

**Risk**: a borrower posts an offer; oracle moves; the stored
`amountMax` (derived at create time) is now too aggressive relative
to current collateral value.

**Mitigation**: `LoanFacet._checkInitialLtvAndHf` at match time uses
current oracle. A stale offer fails the HF/LTV check at match → no
loan initiated, no value at risk. Offer sits un-matcheable until
oracle recovers or borrower amends. Soft failure mode.

**Severity**: Low. No value at risk; UX friction only.

### 9.2 Direct-contract callers bypassing frontend invariants

**Risk**: a script or third-party integration calls `createOffer`
directly with a non-canonical shape (e.g., lender shipping `amount =
$5k` and `amountMax = $5k` for a "true single-fill" lender) that
doesn't match the canonical role-asymmetric layout.

**Mitigation**: this is supported by design (see §2.1's "frontend is
opinionated, contract is general"). A power-user / script setting
`amount = amountMax` ends up with a single-fill offer (no partial
fills possible because dust-close fires immediately). matchOffers
behaves correctly; direct-accept behaves correctly. The cost is the
offer can't partial-fill — that's the caller's intentional choice.

**Severity**: None. Working as designed.

### 9.3 Lender's `amountMax` equals `minPartialFillAmount`

**Risk**: a lender posts `lendingAmount = $1k` and the default
`minPartialFillAmount = 10% = $100`. Wait — that's NOT equal. The
edge case is when a lender posts `lendingAmount = small (~$10)` such
that the 10% rule yields a sub-wei value.

**Mitigation**: the frontend computes `amount = max(1,
amountMax × 10 / 100)`. The `max(1, ...)` ensures `amount > 0`
always. For very small offers (e.g., $1 lendingAmount), `amount = 1
wei`, which makes the offer single-fill effectively (any match
consumes nearly the whole offer at the lender's floor rate).

**Severity**: None. Working as designed.

### 9.4 Sepolia / testnet rehearsal scripts

**Risk**: rehearsal scripts (`SepoliaActiveLoan.s.sol`,
`SepoliaOpenOffers.s.sol`, etc.) may ship `amountMax = 0` or `amount
= amountMax` from Phase 1. Under Phase 2 they revert with the new
typed errors.

**Mitigation**: audit the rehearsal scripts in the implementation
PR; update them to ship canonical role-aware values matching the new
contract invariants. Small fixed set.

**Severity**: Low. Caught at testnet rehearsal, before mainnet.

---

## 10. Open follow-ups (out of scope, filed as separate cards)

### 10.1 Depth chart visualization

Cumulative-depth chart above the order book. Phase 2.5. File as a
separate card after Phase 2 lands.

### 10.2 ENS / creator-identity column

Surface creator ENS where set; address fallback. Useful for
counterparty risk gauge. Phase 2.5.

### 10.3 Matcher kickback indicator

For ranged offers (power-user direct-contract calls), surface the
matcher's potential kickback inline in the offer row so keepers can
prioritise. Phase 2.5.

### 10.4 ADR-0010 §17.1 supersession note

Once Phase 2 ships, ADR-0010 §17.1 (the original split-mapping) needs
a note: "Superseded by Phase 2 design (#183). The §17.1 mapping was
one expression of the canonical limit-order shape; Phase 2 chose a
different storage encoding (role-aware reading + explicit non-zero
values) that's safer for direct-accept while preserving §17.1's
intent."

### 10.5 LayerZero NatSpec scrub (#181)

Independent track; affects the public docs site but not the contract
correctness. Phase 2 ships without #181 closing first.

---

## Decision log

| Date | Decision | Rationale |
|---|---|---|
| 2026-05-21 | Role-aware `_acceptOffer` (vs new `acceptOfferWithTerms` selector) | Smaller contract surface; no new ABI; user proposal |
| 2026-05-21 | Drop auto-collapse; require `amountMax > 0` | Fail loud over fail silent; deletes dead derivation code |
| 2026-05-21 | `minPartialFillAmount = 10% of lendingAmount` default | Conservative; clear mental model; user pick |
| 2026-05-21 | Rate convention = limit-order taker-favoring | Standard DEX semantic; consistent with user's "lender other slot = 100%" / "borrower other slot = ~0%" |
| 2026-05-21 | Single-input-per-role frontend (no Basic/Advanced range UI) | Matches DEX/CEX maker UX; reduces frontend complexity |
| 2026-05-21 | Frontend derives implicit storage fields; contract stores explicit | Late-binding HF/LTV recheck at match time covers stale-oracle |
| 2026-05-21 | Display side extends existing OfferBook (not rebuild) | Existing implementation already has anchor-in-middle two-sided layout |
| 2026-05-21 | Depth chart deferred to Phase 2.5 | Order book itself is the load-bearing piece; chart is enhancement |
