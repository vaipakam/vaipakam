## Thread — Auto-lend Phase 2a: on-chain discovery for standing lender intents (PR #<n>)

Part of #625 (auto-lend = the LenderIntent layer; see the design card). This is the
first build step of Phase 2 — the **discovery surface** a keeper needs to find and
fill standing lender intents automatically.

Until now a registered `LenderIntent` was reachable only by its exact
`(owner, lendingAsset, collateralAsset)` key — there was no way to enumerate the live
intents, so an off-chain filler would have had to index every
`LenderIntentSet` / `LenderIntentCancelled` event to reconstruct the active set. This
change adds an **on-chain registry** of active intents and a paginated read view, so a
keeper can simply page the current set each tick.

What's new:

- An **enumerable registry of active intents**: registering an intent adds it; cancelling
  removes it; re-registering an already-active intent is idempotent (a bounds update never
  double-counts).
- **`getActiveLenderIntents(offset, limit)`** — a paginated, lean read view returning, per
  active intent, the lender's bounds plus the two figures a filler needs to size a fill
  safely: the live principal already lent out, and the un-lent funded capital a fill draws
  from (a fill exceeding that capital reverts on-chain). It also reports whether the intent
  requires a keeper authorisation, so a filler can skip intents it isn't delegated to fill.
- An **`IntentMatched`** event emitted whenever an intent is filled into a loan, keyed by
  the originating owner. The generic match event only carries the transient lender slice
  (which is discarded after the match), so this owner-keyed marker is what lets a later
  auto-roll pass find an intent's repaid loans. The loan itself continues to be indexed by
  the existing match/loan events; this marker is purely for off-chain roll discovery.

This is a read + event surface only — no change to how intents are funded, filled, or
priced. The keeper that consumes these (the fill and auto-roll passes) lands in the
following Phase-2 steps; this step gives that work a clean, paginated on-chain source.
