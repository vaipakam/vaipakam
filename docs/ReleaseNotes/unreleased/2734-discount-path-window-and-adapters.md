## Thread — Discounted liquidation respects the internal-match window and sells only through governed venues (PR #2898)

The liquidator-buys-at-discount route now waits for an internal match the
same way the other external liquidation routes do. While the internal-match
switch is on and a loan's loan-to-value sits inside the priority band just
above its liquidation threshold, the full, partial and split liquidations
already declined to sell collateral outside the protocol; the discount route
did not check at all. All four routes now ask one shared rule, so they cannot
disagree on where the band starts or ends, and the discount route's preview
reports "inside the internal-match window" as its reason, so a keeper never
plans a run the platform would refuse. The preview's new reason is added
after the existing ones, so the existing reason numbers do not change.

The flash-loan liquidator contract the keeper uses for that route no longer
approves or calls whatever addresses an off-chain quote names. It sells the
seized collateral through one of the swap adapters the platform itself has
registered and not disabled, the same governed venues the platform's own
liquidations sell through. It approves only that adapter, for exactly the
amount sold, and clears the approval afterwards. The adapter applies its own
rule to the quote (for an aggregator, a fixed approval recipient and an
allow-listed call target), so a bad or hostile quote can no longer take the
contract's tokens. The adapter is asked for at least the flash loan, its fee
and the run's least profit, and the contract still checks its own balance
after the run. The completion event now reports the collateral the adapter
actually took, since an adapter returns any part it did not sell.

Funds: the lender was always paid by the platform first, so the exposure this
closes was the keeper's own profit and standing balance, never a borrower's
or lender's funds. The discount route is off on every chain today and the
flash-loan liquidator is not deployed anywhere, so nothing live changes. The
liquidator's entry points now take an adapter and that adapter's quote bytes
instead of a call target, an allowance target and calldata, so the keeper's
caller changes with it before the route is ever switched on; that keeper
change, and the keeper's sizing fix, are tracked under #2697.

Part of #2734 (its two contract items; the third is the keeper's #2697).
