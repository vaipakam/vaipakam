## Thread — Cooldown + GTT countdown UX on own-offers list (PR #__, Closes #241)

Two time-driven UI states that landed on the protocol contracts but had
no frontend surface get one in this thread:

1. **`MIN_OFFER_CANCEL_DELAY` (5-min cancel cooldown)** — when range-
   order matching is active (`partialFillEnabled=true`), the
   `cancelOffer` contract path refuses to cancel an unfilled offer
   inside the 5-min window from `createdAt` to defend against
   matcher-frontrun. Pre-#241 the website had no awareness of that
   bound — a user hitting Cancel in the cooldown got a generic
   `CancelCooldownActive` revert with no explanation. Now the Cancel
   button is disabled inside the window and a `<TimeChip>`
   "Cancellable in 4m 23s" countdown renders inline, ticking to the
   second over the last 2 min of the window. The button enables
   exactly when the contract would accept the call.

2. **GTT offer-expiry (#195's `expiresAt`)** — offers may carry an
   absolute deadline; before the deadline the offer is live, after
   the deadline anyone (not just the creator) can clean it up via
   the widened `cancelOffer` access gate. The new
   `<TimeChip kind="expiry">` renders "Expires in 3h 12m" while
   live and "Expired N min ago — anyone can clean up" once
   lapsed. The chip's tick cadence is adaptive (1 s under the last
   2 min, 30 s otherwise) so an idle Dashboard tab doesn't burn
   renders on hour-scale countdowns.

The two chips share one `<TimeChip>` component
(`apps/defi/src/components/TimeChip.tsx`); the cooldown and
expiry modes differ only in label and tone. The chip is "dumb /
pure" — it does not gate buttons, does not call contracts, does
not own retry logic; the surrounding row applies the same
`now >= targetSec` predicate to decide whether to disable the
Cancel button, keeping render and gating in lockstep without
prop-callback ping-pong.

**Wired surfaces (this PR)**:
- `apps/defi/src/components/app/MyOffersTable.tsx` — the user's
  own-offers card on `/app/dashboard`. New `partialFillEnabled`
  prop threaded from `useProtocolConfig` via the Dashboard caller.
  Cooldown gate disables the Cancel button + renders the
  countdown chip; the GTT chip shows in the Status cell.
- `apps/defi/src/pages/Dashboard.tsx` — caller wiring; reads
  `protocolCfg?.partialFillEnabled ?? false` and threads it to
  the table.
- `packages/lib/src/decodeContractError.ts` — friendly-error
  copy added for `NotCreatorOrNotExpired(address,uint64)`,
  `CancelCooldownActive()`, `OfferExpired(uint256,uint64)`,
  `OfferExpiryInPast()`, `OfferExpiryAboveCap(uint64,uint256)`,
  `SelfTradeForbidden(address)`, `AonRequiresFullFill(...)`,
  `AonRequiresSingleValueAmount()`, `IocRequiresExpiry()`,
  `ModifyBelowFilledFloor(uint256,uint256)`,
  `CollateralMutationUnsupportedForShape()`. Selectors verified
  via `cast sig` against the contract source. Means a user
  hitting any of these reverts now sees a one-sentence
  explanation in the toast instead of `Custom Error 0x…`.
- `apps/defi/src/pages/OfferBook.tsx` — `OfferData` type extended
  (optional fields) with `createdAt`, `amountFilled`, `expiresAt`,
  `fillMode` so the chips can render against rows from any data
  path (indexer + RPC + event-payload + localStorage stubs)
  without TypeScript drift.

**Deferred to a small follow-up**:
- The PUBLIC `<OfferTable>` row's read-only GTT chip + the
  "Clean up" permissionless-clear button on expired rows. The
  primary user value of #241 — "the Cancel button shouldn't
  silently fail" — lands in this PR via the own-offers surface;
  the public read-only mirror is additive and best paired with
  the wider OfferBook UX polish under `#166 sub 2`.

Closes #241 (the cooldown + countdown surface on the user's own
offers).
