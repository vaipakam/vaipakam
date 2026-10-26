# Tier record: one refresh at the balance seam, one push per action (#1820, #2849)

Status: being built, stacked on the tier-push delivery change (#898 / #911,
[`TierPushDeliveryDesign.md`](TierPushDeliveryDesign.md)). Fresh deploy only.

## 1. The problem

A user's VPFI fee-discount tier on Base is read from the time-weighted
record in `VPFIDiscountAccumulatorFacet`. That record is fed by a stamp of
the user's tier balance, which is the vault VPFI the protocol tracks for
them, less any VPFI frozen in their vault for a transferred position's
holder.

Until now, each facet that moves vaulted VPFI had to remember to stamp the
record after the move. There were about 45 such call sites, in two variants
(one that also pushes the tier to the mirrors, one that does not), and
several paths had no stamp at all (#1820):

- an offer's escrow when the asset is VPFI;
- the return of that escrow on cancel or mutation;
- the buyer's escrow pull when a loan-sale listing is accepted.

Each missing stamp leaves the record counting VPFI the user no longer holds,
or missing VPFI they now hold, until some unrelated action stamps them. The
spec has always said every vault VPFI movement refreshes the record. The
code met that only where a facet remembered.

## 2. The rule

**The tier balance has two writers, and the refresh lives at both of them.**

1. The tracked vault balance changes only in `LibVaipakam.recordVaultDeposit`
   and `LibVaipakam.recordVaultWithdraw`. When the token is VPFI, each of them
   now refreshes the owner's tier record, at the moment of the change.
2. The frozen-for-a-holder amount changes only in `LibTierExclusion` and
   `LibCloseoutFreeze`. Each write there refreshes the vault owner's record
   the same way.

The refresh reads the balance from storage after the change (tracked minus
frozen, floored at zero). No caller passes a balance, so no caller can pass
the wrong one.

Every per-site stamp is deleted, both variants of them, and so are the
broadcast-free twins #2849 asked to retire:
`VPFIDiscountAccumulatorFacet.rollupUserDiscount` /
`rollupUserDiscountLocal`, their `LibVPFIDiscount` wrappers,
`ConsolidationFacet.restampUserVpfiInternal` /
`restampUserVpfiLocalInternal` and the `LibConsolidation` helpers. The
accumulator keeps one internal entry, `syncTierRecord(user)`.

Three callers refresh a record with no balance change, because time alone
can change a tier (the minimum-stake gate passing, a day rolling out of the
look-back): `pokeMyTier`, and the lender's and borrower's snapshot at loan
start. They call the same `syncTierRecord`.

## 3. Intermediate movements

A settlement can move one user's VPFI several times. A loan sale, for
example, debits the buyer and credits the seller in steps. Each movement
refreshes the record at that point, so the record sees the lowest balance in
between: the day's minimum, which the tier's look-back clamp reads, includes
it. That is what the old "local" intermediate stamps were for, and the seam
now does it on every path without anyone writing it.

## 4. One push per user per action

Refreshing the record and pushing the tier to the mirrors are now separate
steps.

- **The refresh is immediate.** It updates the record on Base at once, so
  anything later in the same action reads the current tier.
- **The push waits for the end of the action.** While the Diamond's
  reentrancy guard is held (every guarded entry point) or a 1inch fill holds
  the fill lock, the refresh adds the user to a per-transaction queue
  instead of pushing. When the guard is released at the end of the action,
  the queue is flushed: each queued user gets one push of the tier their
  record now resolves to, through the owed-lane delivery of
  [`TierPushDeliveryDesign.md`](TierPushDeliveryDesign.md). The flush runs
  just before the guard is released, so the cross-chain calls still happen
  under the guard.
- **Outside both**, the push happens at once, as before.

So a settlement that moves a user's VPFI five times commits one push, not
five, and it carries the user's final tier. Users whose resolved tier did
not change commit nothing (the delivery change already compares the tuple).

A fill's pre-hook runs without the guard but under the fill lock, so its
users stay queued. The post-hook takes the guard and its release flushes
them, after the settlement is complete. No cross-chain call runs between a
fill's two hooks.

The queue is transient storage. A reverted action discards its queue with
everything else. A transaction that somehow ended with users still queued
would lose only the push, not the record: the record on Base is already
current, and the user's next push carries it.

## 5. What it costs and what it changes

- **Gas.** Each guarded action pays one transient read at its end. Each VPFI
  movement pays one refresh, as most already did. The push is paid once per
  user per action instead of once per stamp.
- **More addresses get a record.** Any address whose tracked VPFI changes now
  gets a refresh, including a backstop vault that holds VPFI. That is the
  same rule applied without exceptions. Its pushes are paid by the budget
  under the usual limits (a first push and a lowered tier at once, anything
  else once per spacing window).
- **Close-outs now push.** A time-based default, a fallback-custody move and
  a reward credited to the vault used the broadcast-free variant, so their
  mirrors stayed stale until the user's next pushing action. They now push
  at the end of the action, like every other movement. A permissionless
  close-out therefore carries the cross-chain send's gas when the moved
  asset is VPFI.
- **A reward credited to the vault no longer runs a push inside its isolated
  frame.** The credit only queues the user, so a push can never make the
  credit fall back to the wallet.
- **A starved push still fails the action.** `TierPushOutOfGas` from the
  flush reverts the whole action, as it did when the push ran inside it.
- **An unguarded entry pushes where it writes.** An entry point that holds
  neither the guard nor the fill lock (a role-gated biller writing the
  notification fee, for example) pushes at the refresh itself, as before.
  The push cannot run twice for one write either way.

## 6. Missing routes

The refresh is a self-call to the accumulator, and the push a self-call to
the broadcast facet, so either can be missing on a Diamond.

- **No accumulator routed:** the refresh records nothing and the action
  goes on. Only the unit-test Diamonds that cut just the facets under test
  are in this state; every deploy and refresh script cuts the accumulator,
  which the deploy-sanity suite checks.
- **No push host routed:** the accumulator reverts `TierPushHostMissing`.
  It is a named error rather than the Diamond's `FunctionDoesNotExist`, so
  the refresh can never mistake a missing push host for a missing
  accumulator and skip the record silently.

## 7. Reaching a chain

Every facet that writes a tracked balance, every guarded facet (the flush
is in the guard's release) and the accumulator and broadcast facets carry
the change, so it is a whole-Diamond change: a fresh deploy, or
`RefreshAllFacetsInPlace`, whose route sweep removes the retired restamp
and rollup entries. The curated scripts (`RedeployFacets`,
`ReplaceStaleFacets`) cannot cross it and refuse a Diamond that does not
already route `syncTierRecord` (`PredatesTierRecordSeam`).
