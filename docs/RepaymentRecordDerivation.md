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

A closed loan whose closing time the index does not hold is counted for the
current holder of its borrower position. A closed position keeps that holder
unless it is sent on.

A payment made by another address counts for the holder.

## The figures

| Figure | Counted from |
| --- | --- |
| `loans.closed` | token loans the address held when they closed |
| `loans.repaidOnTime` | a full `LoanRepaid` at a time not after its `lateFeeFrom`; without `lateFeeFrom`, one with no late fee made no later than the due date stated in `LoanInitiatedDetails`. Also `LoanPreclosedDirect` and `OffsetCompleted`, which close before the due date by the contract's own rule |
| `loans.repaidAfterDue` | a full `LoanRepaid` after its `lateFeeFrom`; without `lateFeeFrom`, one that paid a late fee |
| `loans.repaidBySale` | `SwapToRepayExecuted`, `SwapToRepayIntentFilled`, `PrepayCollateralSaleSettled` |
| `loans.refinanced` | `LoanRefinanced` on the old loan. Counted once, here, and not also as repaid |
| `loans.liquidated` | `HFLiquidationTriggered`, `LiquidationDiscounted`, a `LiquidationFallback` with no default event in its transaction, or a fully matched internal liquidation (its `LoanStatusChanged` edge to InternalMatched) |
| `loans.defaulted` | `LoanDefaulted`, or `LoanFallbackPending` |
| `loans.unclassified` | a closed loan the rules above cannot place, or a full repayment after the original due date with no late fee and no `lateFeeFrom` |
| `loans.openNow` | open loans whose borrower position the address holds now |
| `loans.openedByThisAddress` / `takenOverLater` | of the closed loans: whether the address was the first borrower |
| `interestPeriods.closedWithoutSale` | `PeriodicInterestSettled` |
| `interestPeriods.collectedBySale` | `PeriodicInterestAutoLiquidated` |
| `interestPaid` | per token, the sum of `LoanInterestPaid` less `LoanInterestUndelivered`, in the token's own units |
| `rentals.*` | the same rules, for loans whose lent asset is an NFT. A rental is completed when it closed by a repayment route, and ended by default when it closed by a default or a liquidation |
| `firstLoanAt` | the first time the address held a borrower position |
| `feesPaid` | not stated yet. The events do not state each loan's initiation fee or the platform's share of each interest payment, so this figure is left out rather than guessed |

When a loan closes by a repayment route, that route decides its class, so a
loan cured out of the fallback and then repaid counts as repaid. Otherwise
the first event that began the forced close decides.

## Left out

- The vehicle loans that a lender's sale creates.
- Loans on other networks.
- Anything before `historyBegins`.
- Anything outside this platform.
