# Range Offers + Bot-Driven Matching — Design Doc

**Status.** Draft. Decisions in §11 are open until you sign off.

**Phase 1 scope (locked):** ranges only on `lendingAmount` and `interestRateBps`.
`durationDays` and `collateralAmount` stay single-value. Phase 2 may extend
ranges to those two fields once the matching bot has proven out
economically. **Lender-side partial fills bundled into Phase 1** (§10) —
since we're already touching the `Offer` struct + matching write +
`acceptOffer` refactor, doing partial fills now avoids a second
storage migration + audit cycle later.

---

## 1. Goals & non-goals

### 1.1 Goals

1. **Lift match rates.** Today an offer match requires both sides to
   land on identical `(lendingAmount, interestRateBps, durationDays,
   collateralAsset, collateralAmount)` tuples. The exact-match
   probability is low; users either don't get matched or have to
   manually mirror an existing offer's terms. Range orders move the
   problem from "exact tuple equality" to "interval overlap," which is
   asymptotically easier to satisfy.
2. **Capture user preferences naturally.** A lender who would lend
   anywhere from 1k to 10k USDC at 4–6% APR can express that directly
   instead of posting the most conservative point and missing
   opportunities at the other end of the range.
3. **Make off-chain bots a value-add.** The current keeper
   infrastructure (HF watcher / liquidations / cross-chain reward
   broadcast) is autonomous-execution-only. A matching bot adds
   discovery — finding `(lenderOffer, borrowerOffer)` pairs whose
   ranges overlap and submitting `matchOffers(lenderId, borrowerId)`.
4. **Preserve existing single-value UX as a default.** Beginner mode
   keeps today's "fill in lendingAmount + interestRate" form. Range
   sliders are an Advanced-mode opt-in. Behind the scenes, single
   values collapse to `min == max` so the same on-chain code path
   handles both.

### 1.2 Non-goals

- **Continuous bonding curves / market-making AMM.** Range offers are
  discrete — one offer = one resulting loan. We're not building an
  Aave / Compound-style pool.
- **Range duration / range collateral.** Phase 2.
- **In-protocol matcher.** The contract enforces the match constraints
  at execution; discovery happens off-chain. An on-chain matcher would
  require an order book, which is gas-prohibitive for the size we
  expect Phase 1 to operate at.
- **Backward-incompatible schema change.** Single-value offers
  continue to work — they're modeled as `min == max` ranges.

---

## 2. Data model

### 2.1 `Offer` struct changes

Today's [`LibVaipakam.Offer`](../contracts/src/libraries/LibVaipakam.sol):

```text
amount: uint256
interestRateBps: uint256
durationDays: uint256
collateralAmount: uint256
…
```

Phase 1:

```text
amountMin: uint256          // ← was `amount`
amountMax: uint256          // ← new
amountFilled: uint256       // ← new (Phase 1 §10 — lender partial fills)
interestRateBpsMin: uint256 // ← was `interestRateBps`
interestRateBpsMax: uint256 // ← new
durationDays: uint256       // unchanged
collateralAmount: uint256   // unchanged (semantics differ per side, see §3)
…
```

Storage cost: 3 extra `uint256` slots per offer (was 2 pre-partial-
fills). With slot-packing the BPS pair (`uint64` is plenty for
1e18-bounded BPS values) the real cost is ~2 slots. Acceptable —
offers are short-lived and the slot is recovered when the offer is
fully consumed. Note that with partial fills the storage slot is
NOT deleted on the first match — see §10.6 for the lifecycle.

### 2.2 `CreateOfferParams` changes

The struct passed to `OfferFacet.createOffer`:

```text
struct CreateOfferParams {
  ...
  uint256 amountMin;
  uint256 amountMax;
  uint256 interestRateBpsMin;
  uint256 interestRateBpsMax;
  ...
}
```

Single-value callers set `min == max`. Validation (§4.1) treats the
collapsed case identically.

### 2.3 `Loan` struct — unchanged

Loans are concrete. The matching write (§5.2) computes a single
`(amount, interestRateBps)` from the two offers' ranges, snapshots
that into `Loan` at init, and the loan's lifecycle from there is
identical to today.

---

## 3. System-derived bounds

### 3.1 Why we need them

The lender bears collateral-shortfall risk. Their maximum lending
amount paired with too little collateral can leave the resulting loan
below the protocol's `MIN_HEALTH_FACTOR` (1.5e18). The contract
already enforces HF ≥ 1.5 at `LoanFacet.initiateLoan`, but with
ranges on the lending amount that check has to apply at the
**worst-case corner** — the largest lending amount the offer permits,
paired with the agreed collateral.

Same shape on the borrower side: a borrower who posts a single
collateral amount but accepts loans up to some `maxLending` should
have a system-imposed ceiling on `maxLending` such that even at that
ceiling the HF lands ≥ 1.5.

**With partial fills (§10) the lender's per-match required collateral
is pro-rated** — required = `lender.collateralAmount × matchAmount /
lender.amountMax`. So a 5k collateral requirement at 10k max lending
becomes a 1.5k requirement on a 3k partial fill. The system-derived
floor still computes against `amountMax` at offer-create (worst-case
HF check); per-match HF re-checks against the actual matched amount
+ pro-rated collateral.

### 3.2 The two derived numbers

Per offer, computed at create-time from oracle prices:

| Field | Side | Derivation | Semantic |
|---|---|---|---|
| `minCollateralFloor` | Lender offer | Such that `HF(amountMax, minCollateralFloor) == 1.5e18` | The smallest collateral the lender may **require**. Lender can require more (stricter); contract reverts if they require less. |
| `maxLendingCeiling` | Borrower offer | Such that `HF(maxLendingCeiling, collateralAmount) == 1.5e18` | The largest lending amount the borrower may **accept**. Borrower can accept less (more conservative); contract reverts if they accept more. |

Both numbers depend on:
- Live oracle prices (`OracleFacet.getAssetPrice` for both legs)
- The pair's liquidation LTV (`s.assetRiskParams[asset].liquidationLtvBps`)
- The HF target (1.5e18, equal to `MIN_HEALTH_FACTOR`)

### 3.3 Closed-form (Phase 1)

`HF = (collateralUSD × liqLtvBps / 1e4) / debtUSD`

Solving for `collateralUSD` given `HF == 1.5`:

```text
collateralUSD = 1.5 × debtUSD × 1e4 / liqLtvBps
```

So `minCollateralFloor` (in collateral-asset wei):

```text
minCollateralFloor = (1.5 × amountMax × principalPriceUSD × 1e4)
                     / (liqLtvBps × collateralPriceUSD)
```

Symmetric solve for `maxLendingCeiling` on the borrower side.

A new pure helper `LibRiskMath.deriveBounds` exposes both. Reuses
the existing oracle-call-and-decimals plumbing in `RiskFacet`.

### 3.4 Oracle drift between create and match

