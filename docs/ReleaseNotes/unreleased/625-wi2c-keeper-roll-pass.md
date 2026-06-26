## Thread — Auto-lend Phase 2c: keeper auto-rolls fully-repaid intent loans (PR #<n>)

Part of #625 (auto-lend = the LenderIntent layer; see the design card). The
keeper already auto-fills standing intents and the protocol exposes an on-chain
feed of fully-repaid intent loans; this step closes the loop — the production
keeper now **auto-rolls** those loans, re-lending the proceeds straight back into
the lender's intent capital with no manual claim/refund round-trip.

What's new — the keeper's matching tick gains a third pass (after the offer-match
and intent-fill passes):

- It pages the on-chain registry of fully-repaid intent loans and calls the
  existing roll entry point for each, so a lender who delegated the dedicated
  auto-roll permission to the keeper gets zero-gap redeployment automatically.
- Because rolling a loan removes it from the registry, the keeper collects the
  full set of repaid loans up front and then rolls them by id — avoiding the
  skip that paging-while-mutating would cause.
- A loan whose owner has **not** delegated the auto-roll permission to this
  keeper is rejected on-chain; the keeper recognises that and skips every other
  loan with the same owner for the rest of the tick, rather than re-attempting
  one per loan.
- The pass runs even when there are **no open offers** (rolling is independent of
  the order book), and it shares the matcher's existing safety rails: the
  per-chain wall-time budget and the per-tick submission cap are carried through
  from the match and fill passes (so the three passes can't together exceed the
  budget), and it self-gates on the operational keeper-pause — re-read
  immediately before each roll — so a pause mid-tick stops further rolls.

This is purely additive keeper behaviour reusing the on-chain roll-discovery
view and the existing roll entry point; it changes nothing about how intents are
funded, filled, rolled, or settled on-chain.
