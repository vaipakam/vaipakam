# Repayment record: the derivation (version `repayment-record/1`)

The repayment record counts what one address did on this platform as a
borrower or renter. It is not a score and not advice. Design:
[`DesignsAndPlans/RepaymentRecordDesign.md`](DesignsAndPlans/RepaymentRecordDesign.md).

```
GET https://<indexer origin>/repayment-record/{address}?chainId=<id>
```

Each network is read on its own. The app shows the total, with the line for
each network beneath it. Anyone can recompute every figure from the
platform's events using the rules below. A change to these rules raises the
version.

## Every answer carries

- `version`: the version of these rules.
- `asOf`: the block the index had reached when the figures were read.
- `historyBegins`: the deploy block of the contract the index follows on
  that network. Nothing before it is counted.
- `statements`: the four statements below. Every view of the record shows them.
- `excludes`: what the record leaves out.

The statements are:

- "This is a count of what this address did on this platform. It is not a score and not advice."
- "One person can use many addresses, and a new address has no record. An empty record says nothing bad."
- "Two addresses can lend to each other to build a record. The fees paid line shows what that would have cost."
- "Past repayment does not secure a loan. The collateral does."

## Who a figure counts for

A loan, an interest period or an interest payment counts for the address
that held the borrower position at the event's block time. That address is
the latest holder whose acquisition came at or before that time.

The index records each acquisition by its block time only, so nothing in
one block can be put in order. When the latest acquisition time is shared by
more than one address, or the latest acquisition falls in the event's own
block while an earlier holder exists (the event may have come before the
move), the holder is not guessed. A loan the address may have held at such a moment is counted under
`leftOut.holderUnresolved` and in no class, and an interest period or
payment at such a moment counts for no one.

A closed loan whose closing time the index does not hold is counted for the
current holder of its borrower position. A closed position keeps that holder
unless it is sent on.

A payment made by another address counts for the holder.

## The figures

| Figure | Counted from |
| --- | --- |
| `loans.closed` | token loans the address held when they closed |
| `loans.repaidOnTime` | a full `LoanRepaid` at a time not after its `lateFeeFrom`; without `lateFeeFrom`, one with no late fee made no later than the due date stated in `LoanInitiatedDetails`. A `LoanPreclosedDirect` is read the same way: it may land in the grace after the due date, and its late fee is the one the `LoanSettlementBreakdown` in its own transaction states. An `OffsetCompleted` states no late fee, so it is on time only when no later than the due date stated at the start |
| `loans.repaidAfterDue` | a full `LoanRepaid` after its `lateFeeFrom`; without `lateFeeFrom`, one that paid a late fee. Also a `LoanPreclosedDirect` whose breakdown states a late fee |
| `loans.repaidBySale` | `SwapToRepayExecuted`, `SwapToRepayIntentFilled`, `PrepayCollateralSaleSettled` |
| `loans.refinanced` | `LoanRefinanced` on the old loan. Counted once, here, and not also as repaid |
| `loans.liquidated` | `HFLiquidationTriggered`, `LiquidationDiscounted`, a `LiquidationFallback` with no default event in its transaction, or a fully matched internal liquidation (its `LoanStatusChanged` edge to InternalMatched) |
| `loans.defaulted` | `LoanDefaulted`, or `LoanFallbackPending` |
| `loans.unclassified` | a closed loan the rules above cannot place, or a full repayment, preclose or offset after the original due date with no late fee stated and no `lateFeeFrom` |
| `loans.openNow` | open loans whose borrower position the address holds now |
| `loans.openedByThisAddress` / `takenOverLater` | of the closed loans: whether the address was the first borrower |
| `interestPeriods.closedWithoutSale` | `PeriodicInterestSettled`, unless a collateral sale paid it |
| `interestPeriods.paidBySale` | `PeriodicInterestSettled` with a `SwapToRepayPartialExecuted` or `LoanPartiallyLiquidated` in the same transaction: the interest that closed the period came from selling collateral |
| `interestPeriods.collectedBySale` | `PeriodicInterestAutoLiquidated` |
| `interestPaid` | per token, the sum of `LoanInterestPaid` less `LoanInterestUndelivered`, in the token's own units. These two are stored without a loan reference (the payment event beside them carries it), so the loan is read from their own `loanId` |
| `rentals.*` | the same rules, for loans whose lent asset is an NFT. A rental is completed when it closed by a repayment route, and ended by default when it closed by a default or a liquidation. A daily rental paid in full closes with no `LoanRepaid`: its last deduction's transaction carries `AutoDailyDeducted` beside the status edge to Repaid, and that is its repayment route and its closing time |
| `firstLoanAt` | the first time the address held a borrower position |
| `leftOut.oneAddress` | loans this address held as borrower whose opening event named the same address as lender and borrower. They reach no other figure |
| `leftOut.openingPartiesUnknown` | loans this address held as borrower whose opening parties the index cannot establish. They reach no other figure and are never assumed to have two parties |
| `leftOut.holderUnresolved` | loans where a figure needed the holder at a moment the index cannot order against a change of holder in the same block, and this address could have been the holder (see "Who a figure counts for") |
| `feesPaid` | not stated yet. The events do not state each loan's initiation fee or the platform's share of each interest payment, so this figure is left out rather than guessed |

When a loan closes by a repayment route, that route decides its class, so a
loan cured out of the fallback and then repaid counts as repaid. Otherwise
the first event that began the forced close decides, counted from after the
last cure out of the fallback (`LoanCuredFromFallback`): a fallback cured by
added collateral does not decide a later default or liquidation.

## Left out

- The vehicle loans that a lender's sale creates.
- A loan whose opening event named the same address as lender and borrower,
  and a loan whose opening parties the index cannot establish. This is the
  one counting rule for every public figure ([`PublicDataFeed.md`](PublicDataFeed.md),
  "How the figures count"). Each is counted under `leftOut`, not in a class.
  The test reads the opening event only, so a later sale or handover moves a
  loan neither in nor out. It sees one address on both sides only; two
  addresses of one person are the case the record's third statement names.
- Loans on other networks.
- Anything before `historyBegins`.
- Anything outside this platform.