Oracle prices move between `createOffer` and `matchOffers`. The
system-derived bounds are **advisory at create time** and the actual
HF check fires again at match time against live prices, so an offer
that was safe-at-create can still revert at match if prices have
drifted unfavourably. This is correct behaviour — the user's
explicit floor (lender's `minCollateralFloor`) and ceiling
(borrower's `maxLendingCeiling`) are part of the offer terms; the
oracle re-check is a separate safety belt.

UI signals stale-bounds visually: when the live derived value
diverges from the stored value by more than X%, the slider's safe
zone flashes a "live oracle has moved" hint and recomputes. (X
TBD — propose 5%.)

---

## 4. Matching algorithm

### 4.1 Match validity

Given `lender` and `borrower` offers, a match is valid iff **all** of:

```text
1.  lender.lendingAsset       == borrower.lendingAsset
2.  lender.collateralAsset    == borrower.collateralAsset
3.  lender.assetType          == borrower.assetType
4.  lender.collateralAssetType == borrower.collateralAssetType
5.  lender.durationDays       == borrower.durationDays
6.  lender.collateralAmount   <= borrower.collateralAmount
    (lender requires X; borrower offers ≥ X — borrower posts the
    larger of the two, locked at match time)
7.  Range overlap on amount (using lender's REMAINING capacity per §10):
       lenderRemaining = lender.amountMax - lender.amountFilled
       max(lender.amountMin, borrower.amountMin)
    <= min(lenderRemaining,  borrower.amountMax)
8.  Range overlap on rate:
       max(lender.interestRateBpsMin, borrower.interestRateBpsMin)
    <= min(lender.interestRateBpsMax, borrower.interestRateBpsMax)
9.  HF at the matched amount + lender.collateralAmount >= 1.5e18
    (oracle re-check at match time, against live prices)
10. Both offers still active (not accepted, not cancelled)
11. Both offer creators still pass sanctions / KYC gates if enabled
    (gates are runtime-disabled on the retail deploy per CLAUDE.md;
     no-op there)
```

### 4.2 Terms-derivation rule (the politics)

When the ranges overlap, what concrete `amount` and `interestRateBps`
does the resulting loan use? Several rules to choose from:

**Option A — midpoint.** `(min(maxA, maxB) + max(minA, minB)) / 2`.
Pros: trivial, neutral, no game-theory edge case. Cons: leaves
value on the table for both sides — neither party gets their
preferred end of the spectrum.

**Option B — favour-the-creator.** First-posted offer's terms
prevail; the matching offer's range is the "willing to accept"
acceptor. Pros: encourages early offer-posting. Cons: rate-side asymmetry
— a borrower waiting on the book gets disadvantaged by a late lender.

**Option C — favour-the-tighter-range.** The offer with the
narrower range wins (its midpoint is the resulting term). Pros:
rewards users who took on commitment risk by posting tighter
ranges. Cons: complicated UX explanation; gameable by posting
artificially tight ranges around an expected match.

**Option D — match by surface, not midpoint.** Borrower's max-
amount + lender's min-rate (the borrower-friendly extremes); or the
mirror. Pros: clean rule. Cons: same first-posted asymmetry as B.

**Recommendation: Option A (midpoint)** for Phase 1. It's the only
rule with no game-theory edge case, the math is auditable in one
line, and we can revisit with real-flow data after launch. The
contract emits both midpoints in the `LoanInitiated` event so any
downstream alternate-rule analytics is reconstructable.

### 4.3 Worked example

```text
Lender offer:   amountMin=1_000  amountMax=10_000  rateMin=400  rateMax=600
                duration=30 days  collateralRequired=5_000 USDC-equiv
Borrower offer: amountMin=2_000  amountMax= 5_000  rateMin=300  rateMax=550
                duration=30 days  collateralOffered=6_000 USDC-equiv

Match check:
  Amount overlap?    max(1000,2000)=2000 <= min(10000,5000)=5000  ✓
  Rate overlap?      max(400,300)=400    <= min(600,550)=550      ✓
  Collateral?        5000 <= 6000                                  ✓
  Duration?          30 == 30                                      ✓

Terms (midpoint rule):
  amount  = (2000+5000)/2 = 3500
  rate    = (400+550)/2   = 475 bps
  duration = 30
  collateral = 6000  ← borrower's offered amount, locked

HF check at (amount=3500, collateral=6000) against live oracle: must
be ≥ 1.5e18 or revert.
```

---

## 5. Contract surface

### 5.1 Updated `OfferFacet.createOffer`

Validation (in addition to today's checks):

```text
require(amountMin > 0)
require(amountMin <= amountMax)
require(interestRateBpsMin <= interestRateBpsMax)
require(interestRateBpsMax <= MAX_INTEREST_BPS)  // 100% sanity
```

Side-specific bounds:

```text
if (offerType == Lender) {
  // Lender requires `collateralAmount`. System floor at `amountMax`:
  uint256 floor = LibRiskMath.minCollateralForLending(
    amountMax, lendingAsset, collateralAsset
  );
  require(collateralAmount >= floor, MinCollateralBelowFloor());
}

if (offerType == Borrower) {
  // Borrower posts `collateralAmount`. System ceiling on `amountMax`:
  uint256 ceil = LibRiskMath.maxLendingForCollateral(
    collateralAmount, lendingAsset, collateralAsset
  );
  require(amountMax <= ceil, MaxLendingAboveCeiling());
}
```

The custody pull at create-time (per `OfferFacet._creatorPullAmount`)
uses **`amountMax` for lender offers** and **`collateralAmount` for
borrower offers** — same as today's flow, just substituting the
range's worst-case for the formerly-fixed amount. Lenders escrow the
maximum they might lend; on match the unused portion stays in their
escrow.

### 5.2 New `OfferFacet.matchOffers(lenderId, borrowerId)`

Permissionless write. Anyone can call (it's the bot's job, but
nothing prevents either user from clicking "Match" themselves).

```text
function matchOffers(uint256 lenderId, uint256 borrowerId)
  external returns (uint256 loanId)
{
  Offer storage L = s.offers[lenderId];
  Offer storage B = s.offers[borrowerId];
  require(L.offerType == Lender);
  require(B.offerType == Borrower);
  require(!L.accepted && !B.accepted);
  // §4.1 checks 1-8 + 10. Lender's remaining capacity is
  // amountMax - amountFilled (per §10).
  uint256 lenderRemaining = L.amountMax - L.amountFilled;
  // Compute midpoint terms (§4.2).
  uint256 amount = (max(L.amountMin, B.amountMin)
                    + min(lenderRemaining, B.amountMax)) / 2;
  uint256 rateBps = (max(L.interestRateBpsMin, B.interestRateBpsMin)
                     + min(L.interestRateBpsMax, B.interestRateBpsMax)) / 2;
  // Pro-rated collateral required for THIS match (§10.4):
  uint256 reqCollat = (L.collateralAmount * amount) / L.amountMax;
  require(B.collateralAmount >= reqCollat, CollateralBelowRequired());
  // Borrower offers are single-fill: the borrower's posted collateral
  // (collateralAmount) is fully consumed in this one match, and any
  // delta vs. reqCollat stays at reqCollat (lender only requires
  // pro-rated; borrower posted more, the excess refunds to the
  // borrower's escrow on this match — symmetric to the lender's
  // amountMax refund pattern below).
  if (B.collateralAmount > reqCollat) {
    LibFacet.crossFacetCall(escrowDepositERC20(B.creator, collat, B.collateralAmount - reqCollat));
  }
  // Initiate the loan via existing LoanFacet path. HF >= 1.5 fires here.
  loanId = LoanFacet.initiateLoan(... lenderId, borrowerId, amount, rateBps, reqCollat ...);
  // Lender: increment filled; close offer when remaining < amountMin.
  L.amountFilled += amount;
  if (L.amountMax - L.amountFilled < L.amountMin) {
    // Dust remainder can't satisfy lender's per-match minimum —
    // close offer + refund dust back to lender's escrow.
    if (L.amountMax > L.amountFilled) {
      LibFacet.crossFacetCall(escrowDepositERC20(L.creator, asset, L.amountMax - L.amountFilled));
    }
    L.accepted = true;
  }
  // Borrower: single-fill. Always close on match.
  B.accepted = true;
  emit OfferMatched(lenderId, borrowerId, loanId, amount, rateBps);
}
```

**Custody flow with partial fills:**

- Lender pre-escrowed `amountMax` at create. Each match pulls
  `amount` from that escrowed pool and routes to the borrower's
  escrow (existing `LoanFacet.initiateLoan` flow). Remaining
  `amountMax − amountFilled` stays in lender's escrow custody until
  either another match consumes more, or the offer closes (dust
  refund or explicit cancel).
- Borrower pre-escrowed `collateralAmount` at create. The match
  consumes `reqCollat` (pro-rated against lender's `amountMax`); any
  excess refunds back to the borrower's escrow at match time.
  Borrower offers are single-fill in Phase 1 (§10.1), so the
  borrower's offer always closes after one match.

### 5.3 New view `OfferFacet.previewMatch`

Bot-facing read that runs every match validity check and returns
either:
- `(true, amount, rateBps)` — match is valid; here are the terms.
- `(false, errorCode)` — match is invalid; here's why
  (`AssetMismatch`, `RateNoOverlap`, `AmountNoOverlap`,
  `CollateralBelowRequired`, `HFTooLow`, `OfferAccepted`,
  `OfferCancelled`).

Pure view (`view`, no state writes). Bots call this to filter
candidate pairs before submitting the matching tx — saves gas on
guaranteed-revert calls and lets the bot surface "near-misses" for
analytics ("offer 142 + 198 would have matched if rate range
overlapped by 5 more bps").

### 5.4 Existing `acceptOffer` — unchanged path for direct match

A user looking at an open offer can still click Accept directly,
bypassing the bot. Internally, `acceptOffer(offerId, …)` is the
**self-counterparty match**: the acceptor implicitly creates a
single-point counterpart offer (`min == max == terms-they-agreed-to`)
and matches it against `offerId`. Code-wise, `acceptOffer` becomes a
thin wrapper around the same matching logic — guarantees the two
paths can't drift in semantics.

### 5.5 New error types

```text
error MinCollateralBelowFloor(uint256 provided, uint256 floor);
error MaxLendingAboveCeiling(uint256 provided, uint256 ceiling);
error InvalidAmountRange();         // amountMin > amountMax
error InvalidRateRange();           // rateMin > rateMax
error AssetMismatch();              // assets differ between sides
error AmountNoOverlap();
error RateNoOverlap();
error CollateralBelowRequired();    // borrower offer's collateral < lender's required
error DurationMismatch();           // Phase 1 — duration single-value, must equal
```

---

## 6. Frontend surface

### 6.1 Beginner mode (default)

Two single-value fields: **Amount** + **Interest rate**. Same UX as
today. Behind the scenes the form sets `amountMin == amountMax` and
`interestRateBpsMin == interestRateBpsMax` before submission. No
visual hint that ranges exist — beginner-mode users see today's
form unchanged.

### 6.2 Advanced mode

A single Advanced toggle on the Create Offer page reveals two
dual-handle range sliders:

- **Lending amount range** — lower handle = `amountMin`, upper =
  `amountMax`. Numeric inputs alongside for keyboard-power users.
- **Interest rate range** — same shape, in BPS.

Live-derived companion read on the **collateral row**: a thin pill
showing the system-computed `minCollateralFloor` (lender) or
`maxLendingCeiling` (borrower). When the user's manual entry violates
the bound, the pill turns red with an inline error matching the
contract revert (`MinCollateralBelowFloor` / `MaxLendingAboveCeiling`).

A **worst-case HF preview** banner shows the computed HF at the
worst-case corner of the range (largest `amountMax`, smallest
`collateralAmount`), with a colour gradient: green ≥ 2.0, amber
1.5–2.0, red < 1.5 (would revert).

i18n: ~10 new keys under `createOffer.range.*`, mirrored across all
10 locales.

### 6.3 Offer Book — range display

Open offers in the Offer Book book render their amount and rate as
ranges when applicable: `1k–10k USDC` and `4–6%`. The Offer Book's
existing market-anchor rate-deviation badge needs to know which
single number to compare against — propose using the midpoint of the
rate range. Single-value offers (collapsed range) display
identically to today.

### 6.4 Match preview surface

When a user is about to accept an offer with their wallet, a new
preview shows:
- The offer's range
- The matched terms under the midpoint rule
- The resulting HF
- The lender-side amount that would refund back to escrow (their
  `amountMax − matched amount` delta)

This is informational; the user has already consented to the range
when they clicked Accept.

---

## 7. Bot architecture

### 7.1 Reference implementation lives alongside the keeper bot

The existing public reference keeper bot (`vaipakam-keeper-bot`
sibling repo) handles HF watchers + autonomous keepers. The
matching bot is a third detector mode in that same bot:

```text
vaipakam-keeper-bot/
  src/
    detectors/
      hfWatcher.ts        # existing
      stalePosition.ts    # existing
      offerMatcher.ts     # NEW
```

### 7.2 Discovery loop

```text
every 10 seconds:
  1. read all open lender offers (event-indexed)
  2. read all open borrower offers (event-indexed)
  3. group by (lendingAsset, collateralAsset, durationDays)
  4. within each group, scan the cartesian product:
     for each lender L:
       for each borrower B:
         if previewMatch(L.id, B.id).success:
           candidates.push({lender: L, borrower: B, gain: ...})
  5. sort candidates by `gain` descending
  6. submit `matchOffers(L.id, B.id)` for the top N
```

`gain` heuristic: a function of the bot's economics — gas cost vs.
expected match-fee revenue (TBD in §11). Could simply be "match the
oldest-pending borrower offer" if no fee model.

### 7.3 N² complexity

Cartesian product is O(N×M) per group. With a pessimistic 10k open
offers per side, that's 100M previewMatch view calls — clearly
infeasible. Mitigations:

- **Group by `(lendingAsset, collateralAsset, durationDays)` first.**
  Within a group, N and M are typically small (<100).
- **Precompute interval indices.** Sort offers by `amountMin` and
  `rateMin`; range-overlap is a 2D interval query. The bot caches
  these in memory between scans.
- **Cap candidates per scan.** Only the top 50 by `gain` go to
  `previewMatch`; the rest defer to the next scan.

For Phase 1 scale (probably hundreds of open offers, not tens of
thousands) the naïve loop is fine.

### 7.4 Match-tx submission

The bot submits `matchOffers(L, B)` as a normal tx. MEV concerns in
§9.

---

## 8. Backward compatibility

### 8.1 In-protocol

`amount == amountMin == amountMax` is valid. Same for rate. So:

- Existing single-value offers pre-Phase-1 are migration targets,
  not breakage. A `migrateOffersToRanges()` script populates the new
  Min/Max fields from the old single field for every active offer
  in storage.
- The new struct is a Diamond facet upgrade. State migration runs
  one-shot post-cut.
- The frontend's beginner-mode form keeps writing `min == max`
  values, so the user-facing path doesn't change.

### 8.2 Off-chain consumers

- Subgraph / event indexers: `OfferCreated` event gains
  `amountMin/amountMax/rateMin/rateMax` fields; consumers that read
  the legacy single-value fields stop working. Coordinate the cut.
- The keeper bot's existing detectors don't read offer-amount
  fields — no change needed.
- The frontend ABI re-export sweep covers this automatically per
  CLAUDE.md's "Frontend ABI sync" workflow.

---

## 9. MEV / fairness

### 9.1 Front-running surface

A public `matchOffers(L, B)` tx in the mempool exposes:
- The pair being matched (visible to searchers)
- The resulting concrete amount + rate (computable from the offers)

A searcher can:

1. **Cancel-and-resubmit attack.** Front-run the bot's tx with a
   `cancelOffer(L)` from L's owner, then post a tighter lender offer
   that matches B at terms more favourable to L's owner. Only works
   if the searcher controls L's owner — i.e., the offer-creator
   themselves. Not really MEV; it's the offer-creator deciding to
   cancel their own offer just before a match. Mitigation: add a
   short post-create cancel cooldown (e.g. 5 min after `createOffer`,
   `cancelOffer` reverts). User-griefing risk is low because the
   creator can still cancel before any match attempt.
2. **Match-front-run with a flashbots bundle** — searcher submits
   `matchOffers(L, B)` themselves, claiming whatever match-fee revenue
   we attach. This is fine; competition for matching fees is the
   intended model.
3. **Priority-gas-auction on the match tx.** Searchers see a
   profitable match in mempool, bid up gas. Resolves to highest-gas
   submitter wins. Acceptable — no party loses funds, just match
   priority.

### 9.2 Mitigations (Phase 1)

- **Cancel cooldown.** 5-minute post-`createOffer` window during
  which `cancelOffer` reverts. Blunts the cancel-front-run attack.
- **Public mempool is fine for everything else.** Match competition
  IS the bot economics; we want it open. A private RPC / commit-
  reveal scheme would be over-engineering for Phase 1.
- **Match-fee model TBD** (§11). If a fee exists, paying it to the
  match-tx submitter creates the right incentive for bots.

### 9.3 Phase 2 considerations

If matching volume justifies it, Phase 2 can add:
- **Commit-reveal**: bot commits a hash of `(L, B, salt)` in tx 1,
  reveals + executes in tx 2. Latency cost.
- **Private relays**: Flashbots / MEV-Share equivalent on every
  supported chain.

---

## 10. Partial fills (lender side)

### 10.1 Why lender-side only

Range orders and partial fills are the natural pair: a 10k lender
range matches against three different borrower offers (3k + 5k +
2k) instead of waiting for an exact-size counterparty. But making
**both** sides partial-fillable doubles the design surface — every
match becomes a 2D allocation problem instead of "lender slice +
borrower atom" — and forces a more complex multi-position NFT model
on the borrower side too.

For Phase 1 we ship **lender-side only**: a single lender offer can
be filled by multiple borrowers across multiple matches, but each
borrower offer is consumed in full on its first match. This:

- Captures the high-value behaviour ("a single 10k lender posts
  once, gets filled across the day by 3-4 smaller borrowers")
  which is the dominant flow we expect.
- Keeps the borrower's position model simple — one borrower offer,
  one position NFT, one loan.
- Defers the borrower-side multi-position UX until we have data
  showing it's worth the complexity (Phase 2 trigger per §11 #9).
- Makes the contract logic asymmetric in a controlled way: the
  match write decrements the lender's `amountFilled` and closes
  only the borrower's offer at single-match.

### 10.2 Data model additions

Beyond the range fields in §2.1:

```text
struct Offer {
  ...
  uint256 amountMin;         // §2 — already added for ranges
  uint256 amountMax;         // §2
  uint256 amountFilled;      // ← NEW (this section)
  uint256 interestRateBpsMin;
  uint256 interestRateBpsMax;
  uint256 collateralAmount;  // see §10.4 for partial-fill semantics
  bool    accepted;          // unchanged — flips at FULL fill (lender)
                             //   or first match (borrower)
  ...
}
```

`amountFilled` starts at zero and only mutates on lender offers
(borrower offers stay at zero — single-fill). Each match increments
`amountFilled += matched.amount`.

### 10.3 Per-match amount range

The lender's offer expresses two numbers:
- `amountMin` — the smallest single match the lender will accept.
- `amountMax` — the cumulative ceiling across all matches.

Per-match available range on lender side:

```text
lenderRemaining = amountMax - amountFilled
perMatchLow     = amountMin                    // unchanged across matches
perMatchHigh    = lenderRemaining              // shrinks as fills accumulate
```

If `lenderRemaining < amountMin`, the offer is "fully filled in
practice" — the leftover dust is too small to satisfy the lender's
own per-match minimum. The match write closes the offer and
refunds the dust to the lender's escrow (§5.2 `matchOffers`).

The lender's `amountMin` does NOT shrink with fills. A lender that
posts `amountMin = 1k, amountMax = 10k` is saying "I'll do 1-10k
per match, total 10k across however many matches." If they only
want one big match they post `amountMin = amountMax`.

### 10.4 Per-match collateral derivation

The lender's `collateralAmount` field expresses the collateral
required at the **maximum** lending amount (`amountMax`). For a
partial match, required collateral pro-rates linearly:

```text
reqCollateral(match) = lender.collateralAmount × matchAmount / lender.amountMax
```

This preserves the lender's **collateral-to-debt ratio** at each
match, so HF stays at the same target across fills. A lender
posting `amountMax=10k` + `collateralAmount=5k` (50% LTV) gets
50% LTV on every partial match regardless of match size.

The borrower's `collateralAmount` is still a single value — what
they're posting upfront. The match validity check requires
`borrower.collateralAmount >= reqCollateral(match)`. Excess
(borrower posted more than the per-match requirement) refunds back
to the borrower's escrow at match time (single-fill borrower side
means the entire borrower-posted collateral is consumed exactly at
match — the match consumes `reqCollateral` and refunds
`borrower.collateralAmount - reqCollateral`).

System-derived `minCollateralFloor` (§3.2) is unchanged: still
computed against `amountMax` so the worst-case match (lender at
amountMax-cumulative-cap) lands HF ≥ 1.5. Lender can require more
(stricter) but not less.

### 10.5 Multi-NFT lender position model

Today every loan mints exactly two position NFTs:
- One **lender NFT** to the lender's wallet (representing the
  receivable side of the loan).
- One **borrower NFT** to the borrower's wallet (representing
  the obligation side).

With lender-side partial fills, a single lender offer can spawn N
loans across its lifetime. Each loan gets its own pair of NFTs.
**The lender ends up with N lender NFTs in their wallet** — one
per partial match — each tied to a different borrower, each with
its own `lenderTokenId`, principal, start time, and lifecycle.

This is fine on the contract side — `VaipakamNFTFacet.mintNFT` is
already per-loan; nothing in the NFT facet requires unique per-
offer IDs. But there are three downstream implications:

**Frontend portfolio view.** "Your Loans" on the Dashboard already
groups by `lenderTokenId`. With N NFTs from one offer, the lender
sees N rows in that table, all with the same lending asset and
similar terms but different counterparties + start times. Adding
an optional **"Group by source offer"** view collapses the N rows
into one expandable card showing the offer's overall fill progress
+ per-match detail rows on expand. Default to flat view (today's
behaviour); group view is a UI toggle.

**Cross-loan reasoning.** Some flows today implicitly assume a
single lender per side per loan (e.g. accumulated yield rebate
analytics). Each partial-fill loan is an independent unit so these
flows just sum across the N loans on the lender side — no contract
change, only frontend aggregation queries.

**Position-NFT marketplaces.** Each of the N lender NFTs is
independently transferable. A lender who wants to liquidate their
exposure can sell individual NFTs (hot positions / cold positions)
rather than all-or-nothing. Existing position-NFT transfer code
unchanged.

### 10.6 Cancel & dust handling

`cancelOffer(offerId)` semantics with partial fills:

- **No prior fills (`amountFilled == 0`):** today's behaviour —
  delete storage slot, refund full `amountMax` (lender) or full
  `collateralAmount` (borrower) to the creator's escrow.
- **Partial fills exist (`amountFilled > 0`, lender side):** the N
  existing loans live on (they're independent contracts now).
  Refund only the unfilled portion (`amountMax - amountFilled`)
  to the lender's escrow. Mark `accepted = true` so the offer
  doesn't show on the open book; **storage slot stays** because
  the offer's terms are referenced by the position NFTs' metadata
  (`getOffer(offerId)` is still callable until the last loan
  closes, then cleanup can run as a maintenance pass).

**Auto-close on dust:** when `amountMax - amountFilled < amountMin`
after a match (lender's per-match minimum can't be satisfied
anymore), `matchOffers` itself closes the offer — refunds dust +
flips `accepted = true` in the same tx. No separate cancel call
needed.

**Cancel cooldown (§9.2):** the 5-minute post-create cooldown
applies only to the `amountFilled == 0` case. Partial-filled offers
can be cancelled immediately because the lender has already
committed value (the matches are done) — there's no front-run
attack surface.

### 10.7 Worked example — three partial fills + dust close

```text
Lender posts:   amountMin=1k  amountMax=10k  rateMin=400  rateMax=600
                duration=30   collateralAmount=5k (USDC-equiv ETH)
                amountFilled=0

Match 1 — borrower offer A (amountMin=2k, amountMax=3k, rate 450-550):
  perMatchHigh = 10k - 0 = 10k
  amount overlap [max(1k,2k), min(10k,3k)] = [2k, 3k]
  midpoint = 2.5k
  reqCollat = 5k × 2.5k / 10k = 1.25k
  → loan #1 created (2.5k @ 500bps, 1.25k collat)
  → lender NFT #1 minted to lender, borrower NFT #1 to borrower-A
  → amountFilled = 2.5k

Match 2 — borrower offer B (amountMin=4k, amountMax=5k, rate 500-600):
  perMatchHigh = 10k - 2.5k = 7.5k
  amount overlap [max(1k,4k), min(7.5k,5k)] = [4k, 5k]
  midpoint = 4.5k
  reqCollat = 5k × 4.5k / 10k = 2.25k
  → loan #2 created
  → lender now holds lender NFT #1 AND lender NFT #2
  → amountFilled = 7k

Match 3 — borrower offer C (amountMin=2k, amountMax=4k, rate 400-500):
  perMatchHigh = 10k - 7k = 3k     ← dropped below borrower C's amountMin (2k)? No, ≥ 2k
  amount overlap [max(1k,2k), min(3k,4k)] = [2k, 3k]
  midpoint = 2.5k
  reqCollat = 5k × 2.5k / 10k = 1.25k
  → loan #3 created
  → lender holds 3 NFTs
  → amountFilled = 9.5k
  → remaining = 0.5k < amountMin (1k) → DUST CLOSE
     refund 0.5k back to lender's escrow
     mark offer.accepted = true
     emit OfferClosed(offerId, reason="dust")
```

Lender's wallet at end: 3 lender position NFTs, one per loan, each
with its own counterparty + start time + concrete amount. Lender's
escrow: refunded 0.5k dust. Offer storage slot retained (still
referenced by the 3 position NFTs' metadata) but `accepted = true`
so it's off the open book.

### 10.8 Bot discovery changes

Two changes to the discovery loop in §7.2:

1. **Partial-filled lender offers stay in the active set.** A
   lender offer with `amountFilled > 0` and `accepted == false` is
   still matchable until dust-close. The bot doesn't filter these
   out. Per-match available range comes from §10.3.
2. **Lender remaining drives match-priority.** When the bot has a
   choice between two lender offers that overlap with a given
   borrower, prefer the one with smaller `lenderRemaining`
   (closer to dust-close). This consolidates filled offers off the
   book faster, reduces book-pollution from long-tail dust
   remainders, and gets lenders fully filled sooner.

Group-by-(asset,asset,duration) bucket size is unchanged. The
inner cartesian product respects partial-filled lenders the same
as fresh ones — the overlap math just uses
`min(lenderRemaining, borrower.amountMax)` instead of
`min(lender.amountMax, borrower.amountMax)`.

### 10.9 Frontend surface

**Create Offer (Advanced mode).** Lender-side offer creation gets
a new **"Allow partial fills"** checkbox below the amount range
slider, default ON. When OFF, the form sets
`amountMin == amountMax` so the offer behaves single-fill (the
contract has no separate `partialFillsEnabled` flag — single-fill
is the `amountMin == amountMax` collapsed case). Borrower-side
offers don't show this control (borrower offers are single-fill
in Phase 1).

**Offer Book row — fill progress.** Lender offers with
`amountFilled > 0` render a thin progress bar under the amount
range cell, showing `amountFilled / amountMax`. Hover tooltip:
"X.X% filled across N matches." Single-value offers (amountMin ==
amountMax) and zero-fill offers don't render the progress bar.

**Your Loans — group toggle.** New toggle pill above the table:
**Flat | Grouped by source offer**. Flat mode (default) is today's
behaviour. Grouped mode collapses N loans from the same offer into
one expandable card with the offer's terms in the header + a
"X / Y matches" badge + an Expand control showing per-loan rows.
Loans not from a partial-fill offer (single-fill or pre-Phase-1)
render as flat rows in either mode.

**Match preview surface.** When a borrower is about to accept (or
the bot is about to match) a partial-filled lender offer, the
preview surface shows:
- The lender's overall fill progress
- The matched amount + rate for THIS match
- The lender's remaining capacity after this match
- Whether this match would close the offer (dust) or leave it open

i18n: ~12 new keys under `partialFills.*`, mirrored across all 10
locales.

### 10.10 Interactions with existing lifecycle flows

The position NFTs created from partial fills are independent
loans, so all per-loan flows operate on each loan in isolation —
no offer-level lifecycle effects. But three flows
(`EarlyWithdrawalFacet`, `PrecloseFacet`, `RefinanceFacet`) deserve
explicit walk-throughs because they intersect with offer-side
state in subtle ways.

**Early withdrawal (lender exits a loan early).**
The lender-side facet pulls collateral from the borrower (via
swap or transfer) and closes the loan; the lender's
`lenderTokenId` is burned. With partial fills, the lender holds
N tokens; they can early-withdraw any subset selectively. The
source offer's `amountFilled` stays — the early withdrawal closes
a downstream loan, not the offer that produced it. If the offer
is still open (`accepted == false`) the lender keeps receiving
new partial fills against the unfilled portion. **No contract
change required.** UI surfaces per-loan early-withdraw in the
Grouped-by-source-offer view as a per-row action.

**Preclose (borrower closes a loan early via direct repayment or
offset-via-offer).**
Each borrower in a partial-filled set holds their own borrower
NFT, so preclose operates per-loan as today. The
**offset-via-offer** variant matches the to-be-precluded loan
against a *replacement* offer — and that replacement offer can
itself be a range / partial-fill offer. When that's the case,
preclose treats the new offer as a fresh match: pulls a slice of
its remaining capacity (per §5.2 logic), increments its
`amountFilled`, mints a new lender NFT for the new lender. The
old loan closes, the new loan opens, the source offer's books
balance. **Contract change needed:** `PrecloseFacet`'s
`offsetViaOffer` write reads the replacement offer's terms — it
must be updated to read the range fields and call the §5.2
match-with-midpoint logic instead of treating the offer as a
single-value source. Roughly the same delta as `acceptOffer`'s
refactor (§5.4) — both are wrappers around the unified matching
core.

**Refinance (borrower replaces an existing loan with a new
offer's terms).**
Same shape as preclose's offset-via-offer. The replacement-offer
side runs through the matching core; the original loan closes;
new loan opens with new lender NFT. Asset-continuity invariants
(matching `lendingAsset`, `collateralAsset`, etc.) carry over
unchanged — they're per-asset, not per-amount. **Contract change
needed:** `RefinanceFacet.refinance` updated identically to
preclose's offset path. Both inherit the partial-fill amount-
overlap-and-midpoint semantics for free once they call the
shared matching core.

**Default + claim flows.** Per-loan; unaffected. A loan from a
partial-filled offer can default independently of the other
loans from that same offer, and the lender's `lenderTokenId` for
that loan goes through the standard claim flow. Other loans from
the same offer (and the offer itself, if still open) are
untouched. The frontend grouped-by-source-offer view shows mixed
states cleanly: the offer still open + 2 loans active + 1 loan
defaulted is a valid combined state.

**Add collateral.** Per-loan; unaffected. Borrower can top up
collateral on any individual loan they hold from a partial-filled
offer.

**Asset continuity required by refinance / preclose-offset.** The
existing invariants (`Loan.tokenId`, `Loan.quantity`,
`Loan.prepayAsset`, `Loan.collateralTokenId`,
`Loan.collateralQuantity` must all match between original loan
and replacement offer) are per-loan, so they cross over
unchanged. Each per-fill loan stamps these from the replacement
match's concrete values; the original offer's range fields are
unrelated.

**Net contract surface for §10.10:** two extra refactors —
`PrecloseFacet.offsetViaOffer` and `RefinanceFacet.refinance` —
both consuming the same matching core as `matchOffers` and
`acceptOffer`. ~3-4 days of additional contract work. Test
matrix grows by ~12 cases (preclose + refinance × {full-match,
partial-match, dust-close, non-overlap-revert}).

---

## 11. Open decisions

Each of these gates implementation. Need explicit sign-off before
contracts work begins.

| # | Decision | Recommendation | Why |
|---|---|---|---|
| 1 | Terms-derivation rule | Midpoint (Option A, §4.2) | No game-theory edge case; auditable in one line; can revisit with real flow data |
| 2 | HF target for system-derived bounds | 1.5e18 (matches `MIN_HEALTH_FACTOR`) | Consistency with init-time check |
| 3 | Stale-bound UI threshold | 5% drift | Small enough to catch real moves; big enough not to flicker on noise |
| 4 | Cancel cooldown | 5 minutes | Long enough to deter cancel-front-run; short enough not to grief honest cancellations |
| 5 | Match-fee model | None for Phase 1 | Bot economics through gas markets is sufficient; revisit if discovery latency is a problem |
| 6 | Migration of existing offers | Yes, one-shot script | Avoids dual-path code in `acceptOffer` |
| 7 | Backward-compatible `acceptOffer` | Yes — wrapper around `matchOffers` | Single source of truth for matching semantics |
| 8 | `previewMatch` returns concrete `amount` / `rateBps` | Yes | Bot needs them to estimate gain pre-submission |
| 9 | Phase 2 trigger | When match latency > 30 min p95 OR match throughput > 1/min | Concrete tripwire for Phase 2 work |
| 10 | Partial fills — lender side only in Phase 1 | Yes (§10.1) | High-value behaviour; defers borrower-side multi-position complexity |
| 11 | Per-match required collateral derivation | Pro-rata against `amountMax` (§10.4) | Preserves lender's collateral-to-debt ratio at every match |
| 12 | Dust-close threshold | `amountMax - amountFilled < amountMin` | Lender's own min already encodes "smallest match worth doing"; no separate constant |
| 13 | Lender position NFT model | Per-match NFTs, no per-offer wrapper NFT (§10.5) | Existing NFT facet supports it natively; transfer-per-position is a feature not a bug |
| 14 | Preclose-offset + Refinance share matching core | Yes (§10.10) | Avoids dual semantics for "match against an offer" |

---

## 12. Phasing

### Phase 1 (this doc, ~5-6 weeks bundled — was 3-4 pre-partial-fills)

**Contracts (~3 weeks):**
- `Offer` struct gains `amountMin/Max`, `amountFilled`,
  `interestRateBpsMin/Max`
- `CreateOfferParams` updated; `OfferFacet.createOffer` validates ranges + side-specific bounds
- `LibRiskMath.minCollateralForLending` + `maxLendingForCollateral` helpers
- `OfferFacet.matchOffers(lenderId, borrowerId)` new write —
  including lender-side partial-fill semantics (§5.2 + §10):
  pro-rated collateral derivation, `amountFilled` increment,
  dust-close auto-flip, dust refund to lender's escrow
- `OfferFacet.previewMatch(lenderId, borrowerId)` new view —
  uses `amountMax - amountFilled` for lender's remaining capacity
- `OfferFacet.acceptOffer` refactored to wrapper around matching logic
- `PrecloseFacet.offsetViaOffer` refactored to consume the
  matching core (per §10.10) — partial-fills against the
  replacement offer
- `RefinanceFacet.refinance` refactored identically
- `OfferMatched` event (carries match amount, rate, lender's
  remaining post-match)
- `OfferClosed` event (with `reason ∈ {fullyFilled, dust,
  cancelled}`)
- New error types
- Cancel cooldown (`MIN_OFFER_CANCEL_DELAY = 5 minutes`,
  applies only when `amountFilled == 0`)
- Storage migration script for existing offers (post-cut one-shot)
  — sets `amountMin == amountMax == amount`, `amountFilled = 0`
- ~50 Foundry tests covering: range validation, bound enforcement,
  midpoint math, oracle re-check at match, cancel cooldown,
  backward-compat acceptOffer-as-wrapper, refund of unused
  amountMax delta, partial-fill multi-match scenarios, dust-close
  threshold, multi-NFT lender position, preclose-via-partial-fill,
  refinance-via-partial-fill

**Frontend (~1.5 weeks):**
- Advanced-mode toggle on Create Offer
- Dual-handle range sliders × 2 (amount + rate)
- Numeric input alongside each slider
- "Allow partial fills" checkbox on lender side (default ON)
- Live `minCollateralFloor` / `maxLendingCeiling` pill
- Worst-case HF preview banner
- Offer Book renders ranges + fill-progress bar on partial-filled
  lender offers
- Your Loans Flat / Grouped-by-source-offer toggle + grouped-card
  expand/collapse
- Match preview on accept-offer flow + partial-fill remaining
  capacity display
- i18n keys × 10 locales (`createOffer.range.*` +
  `partialFills.*` namespaces)

**Bot (~5 days, in `vaipakam-keeper-bot`):**
- `offerMatcher.ts` detector
- Group-by-(asset,asset,duration) discovery loop
- Partial-filled lender offers stay in active set (§10.8)
- `lenderRemaining`-aware match priority
- `previewMatch` filter pre-submission
- Match-tx submission

**Audit:** any change touching offer/loan creation needs
re-audit. Bundled scope (ranges + lender partial fills +
preclose/refinance refactor) means a single re-audit instead of
two; budget ~1 week of audit response time alongside Phase 1.

### Phase 2 (out of scope — when triggered per §11 #9)

- Ranges on `durationDays` and `collateralAmount`
- **Borrower-side partial fills** — multi-position borrower NFT
  model + 2D match allocation problem
- Match-fee economics (paid to bot operator)
- Commit-reveal / private relay if MEV becomes a problem

---

## 13. Critical files

- `contracts/src/libraries/LibVaipakam.sol` — `Offer` struct
  changes (range fields + `amountFilled`); add
  `MIN_OFFER_CANCEL_DELAY`.
- `contracts/src/libraries/LibRiskMath.sol` (new) —
  `minCollateralForLending`, `maxLendingForCollateral`. Pure
  helpers, no storage.
- `contracts/src/libraries/LibOfferMatch.sol` (new) — shared
  matching core consumed by `matchOffers`, `acceptOffer`,
  `PrecloseFacet.offsetViaOffer`, `RefinanceFacet.refinance`.
  Encapsulates §4.1 validity + §4.2 midpoint + §10 partial-fill
  semantics so the four entry points can't drift.
- `contracts/src/facets/OfferFacet.sol` — `createOffer` validation +
  side-specific bound enforcement; `matchOffers`, `previewMatch`,
  `cancelOffer` cooldown + partial-filled cancel semantics;
  `acceptOffer` refactor to wrap `LibOfferMatch`.
- `contracts/src/facets/PrecloseFacet.sol` — `offsetViaOffer`
  refactored to consume `LibOfferMatch` (per §10.10).
- `contracts/src/facets/RefinanceFacet.sol` — `refinance`
  refactored identically.
- `contracts/src/facets/RiskFacet.sol` — already has the oracle
  + LTV plumbing the new `LibRiskMath` reuses.
- `contracts/test/OfferFacetMatching.t.sol` (new) — match-validity
  matrix.
- `contracts/test/OfferFacetRangeBounds.t.sol` (new) — system-derived
  bound enforcement.
- `contracts/test/OfferFacetPartialFills.t.sol` (new) — multi-
  match scenarios, dust close, multi-NFT lender position,
  cancel of partial-filled offers.
- `contracts/test/PrecloseFacetPartialFill.t.sol` (new) —
  preclose-offset against a range / partial-filled offer.
- `contracts/test/RefinanceFacetPartialFill.t.sol` (new) — same
  shape on refinance.
- `contracts/test/OfferFacetCancelCooldown.t.sol` (new).
- `contracts/script/MigrateOffersToRanges.s.sol` (new) — one-shot
  state-migration runner.
- `frontend/src/lib/offerSchema.ts` — `OfferFormState` +
  `CreateOfferPayload` + validator + range mode + partial-fills
  toggle handling.
- `frontend/src/components/app/RangeSlider.tsx` (new) — dual-handle
  slider primitive.
- `frontend/src/components/app/WorstCaseHfBanner.tsx` (new).
- `frontend/src/components/app/FillProgressBar.tsx` (new) —
  thin progress bar for partial-filled lender offer rows.
- `frontend/src/components/app/GroupedLoansTable.tsx` (new) —
  grouped-by-source-offer view of Your Loans.
- `frontend/src/pages/CreateOffer.tsx` — advanced-mode wiring,
  partial-fills checkbox.
- `frontend/src/pages/OfferBook.tsx` — range render + fill
  progress in offer rows.
- `frontend/src/pages/Dashboard.tsx` — Flat / Grouped toggle
  on Your Loans.
- `frontend/src/pages/AcceptReviewModal` (in OfferBook) — match-
  preview surface, partial-fill capacity row.
- `frontend/src/i18n/locales/*.json` — `createOffer.range.*` +
  `partialFills.*` namespaces × 10 locales.
- `vaipakam-keeper-bot/src/detectors/offerMatcher.ts` (new) —
  matching detector with partial-fill support.
- `docs/UserGuide-Advanced.md` (10 locale variants) — explainer
  section on ranges + matching + partial fills.
- `docs/ReleaseNotes-…md` — functional write-up at land time.

---

## 14. Test plan

### 14.1 Contract tests

**Matching matrix:**
- ✓ Both sides identical (collapsed `min==max`) — match succeeds at
  the agreed value.
- ✓ Lender range fully contains borrower range — match at borrower's
  midpoint.
- ✓ Borrower range fully contains lender range — match at lender's
  midpoint.
- ✓ Partial overlap — match at midpoint of overlap.
- ✓ No amount overlap — `previewMatch` returns
  `(false, AmountNoOverlap)`; `matchOffers` reverts.
- ✓ No rate overlap — same shape with `RateNoOverlap`.
- ✓ Asset mismatch — reverts `AssetMismatch`.
- ✓ Lender's required collateral > borrower's offered — reverts
  `CollateralBelowRequired`.
- ✓ HF at matched amount < 1.5e18 (oracle moved) — reverts
  `HealthFactorTooLow`.
- ✓ Either offer accepted — reverts `OfferAccepted`.

**System-derived bound enforcement:**
- ✓ Lender sets `collateralAmount < minCollateralFloor` — `createOffer` reverts
  `MinCollateralBelowFloor`.
- ✓ Lender sets `collateralAmount == minCollateralFloor` — succeeds
  (boundary inclusive).
- ✓ Lender sets `collateralAmount > minCollateralFloor` — succeeds.
- ✓ Borrower sets `amountMax > maxLendingCeiling` — reverts
  `MaxLendingAboveCeiling`.
- ✓ Borrower sets `amountMax == maxLendingCeiling` — succeeds.
- ✓ Borrower sets `amountMax < maxLendingCeiling` — succeeds.

**Range validation:**
- ✓ `amountMin > amountMax` — reverts `InvalidAmountRange`.
- ✓ `amountMin == 0` — reverts (existing zero-amount check).
- ✓ Same for rate.
- ✓ `interestRateBpsMax > MAX_INTEREST_BPS` — reverts.

**Backward compat:**
- ✓ Existing `acceptOffer(offerId, consent)` against a range offer
  matches at the midpoint.
- ✓ Existing single-value tests still pass (collapsed-range path).

**Cancel cooldown:**
- ✓ `cancelOffer` immediately after `createOffer` reverts
  `CancelCooldownActive`.
- ✓ `cancelOffer` after warp 5 min + 1 sec succeeds.

**Refund:**
- ✓ Lender escrowed `amountMax`; match at `amount < amountMax`
  reduces lender's escrow custody by `amount` and leaves
  `amountMax − amount` for future matches.
- ✓ Borrower escrowed `collateralAmount`; match at
  `reqCollat < collateralAmount` refunds the delta to borrower
  escrow.
- ✓ Final match (dust close) refunds `amountMax - amountFilled`
  delta back to lender's escrow.

**Partial fills (lender side):**
- ✓ Three-match scenario per §10.7 worked example — verify
  per-match concrete amounts, `amountFilled` increments correctly,
  third match triggers dust-close.
- ✓ Match where `lenderRemaining < lender.amountMin` cannot
  occur — matchOffers reverts `AmountNoOverlap`.
- ✓ Per-match `reqCollateral` correctly pro-rated against
  `lender.collateralAmount × matchAmount / lender.amountMax`.
- ✓ Borrower's `collateralAmount > reqCollateral` excess refunds
  to borrower escrow at match time.
- ✓ Lender position NFTs: each partial match mints a fresh
  `lenderTokenId` to the lender's wallet, all independently
  transferable.
- ✓ Cancel partial-filled offer (`amountFilled > 0`):
  - existing loans live on (each ID still in storage)
  - refunds only `amountMax - amountFilled` to lender's escrow
  - flips `accepted = true`
  - storage slot retained (not deleted)
- ✓ Cancel cooldown: applies only when `amountFilled == 0`.
  Partial-filled cancel succeeds even immediately after the
  prior match.
- ✓ Match against partial-filled offer: each subsequent match
  picks midpoint of the SHRUNK overlap range based on
  `lenderRemaining`.
- ✓ Borrower offer always single-fill: `accepted = true` after
  one match regardless of any leftover amount-range gap.
- ✓ Refinance (per §10.10): `RefinanceFacet.refinance` against
  a range offer matches at midpoint, increments source offer's
  `amountFilled`, original loan closes, new loan opens.
- ✓ Preclose-offset (per §10.10): same shape via
  `PrecloseFacet.offsetViaOffer`.
- ✓ EarlyWithdraw a single loan from a partial-filled offer:
  closes only that loan, source offer + sibling loans
  unaffected.

### 14.2 Frontend tests

- ✓ Beginner-mode form submits `min == max` payloads.
- ✓ Advanced-mode dual-slider keeps min ≤ max.
- ✓ Partial-fills checkbox OFF collapses `amountMin == amountMax`
  on submit.
- ✓ Worst-case HF banner colour transitions at 1.5 / 2.0
  thresholds.
- ✓ Floor / ceiling pill turns red on violation.
- ✓ Offer Book renders single-value vs range correctly.
- ✓ Offer Book renders fill-progress bar on partial-filled
  lender offers; hides on zero-fill and on collapsed-range
  offers.
- ✓ Your Loans Grouped view collapses N loans from one source
  offer into an expandable card; expanded view matches Flat
  view's per-loan rows.
- ✓ Match preview shows pre/post `lenderRemaining` and dust-
  close indicator when applicable.

### 14.3 Bot tests

- ✓ Discovery loop finds matchable pair across two open offers.
- ✓ Discovery loop skips invalid pairs (would-revert via
  `previewMatch`).
- ✓ Discovery loop respects per-tick candidate cap.
- ✓ Discovery includes partial-filled lender offers (`accepted ==
  false && amountFilled > 0`) and computes overlap from
  `lenderRemaining`.
- ✓ Match priority prefers smaller-`lenderRemaining` lender
  offers when borrower has multiple matches.

### 14.4 E2E (testnet)

- Create lender range offer → create matching borrower offer → bot
  detects → bot calls `matchOffers` → loan goes Active.
- Same flow with prices oracle-drifting between create and match —
  match reverts cleanly.
- **Partial-fill happy path:** create lender range offer (1k–10k);
  create borrower offer A (3k); bot matches → loan #1, lender
  remaining 7k; create borrower offer B (5k); bot matches → loan
  #2, lender remaining 2k; create borrower offer C (2k); bot
  matches → loan #3, dust-close fires (remaining 0 < amountMin
  1k), offer goes accepted=true. Lender wallet shows 3 lender
  position NFTs.
- **Refinance against partial-filled offer:** loan #2 above gets
  refinanced via a fresh lender range offer; verify the
  refinancing offer's `amountFilled` increments and a new lender
  NFT mints.

---

## 15. Master kill-switch flags

Three governance-controlled boolean flags carve every Phase 1
mechanic into an independently-toggleable feature, so a bug or
unexpected economic dynamic in any one of them can be disabled
without rolling back the deploy. All three default to **disabled**
on a fresh deploy — the new mechanics are dormant until governance
explicitly flips them on. This matches the no-KYC / no-sanctions
pattern already established in `CLAUDE.md`'s "Retail-deploy policy."

### 15.1 The three flags

| Storage slot | Semantic | Effect when `false` |
|---|---|---|
| `s.rangeAmountEnabled` | Allow `amountMin < amountMax` on offer creation | `OfferFacet.createOffer` reverts unless `params.amountMin == params.amountMax` |
| `s.rangeRateEnabled` | Allow `interestRateBpsMin < interestRateBpsMax` | `OfferFacet.createOffer` reverts unless `params.interestRateBpsMin == params.interestRateBpsMax` |
| `s.partialFillEnabled` | Allow lender offers to be filled across multiple matches | `OfferFacet.createOffer` reverts on a lender offer where the post-validation `amountMin < amountMax` (which would otherwise enable partial fills); equivalently, every lender offer must be single-fill |

When all three flags are `false`, the new code paths are
operationally indistinguishable from the pre-Phase-1 codebase —
every offer is a single-value, single-fill offer; `matchOffers` is
still callable but only matches collapsed-range offers and never
auto-closes on dust because the lender's `amountMin == amountMax`
means the first match always exhausts capacity. The 1% LIF
matcher fee still applies to those single-match outcomes if the
match was submitted via `matchOffers` rather than `acceptOffer`.

### 15.2 Setters + roles

Three new `ConfigFacet` setters, all `onlyRole(ADMIN_ROLE)`:

- `setRangeAmountEnabled(bool)`
- `setRangeRateEnabled(bool)`
- `setPartialFillEnabled(bool)`

Three matching getters (`view`, no role) for the frontend:

- `rangeAmountEnabled() returns (bool)`
- `rangeRateEnabled() returns (bool)`
- `partialFillEnabled() returns (bool)`

Both surfaces extend the existing `ConfigFacet.getProtocolConfigBundle()`
view so the frontend `useProtocolConfig()` hook picks up the
flags as governance-mutable values alongside the existing fee
BPS / tier thresholds bundle (see §"Governance-config sweep" in
the 2026-04-29 release notes).

### 15.3 Frontend surface

Each flag drives a single conditional render on the Create Offer
page's Advanced mode:

- **`rangeAmountEnabled = false`** → the dual-handle amount
  slider collapses to a single numeric input (current behaviour);
  the form sets `amountMin == amountMax` on submit. No Advanced
  mode toggle for amount range.
- **`rangeRateEnabled = false`** → same shape for the rate
  slider.
- **`partialFillEnabled = false`** → the "Allow partial fills"
  checkbox (introduced for lender offers) is hidden; lender offer
  submission silently sets the offer's effective `amountMin ==
  amountMax` regardless of slider state. No "X / Y matches" badge
  on the Offer Book; no "Grouped by source offer" toggle on Your
  Loans.

Combined: when all three flags are off, the Advanced mode toggle
on Create Offer reveals only the existing keeper-access checkbox
+ the partial-repay opt-in checkbox (both pre-Phase-1 features).
The new range / partial-fill UI is wholly absent.

### 15.4 Phase 1 default-off rationale

Conservative defaults match the CLAUDE.md convention for
high-blast-radius runtime gates. Specifically:

1. **Audit-after-bake** policy means the contracts ship to
   testnet first and bake for ~2 weeks before the audit runs.
   Defaulting the new mechanics off means the bake exercises the
   single-value path (already audited in prior phases) end-to-
   end before anyone enables ranges or partial fills.
2. **Bot economics are unproven**. The 1% LIF matcher fee covers
   gas on L2s with thin margin (see design §"1% match fee
   mechanic"). If the bot economics turn out worse than projected
   in practice, governance can keep the flags off until a Phase 2
   fee revision lands.
3. **Symmetry between testnet + mainnet rollout**. Same default-
   off topology on both, eliminating the "works on testnet, not
   on mainnet" class of mismatch.

### 15.5 Storage cost

Three `bool` slots packed into the existing partly-empty config
slot in `LibVaipakam.Storage` — no new slot allocation required.
Per the codebase's append-only post-launch storage rule, the new
booleans go at the end of the `ProtocolConfig` struct or directly
on `Storage`; pre-launch reorder is fine.

### 15.6 Test coverage

`OfferFacetMasterFlags.t.sol` (new) covers:

- ✓ Each flag default-false on a fresh deploy.
- ✓ `createOffer` with `amountMin < amountMax` reverts when
  `rangeAmountEnabled = false`; succeeds when true.
- ✓ Same for `interestRateBpsMin < interestRateBpsMax` /
  `rangeRateEnabled`.
- ✓ Lender offer with `amountMin < amountMax` reverts when
  `partialFillEnabled = false` even if `rangeAmountEnabled = true`
  (i.e. partial fill is the strictest gate).
- ✓ Borrower offer ignores `partialFillEnabled` (Phase 1
  borrower offers are single-fill regardless).
- ✓ Setters revert with `AccessControl` error when called by
  non-admin.
- ✓ Combined matrix: all 8 combinations (`2^3`) of the three
  flags, plus a few edge cases at the boundary
  (`amountMin == amountMax` collapsed range with
  `rangeAmountEnabled = false` always succeeds).

---

## Sources & prior art

- Pendle's RFQ matching for yield tokens
- 1inch Fusion (range-order intent matching)
- LooksRare-style limit-order matching
- The Vaipakam codebase's existing keeper-bot patterns
  (`vaipakam-keeper-bot/src/detectors`)
- LayerZero hardening doc for the bot-architecture sibling
  pattern (this doc reuses the same monorepo-vs-separate-repo
  rationale)
