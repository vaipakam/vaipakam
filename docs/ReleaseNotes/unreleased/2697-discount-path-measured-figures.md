## Thread — The flash-loan discount path sizes itself from measured figures (#2697)

The keeper's flash-loan discount path used two placeholders: it took the
loan's debt to be its collateral amount, and its gas headroom to be a fixed
1e18 base units of the principal token, which is one token only for an
18-decimal principal. It also quoted the swap for the whole collateral,
whatever the liquidation would actually deliver. No chain has the
FlashLoanLiquidator deployed, so nothing moved, but the path could not be
armed usefully.

The platform now publishes a preview of the discounted liquidation, on the
forced-sale host beside the forced-sale preview: whether it can run (and if
not, the first reason it cannot), the debt the liquidator pays, the
collateral delivered and the surplus left for the borrower. The figures come
from one shared rule, which the liquidation itself now charges and seizes by,
so a reading inside the same transaction is exactly what the liquidation
does. The FlashLoanLiquidator reads that preview in the liquidating
transaction and flash-borrows exactly the debt, takes the loan's assets from
it rather than from its caller, clears its Diamond allowance after the call,
and sells exactly the collateral its swap was quoted for. Each run also names
the least profit it must keep, and the receiver reverts below it.

The keeper reads the preview, quotes the swap for the previewed seizure,
estimates the exact call (which simulates the whole run, including the real
flash-loan fee), and sets that least profit to the transaction's whole fee
converted by the Diamond into the principal token's own units. A loan the
preview rules out, a chain whose gas the keeper cannot value, or a trade
whose simulation reverts is skipped with its reason logged. The fee
measurement the auto-roll pass already used moved into one shared module so
both passes price gas by the same rule. The FlashLoanLiquidator's entry
points changed shape; it is deployed nowhere, so nothing needs migrating.
Closes #2697.
