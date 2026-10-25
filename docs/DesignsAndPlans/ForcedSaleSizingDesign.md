# Forced-Sale Sizing — Design (#2796, #2795)

Status: **design, approved rule; implementation not started.**
Owner decisions: 2026-10-25 (recorded below). Delivery: one shared self-call
host, the periodic settlement (#2795) as its first user.

This builds on a survey of how each forced path sizes and splits a sale
today, the alternatives weighed, and worked examples, prepared for the owner
on 2026-10-25. The rule below is the one the owner chose from it.

## 1. Decisions recorded

| When (UTC) | Question | Owner's answer |
| --- | --- | --- |
| 2026-10-25 01:14 | Where should the extra from a periodic settlement sale go? | **Pay it back to the borrower.** An unflagged current borrower is paid to their wallet; a flagged borrower's extra is held for them in their vault and paid with their claim at loan end. |
| 2026-10-25 01:26 | Adopt one sell-to-need rule for every forced sale? | **Yes, charges on the debt.** One shared host. The handling fee is 2% of what is owed and the keeper bonus up to 3% of what is owed. Spec lines on the charge base move to the debt. #2795 is the host's first user. |
| 2026-10-20 (standing) | Liquidation priority | The lender is made whole as far as the position allows; the borrower's share comes second. |

Prelive rule (standing): fresh deploys only, no legacy shims.

## 2. Scope

**In scope — the sell-to-need rule and the charge rule:**

- HF liquidation, single route (`RiskFacet.triggerLiquidation`).
- HF liquidation, split route (`RiskSplitLiquidationFacet.triggerLiquidationSplit`).
- Time-based default, liquid branch (`DefaultedFacet`).
- Periodic-interest settlement (`RepayPeriodicFacet._autoLiquidatePeriodShortfall`).

**In scope — the charge rule only:** partial liquidation
(`RiskFacet.triggerPartialLiquidation`). The keeper still chooses the fraction
sold; only the fee and bonus base change (§6).

**Out of scope, unchanged:**

- The discounted liquidation and the internal match. A buyer pays the debt
  and takes collateral; the residual already stays encumbered in the
  borrower's vault.
- The fallback (every adapter failed) and its claim-time retry. Fallback
  entry takes the whole collateral exactly as today (§5.4), and the retry
  sells the fallback snapshot under its own rules. Those rules already state
  their charges on the lending-asset amount (spec "retry-failed" lines), the
  same base this design adopts.
- The voluntary swap-to-repay routes. They already sell to need; they only
  move onto the generalised sizing function (§7.2), with their own slippage
  cap, so their behaviour does not change.

## 3. The rule

Symbols, all in the loan's lending asset unless stated:

| Symbol | Meaning |
| --- | --- |
| `D` | What the sale must pay the lender. Terminal paths: the loan's current borrow balance plus late fee, exactly the figure the waterfall uses today. Periodic: the period's shortfall `S`. |
| `f` | Handling-fee rate, `cfgLiquidationHandlingFeeBps` (2%). |
| `bMax` | Largest keeper-bonus rate: `cfgMaxLiquidatorIncentiveBps` (3%), lowered by the collateral's per-asset `liqBonusBps` ceiling when one is set. |
| `cap` | Slippage cap, `cfgMaxLiquidationSlippageBps` (6%). |
| `C` | Collateral the sale may draw on: the loan's collateral. |

### 3.1 Need and sizing

- **Charges on the debt.** Fee `F = f × D`. Bonus `B = b × D`, where `b` is the
  execution-quality rate of §3.3. So the most a forced sale can charge is
  `(f + bMax) × D`, a figure the app can state before the sale.
- **Need** `N = D + ⌈f × D⌉ + ⌈bMax × D⌉`. Rounded up so the need always
  covers what is paid out.
- **Size.** Sell the least collateral `x ≤ C` whose worst-case proceeds — the
  oracle value of `x` less `cap` — cover `N`. This is exactly the inversion
  the voluntary swap-to-repay already uses (`LibSwapToRepaySizing.sizeSale`),
  generalised to take the slippage cap as a parameter (§7.2).
- **Minimum output.** The adapter floor passed to the swap is the worst-case
  proceeds of `x`, which is `≥ N`. So a filled sale always pays the lender
  in full and never executes beyond the slippage cap. (The issue text says
  "minimum output = the need"; the floor of `x` is the need rounded up to
  the least whole collateral unit, so it honours that and the cap together.)

### 3.2 Covered and uncovered sales

- **Covered** — a covering `x ≤ C` exists. The sale sells `x`. The collateral
  not sold, `U = C − x`, is never touched by the sale.
- **Uncovered** — even all of `C` cannot cover `N` at the slippage floor (the
  position is underwater on the need, or nearly so). The sale sells all of
  `C` with today's floor (oracle value of `C` less `cap`). The settlement
  event says the sale was uncovered and states every figure (§8).

### 3.3 Bonus rate

`b` is today's shared curve, `LibEntitlement.liquidatorIncentiveBps`:
`cap − realized slippage`, capped at `cfgMaxLiquidatorIncentiveBps` and at the
per-asset `liqBonusBps`. Realized slippage is measured against the oracle
value of what was actually sold. The periodic path stops carrying its own copy
of the curve (which lacked the per-asset ceiling): every path reads the one
helper.

Unchanged per-path caller rules: the HF paths apply the liquidator KYC check
to the bonus; the time-based default withholds the bonus from a sanctioned
caller (it stays in the waterfall); the periodic settler is a Tier-1 caller
and a sanctioned one is refused before anything moves.

### 3.4 The waterfall — one rule for both cases

With realized proceeds `P`:

1. **Bonus** `B = b × min(D, P)` to the caller. Paid first, also on an
   uncovered sale (spec: the bonus is the keeper liveness incentive). The
   `min` keeps the charge on the debt from ever exceeding the same share of
   what the sale actually raised.
2. **Lender** `L = min(D, P − B)`. Terminal paths split `L` into principal and
   recovered interest and take the ordinary treasury cut on the interest
   exactly as today (`splitTreasury` + the lender-yield fee resolve).
3. **Handling fee** `F = min(f × D, P − B − L)`. Subordinated to the lender:
   taken only from what is left after the lender is whole, zero on an
   uncovered sale that leaves nothing. (Today the periodic and partial paths
   do not subordinate the fee; this fixes both.)
4. **Borrower extra** `X = P − B − L − F`.

On a covered sale `P ≥ N ≥ D + F + B`, so steps 1–3 pay `B = b × D`,
`L = D` and `F = f × D` in full and `X ≥ 0` is the upside above the worst case
— the slippage that did not happen. The borrower pays the realized slippage
plus at most `(f + bMax) × D`, never charges on collateral the debt did not
need.

### 3.5 Worked example (from the survey)

1,000 USDC debt, WETH at $2,000, 2 WETH collateral, 6% cap, 0% slippage.
Need `N = 1,000 + 20 + 30 = 1,050`. The least sale whose 94% floor covers
1,050 is 0.5585 WETH ($1,117). Proceeds 1,117: keeper 30, lender 1,000,
treasury 20, borrower extra 67 USDC, and 1.4415 WETH never sold. Today the
same default sells both WETH and leaves the borrower 2,800 USDC with no WETH,
having paid 120 + 80 in charges on collateral the debt did not need.

## 4. Where the borrower's share goes

### 4.1 Terminal paths (HF single, HF split, time-based default)

The same claim shape the voluntary full swap-to-repay already uses, which
`ClaimFacet.claimAsBorrower` already pays:

- **Unsold collateral `U`** stays in the stored borrower's vault under the
  loan's collateral lien. `borrowerClaims` names it (collateral asset,
  amount `U`). The current borrower-position holder takes it with
  `claimAsBorrower`.
