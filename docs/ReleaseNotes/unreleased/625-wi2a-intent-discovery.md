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

- An **enumerable registry of funded, active intents**: an intent appears in the feed
  exactly when it is both active and holds funded capital, and drops out when it is
  cancelled or when its capital reaches zero — whether by a withdrawal or by a fill drawing
  it down. The registry is kept correct by re-syncing at every point capital or the active
  flag changes (register, cancel, fund, withdraw, auto-roll, a fill's draw-down, and the
  backstop's direct seeding). Gating feed membership on funded capital means a bare
  registration that commits nothing is never advertised — so the global feed can't be
  bloated by zero-capital registrations (entering it costs committed capital, not just gas).
- **`getActiveLenderIntents(offset, limit)`** — a paginated, lean read view returning, per
  active intent, the lender's bounds plus the two figures a filler needs to size a fill
  safely: the live principal already lent out, and the un-lent funded capital a fill draws
  from (a fill exceeding that capital reverts on-chain). It also reports whether the intent
  requires a keeper authorisation, so a filler can skip intents it isn't delegated to fill.
Roll discovery (the keeper finding an intent's repaid loans) does **not** need a new event:
the existing intent-fill event already carries the originating owner and the loan id, which
is exactly what the later auto-roll pass keys off.

This is a read-only surface plus registry bookkeeping — no change to how intents are funded,
filled, or priced. The keeper that consumes the feed (the fill and auto-roll passes) lands
in the following Phase-2 steps; this step gives that work a clean, paginated on-chain source.

(Note: the registry is populated only by the new funding path, so it is correct from this
deployment forward; the protocol is pre-live, so there are no pre-existing funded intents to
back-fill.)
