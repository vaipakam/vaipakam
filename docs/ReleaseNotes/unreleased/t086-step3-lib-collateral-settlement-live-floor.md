## T-086 step 3 — `LibCollateralSettlement.liveFloor` closed-form floor formula

Step 3 of `docs/DesignsAndPlans/NFTCollateralSaleAndAuction.md` §13. Introduces a small math library that returns the minimum aggregate sale price for a Seaport prepay collateral listing at any timestamp. The library is the source of truth the upcoming `CollateralListingExecutor` (step 5) will call from both:

- the **ERC-1271 sign-time delegate** — to refuse signing a listing whose total consideration is below the live floor;
- the **Seaport zone `validateOrder` callback at fill time** — to defend against the `Seaport.validate()` pre-registration attack (per design doc §5.7, which would otherwise let an attacker pre-validate a stale order and skip the ERC-1271 callback).

### What the library exposes

Three view helpers in `contracts/src/libraries/LibCollateralSettlement.sol`, each `internal view` reading from `LibVaipakam`'s storage slot:

| helper | maps to | computes |
|---|---|---|
| `principalPlusAccruedInterest(loanId, asOfTimestamp)` | Seaport `consideration[0]` (lender) | `loan.principal + LibEntitlement.accruedInterestToTime(loan, asOfTimestamp)` |
| `treasuryAndPrecloseFee(loanId, asOfTimestamp)` | Seaport `consideration[1]` (treasury) | `accruedInterest × (treasuryFeeBps + precloseFeeBps) / 10_000` |
| `liveFloor(loanId, asOfTimestamp)` | floor that the order's total consideration must equal-or-exceed | sum of the above |

The borrower's residual (`consideration[2]`) isn't computed here — it's the executor's `askPrice − liveFloor`, derived from the signed order at fill time.

### Reuses existing math; introduces no new accrual model

The accrued-interest helper is `LibEntitlement.accruedInterestToTime` — the same per-whole-day-rounded function `RepayFacet`, `PrecloseFacet`, `RefinanceFacet`, and `PartialWithdrawalFacet` already call. Same rounding model = no off-by-one drift between the floor we sign + the obligation those facets credit on a parallel proper close. The treasury-fee bps routes through `LibVaipakam.cfgTreasuryFeeBps()` (so the 0-means-default-100 fallback contract is preserved verbatim).

### `precloseFeeBps` summand is currently zero, structurally complete

The formula in design doc §5.2 reads `treasuryFeeBps + precloseFeeBps`, but `cfgPrecloseFeeBps()` doesn't exist in `LibVaipakam` yet — there's no preclose-specific fee in production. To keep this PR narrowly scoped to the math library, `treasuryAndPrecloseFee` writes the formula with an explicit `precloseFeeBps = 0` local. Step 5 (executor) adds the config getter + setter and drops the constant `0` for the live read — a one-line change with no surrounding shape impact.

### Test coverage

`contracts/test/LibCollateralSettlementTest.t.sol` exercises:

- **Day-zero**: at `asOfTimestamp == loan.startTime`, accrued is 0, lender leg is principal exactly, fee leg is 0, `liveFloor == principal`.
- **Pre-startTime fill timestamp**: `accruedInterestToTime` returns 0; floor collapses to principal (defensive — production Seaport ordering means this never happens, but the math must still be sensible).
- **Interest accrual**: 10 days at 12% APR on 100_000e18 principal produces ~328.767e18 accrued (hand-computed against the integer-arithmetic formula), and the floor matches `principal + accrued + accrued × 100bps / 10000`.
- **Sub-day rounding**: 23h 59m elapsed → 0 accrued (per-whole-day rounding flows through correctly).
- **Monotonicity**: across 6 timestamps over the loan's 30-day term, the floor is non-decreasing — the executor's design relies on this invariant for the "fill-time floor ≥ sign-time floor" property the 2% buffer compensates for.
- **Treasury fee override**: a `setTreasuryFeeBpsRaw(500)` (5%) bumps the fee leg accordingly; a `setTreasuryFeeBpsRaw(0)` falls back to the 1% constant default (the `cfgTreasuryFeeBps` contract).
- **Edge cases**: zero principal → floor = 0; zero rate → floor stays at principal forever.
- **Cross-loan isolation**: a 2× principal loan produces exactly 2× floor at the same timestamp (linear-in-principal sanity check).

The tests use four new view proxies on `TestMutatorFacet` (`getLiveFloor`, `getPrincipalPlusAccruedInterest`, `getTreasuryAndPrecloseFee`) plus a `setTreasuryFeeBpsRaw` direct-write helper — same pattern as the PR #282 lock-state testing scaffolding. `HelperTest._getTestMutatorFacetSelectors()` selector array grows 70 → 74.

### What this PR does NOT do

- No executor / facet wiring — that's step 5 (`CollateralListingExecutor` ERC-1271 + Seaport zone) and step 6 (`NFTPrepayListingFacet`).
- No `cfgPrecloseFeeBps()` getter or `ProtocolConfig.precloseFeeBps` field — deferred to step 5 with the executor that consumes it.
- No Seaport order construction — also step 5.

The library is a self-contained mathematical primitive; the executor is the consumer.