- **Extra proceeds `X`** are credited into the stored borrower's vault with
  `depositLocked` (a forced flow acts on what arrived) and recorded in
  `borrowerSurplusClaims` for the current holder, VPFI-encumbered as today.
  `claimAsBorrower` pays it as the second lane it already reads.
- A covered sale that sells exactly all of `C` leaves `U = 0`: the
  collateral row is written as already claimed, exactly as today's
  zero-surplus row.

### 4.2 Periodic settlement (the loan stays Active)

Owner decision (A):

- **Unflagged current holder** of the borrower position: `X` is paid to their
  wallet. The payment is a **measured, non-reverting attempt**: a self-call to
  the host that pays with `LibDelivery.pushExact` (a wallet reading is trusted
  only to refuse). If that attempt reverts for any reason — a token blacklist
  on the address, a short reading, a receiving hook — it unwinds alone and
  the extra falls through to the held route below. A forced settlement never
  depends on the borrower's wallet.
- **Flagged holder** (`mustFreezeParty`, fail-closed), **or a failed wallet
  attempt**: `X` is credited into the stored borrower's vault
  (`depositLocked`), added to the loan's `borrowerSurplusClaims` row,
  encumbered for the borrower side, and — for a flagged holder only — the
  frozen claimant is recorded. It is paid at loan end through
  `claimAsBorrower`, like a terminal surplus.

