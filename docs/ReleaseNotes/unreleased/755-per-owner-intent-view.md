## Thread — Auto-lend: per-owner standing-intent enumeration view (PR #<n>)

Part of #755 (multi-intent-per-lender management UI). The auto-lend layer
already lets a single lender hold **many** standing intents — one per
`(lending, collateral)` pair — but the only on-chain enumeration was the
keeper's **global, funded-active-only** feed (`getActiveLenderIntents`),
which is owner-agnostic and omits paused intents. So the dapp had no clean
way to show a lender *their own* intents. This is the read surface that
gap needs; the management UI that consumes it lands in the follow-up step.

What's new:

- An **enumerable per-owner intent registry**, maintained at the same sites
  as the global feed (register / fund / cancel / withdraw / fill draw-down /
  auto-roll). Its membership is deliberately **broader** than the global
  feed: a key is listed while the intent *exists for the lender to manage* —
  `active` **or** carrying reserved capital — so a **paused** intent
  (cancelled but still holding funded capital the lender can resume or
  withdraw) stays visible. A key drops out only once the intent is **fully
  torn down** (inactive **and** zero reserved capital).
- **`getLenderIntentsByOwner(owner, offset, limit)`** — a paginated, lean
  view (on `LenderIntentFacet`, alongside the other `getLenderIntent*`
  reads) returning every standing intent that owner holds, each with its
  bounds, the un-lent funded capital, the live principal already out on
  loans, and — new on the shared summary shape — an **`active` flag** so a
  consumer can tell an active intent from a paused one. (The flag is always
  true in the global keeper feed, which lists only active intents.)

This is a read-only surface plus per-owner registry bookkeeping — no change
to how intents are registered, funded, filled, rolled, priced, or settled.
The lender-facing list/manage UI that pages this view is the next step;
there is no borrower-side equivalent because the intent layer is
lender-only by design (borrowers use the offer book).
