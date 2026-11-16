# Protected mode: the Ready balance — design note (#3344)

**Status:** building, 2026-11-16, on the recommended option of the decision
card in the desktop thread ("gate plus Ready"). Owner rules: the #3344 issue
body and its three owner comments of 2026-11-08 (minimal v1, presets in the
app, rule 4 changed). Ships by fresh deploy.

## 1. What the code does today, and the gap

Protected mode makes a payout to a wallet wait the account's delay
(`LibProtectedAccount.gate`, the payout queue). It does **not** make a
protocol use of vault funds wait. A protected account can sign a vault-backed
offer or borrow on the instant market against collateral already in its vault
at once; only a lock (`requireCanOpen`) stops it. #3344 was written on the
premise that every use waits the delay, so Ready on its own would cap nothing.

This design adds that rule and Ready together: **a protected account's own
action may spend its existing vault balance on a protocol step at once only
out of its Ready balance.** Everything else in the vault is the Protected
balance and reaches a protocol step only after moving into Ready, which waits
the delay.

## 2. Which spends the rule covers (scouted 2026-11-16)

Most protocol entry points take the money from the caller's wallet in the
same call (create, accept, add collateral, repay, preclose, fund an intent or
an extension reserve). That is new money, and new money is instant, as rule 1
of the issue says. They are unchanged.

The owner's own spends of **existing free vault balance** are exactly the
places the depository ledger is debited by `LibDepositoryLedger.spend`, plus
the instant market's collateral sizing:

| Spend | Where | Under the rule |
| --- | --- | --- |
| Vault-backed signed offer (signed accept, signed match, signed collection fill) | `OfferMaterializeFacet._materializeSignedOffer`, vault branch | Must come from Ready; consumes it |
| Instant-market borrow, collateral already in the vault | `InstantFillFacet._fundCollateral` (sizing) then the same materialize branch | Only Ready counts as available; the rest is pulled from the wallet |
| Auto-extension charge beyond the loan's reserve | `AutoLifecycleFacet._routeInterest` | Must come from Ready (it is a payment on the holder's own loan, an allowed instant use); consumes it |

Not covered, with the reason:

- **Re-committing a loan's own proceeds to the intent it came from**
  (`rollIntentLoan`, `recommitHeldToIntent`) and an intent fill or takeover
  drawing intent capital: the money is already committed to that intent; no
  new exposure is opened. v1 does not roll returns into Ready (owner comment 1).
- **Obligation transfer, refinance carry-over, swap-to-repay intent:** they
  move collateral already locked under an offer or a loan.
- **VPFI paid from the vault as a fee** (yield-fee discount, full tariff): a
  fee on a settlement, bounded by the fee; not a position.
- **Collection slices:** drawn from the parent's escrow, which was funded from
  the wallet.

## 3. The rules as built

1. **Ready is a tag on free balance, not a lien.** Per account and asset, the
   Diamond stores a Ready amount. What counts is
   `min(stored Ready + a matured pending top-up, the account's free balance)`,
   and it counts as zero when the account is not protected, is locked or
   retired, the vault's protection epoch has moved since Ready was set (a
   lock, a switch-off or a replacement), or the idle expiry has passed.
2. **Protected → Ready waits the delay.** `requestReadyTopUp(asset, amount)`,
   by the account, records one pending top-up per asset that counts after the
   delay in force when asked. A new request replaces the pending one. The
   account or any active signer may cancel it (`cancelReadyTopUp`). It dies
   with the epoch. It needs no finalize step: it counts lazily from its time,
   and the next write folds it in.
3. **Ready → Protected is instant** (`releaseReady`), by the account or any
   signer, because it only tightens.
4. **Wallet → Ready is instant** (`depositToReady`): the deposit is credited
   to the vault and the depository ledger like any deposit, then tagged Ready.
5. **Ready never pays a wallet.** The depository withdraw of a protected
   account is bounded by its free balance minus Ready; Ready reaches a wallet
   only after `releaseReady`, then the normal delayed payout.
6. **Spends.** The three spends in section 2 take Ready first and fail
   (`ReadyBalanceShort`) or pull from the wallet (instant market) for the rest.
   The existing loan checks still apply; unpriced collateral stays refused by
   the risk-access tiers (rule 4 as changed).
7. **Lock and replacement.** A lock zeroes Ready while locked and voids it and
   any pending top-up for good (the lock moves the epoch); a replacement and a
   switch-off do the same. This is stricter than "freeze": after an unlock the
   owner tops up again through the delay. Reason: a lock usually means a key
   is suspected, and Ready is exactly what a stolen key could spend.
8. **Idle expiry (optional).** `setReadyIdlePeriod(seconds)`: 0 is off, else
   1–30 days. Turning it on or shortening it is instant; lengthening it or
   turning it off waits the delay (lazy, epoch-bound). Each top-up, each
   matured top-up folded in, and each spend sets "ready until" to now plus the
   period. Past it, Ready counts as zero with no transaction. The owner may
   extend "ready until" at once, to at most 30 days from now
   (`extendReadyUntil`). v1 has no settle step and no keeper: the expiry is
   read lazily, so safety never depends on a call. The `ReadyUntilSet` event
   carries every deadline, so an indexer derives the expiry without one.
9. **No automatic refill**, no roll of returns into Ready in v1.

## 4. Placement

A new `ReadyBalanceFacet` hosts the entries, the views and one
`address(this)`-gated self-call, `spendReady(account, asset, amount)`,
which the three spend sites call through `LibReadyBalance` so no facet near
EIP-170 carries a copy of the rule. Storage is appended at the tail of
`LibVaipakam.Storage`. The vault gains one read, `protectionEpoch()`.

**Refresh together:** ReadyBalanceFacet + OfferMaterializeFacet +
InstantFillFacet + AutoLifecycleFacet + VaultDepositoryFacet + the vault
template. A spend site without the host reverts `FunctionDoesNotExist` for
every account (a hard revert, never an unchecked spend).

## 5. Transparency

- Events: `ReadyTopUpRequested`, `ReadyTopUpCancelled`, `ReadyMoved(account,
  asset, amount, direction)` for every Protected↔Ready, Wallet→Ready and
  spend move (a matured top-up is reported when folded in), `ReadyIdlePeriodSet`,
  `ReadyIdlePeriodChangeRequested`, `ReadyUntilSet`.
- Views: `getReadyBalance(account, asset)` (effective amount, stored amount,
  pending top-up and its time, ready-until, why it counts as zero if it does)
  and `getReadySettings(account)`.
- Copy never calls the Protected balance "savings". The presets (Basic,
  Strong, Maximum) live in the app (#3345).

## 6. Alternatives considered

- **Close #3344** and keep instant vault use: leaves a stolen key free to
  drain a vault through a bad position; rejected on security.
- **Ready without the gate:** a label that limits nothing.
- **Per-action delayed queues (the #3227 commitment rows):** heavier, still
  unbuilt, and they delay each position instead of letting the owner fund a
  bounded instant slice in advance.
- **Ready as a lien** (moved out of free balance): would hide it from the very
  spends it exists for, and every free-balance check would need an exception.

**Recommendation:** build as above.