**One held row per loan.** `borrowerSurplusClaims[loanId]` becomes a running
total: every writer ADDS to it (the periodic held route, the terminal
surplus, the existing swap-to-repay surplus freeze). Today's single writer
(`LibCloseoutFreeze.freezeOrPayBorrowerSurplus`) overwrites; that is safe only
because it runs once at a terminal. Making it additive is what lets several
periodic settlements and a terminal surplus share the row the claim already
pays. **No new Storage field is needed** (an earlier sketch of decision (A)
assumed a borrower twin of `heldForLender`; the existing row does that job
once it accumulates). The asset is always the loan's lending asset, so the
row never mixes assets.

### 4.3 Interest bookkeeping on the periodic path

The lender is credited exactly what arrived, at most `S`, and
`interestSettled` rises by that amount. No proceeds above `S` reach the lender
any more, so the over-delivery credit to `interestSettled` (the #1230 round-2
case) is removed rather than carried forward. On an uncovered sale the unpaid
part of `S` stays owed and the existing checkpoint rules (paid-through mark
only on full coverage) are unchanged.

## 5. Collateral movement, liens and the fallback

### 5.1 Terminal paths

1. Size first (oracle math only; nothing moves). A missing or distrusted
   price behaves as today: the sale cannot be quoted and the path takes its
   existing branch.
2. Decrement the collateral lien by `x` and pull only `x` to the Diamond
   (`LibSanctionedLock.pullToDiamond`, move-out exempt, acts on what
   arrived). Re-stamp VPFI.
3. Sell with failover through the host.
4. **Filled:** run the waterfall (§3.4), book §4.1. The lien left on the vault
   equals `U`, exactly what `borrowerClaims` names, as after a full
   swap-to-repay.
5. **Every route failed:** release the remaining lien, pull the remaining
   `C − x` too, and enter the fallback with the whole collateral on the
   Diamond. `FallbackCustodyFacet.enterFallback` is unchanged: it still finds
   all of `loan.collateralAmount` on the Diamond and returns it to the vault
   under its own row.

Uncovered sales take steps 2–5 with `x = C`.

The quote and the adapter floor use what actually reached the Diamond
(#2440). For the tokens the protocol supports that is always `x`. If a token
delivered less, the floor of what arrived may fall below `N`; the sale is
then treated as uncovered (sell what arrived, the lender is paid first), and
the event says so.

### 5.2 Periodic path

As today, minus the buffer arithmetic: decrement the lien by `x`, withdraw
`x` (`vaultWithdrawDelivered`), sell through the host, reduce
`loan.collateralAmount` by what left the vault. A failed sale reverts
`PeriodicSettleSwapFailed` and nothing moves (unchanged).

### 5.3 What the lender and borrower can see

Every settlement emits one event from the host with all the figures (§8),
including whether the sale was covered. Nothing is left to be inferred from
balance changes.

### 5.4 Why the fallback stays whole-collateral

The fallback exists because no route could sell. Its split gives the lender
collateral worth the debt first (lender-first) and the borrower the rest; it
already charges on the lending-asset amount. Sizing it to need would change a
rule that is not part of this decision, so it stays as it is.

## 6. Partial liquidation — charge rule only

The keeper still picks the collateral fraction and the sale still sells that
slice. With proceeds `P`, the amount repaid is
`R = ⌊P × BPS / (BPS + b + f)⌋`, the bonus `B = b × R` and the fee
`F = P − R − B` (so `F ≈ f × R`, rounding to the treasury). `R` repays interest
then principal, as today. The fee is a charge on what was repaid rather than a
share of proceeds taken alongside it, which is the subordination fix for this
path: the lender always receives `R` and the charges together are at most
`(f + bMax) × R`.

## 7. Architecture

### 7.1 One self-call host: `ForcedSaleFacet`

The SwapAttemptFacet / TreasuryFeeFacet pattern. `address(this)`-gated, no
`nonReentrant` of its own (every caller holds the Diamond guard). It carries:

- **`sellToNeed(order)`** — sizes (or takes the uncovered branch), runs the
  failover through `LibSwap` (each attempt still goes through
  `SwapAttemptFacet.swapAttempt`), pays the bonus to the caller and the
  subordinated fee to the treasury (`transferToTreasury`), and returns the
  outcome: covered, collateral sold, proceeds, lender amount, fee, bonus,
  borrower extra. On total failure it returns `ok = false` with nothing
  paid, so each caller keeps its own failure branch (fallback or revert).
- **`bookTerminal(loanId, outcome)`** — the identical terminal booking the HF
  single route, the split route and the default share today: treasury
  interest cut, lender `depositLocked` + `lenderClaims` (+ VPFI encumbrance),
  borrower rows of §4.1.
- **`bookPeriodic(loanId, outcome, boundary)`** — pays the lender through
  `EncumbranceMutateFacet.freezeOrPayActiveLenderResident` (unchanged), credits
  `interestSettled`, and routes `X` per §4.2.
- **`tryPayBorrowerWallet(asset, to, amount)`** — the self-called, revertible
  wallet attempt of §4.2.
- **`previewForcedSale(loanId, kind)`** (view) — `D`, `N`, `x`, the adapter
  floor and whether the sale is covered, so a keeper builds adapter calldata
  for exactly `x`.

Each caller keeps its preconditions, its pull, its failure branch, its
terminal transition, NFT status, rewards and its own lifecycle event. The
waterfall code leaves RiskFacet (about 67 bytes of headroom), the split
facet, DefaultedFacet and RepayPeriodicFacet.

### 7.2 One sizing function

`LibSwapToRepaySizing.sizeSale` becomes the general inversion with the
slippage cap as a parameter (a renamed library, e.g. `LibSaleSizing`, so the
name stops saying "swap-to-repay"). The two swap-to-repay routes pass
`cfgMaxSwapToRepaySlippageBps`; the forced paths pass
`cfgMaxLiquidationSlippageBps`. One audited inversion, two caps.

### 7.3 Refresh-together family

`ForcedSaleFacet` + `RiskFacet` + `RiskSplitLiquidationFacet` + `DefaultedFacet`
+ `RepayPeriodicFacet` + `ClaimFacet` (additive surplus row). A caller
refreshed without the host reverts `FunctionDoesNotExist` on every forced
sale (a hard revert, never a silent old waterfall). Fresh deploy only
(prelive). All facet-registration sites of CLAUDE.md "When you add a facet"
apply.

## 8. Events

The host emits one event per sale, with every figure:

`ForcedSaleSettled(loanId, kind, debt, need, collateralSold, proceeds,
lenderPaid, handlingFee, keeperBonus, borrowerExtra, borrowerExtraHeld,
collateralUnsold, covered, keeper)`

`borrowerExtraHeld` says whether the extra was paid to the wallet or held.
The per-path lifecycle events stay. `PeriodicSlippageOverBuffer` is removed:
on a covered sale the lender is always paid `S`, and an uncovered one is
stated by `covered = false` with the amounts. `PeriodicInterestAutoLiquidated`
keeps its role and gains the borrower extra. The indexer's event-coverage
check, the keeper-bot ABI sync and the frontend ABI export follow the event
change.

## 9. Keeper, indexer and app

- **Keepers must quote the sized amount.** Aggregator calldata (0x, 1inch)
  encodes the sell amount. A keeper that keeps quoting the whole collateral
  builds calldata for the wrong amount; the attempt fails and, on the terminal
  paths, every failed route ends in the fallback. So the keeper change
  (quote `previewForcedSale`'s `x`) must reach a chain no later than the
  contracts. The reference keeper and the hosted keeper belong to the keeper
  thread; this design hands it that requirement and the preview getter.
- **Keeper incentive shrinks** on healthy loans (the bonus base is the debt,
  not all the collateral: 30 instead of 120 in §3.5). Worth watching for very
  small loans on chains with costly gas; no rule change is proposed.
- **Indexer:** new event, changed periodic event.
- **App:** the forced-close surfaces name no amount today and need no change
  for correctness. Any surface that explains liquidation charges states the
  new rule (charges at most 5% of what is owed; unsold collateral and the
  upside return to the borrower).

## 10. Spec changes (with this design)

`docs/FunctionalSpecs/ProjectDetailsREADME.md`, in the same PR as this note:

- The liquidator-incentive rule (`6% − realized slippage`): capped at 3%, and
  at the per-asset ceiling, **of what is owed**, never more than that share of
  what the sale raised.
- The two handling-charge statements (the liquidation rules and **Liquidation
  Handling Charge**): 2% **of what is owed**, subordinated to full lender
  recovery.
- The periodic settlement rules: the sale sells the least collateral whose
  worst-case proceeds cover the shortfall plus the largest charges; the extra
  goes back to the borrower (wallet, or held when flagged or when the wallet
  payment fails).
- **Proceeds Distribution**: unsold collateral and extra proceeds go to the
  borrower and the settlement states both.
- A new rule, **Forced Sales Sell Only What the Debt Needs**, ahead of the
  existing exact-sale rule (which still governs the amount offered).

`docs/DesignsAndPlans/PeriodicInterestPaymentDesign.md` §4.3 points here for
the sale sizing and the split.

## 11. Tests (targeted, per PR)

Periodic (#2795, first PR):

- Zero slippage: lender gets exactly `S`, fee `2% S`, bonus `3% S`, borrower
  extra `> 0` paid to the wallet.
- Slippage at the cap: lender exactly `S`, bonus 0, extra about 0.
- Output below the floor on every route: revert, nothing moves.
- Collateral below the need: sells everything, `covered = false`, the
  waterfall pays the lender first and the unpaid part stays owed.
- Flagged holder: extra held, row accumulates across two settlements, paid by
  `claimAsBorrower` at loan end.
- Wallet push reverts (blacklisting token mock): extra held, settlement
  succeeds.
- Per-asset bonus ceiling applies on the periodic path.
- `interestSettled` rises by what the lender received, never above `S`.

HF single/split and default (later PRs): covered sale leaves `U` liened and
claimable; extra in the surplus row; uncovered sale matches today's
waterfall with the fee subordinated; all-routes-fail enters the fallback with
the whole collateral on the Diamond; sanctioned default caller earns no bonus;
partial liquidation charge rule.

## 12. Delivery order

1. This design note + spec (docs only).
2. `ForcedSaleFacet` + generalised sizing + periodic onto the host (#2795).
3. HF single + split onto the host.
4. Time-based default onto the host; partial liquidation charge rule.

Each PR refreshes its whole family. None reaches a chain before all waves
are done (standing rule), and the keeper change (§9) lands with or before
the first chain that carries them.
