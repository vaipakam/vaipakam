## Thread — Auto-lend Phase 2c: on-chain discovery for auto-rollable intent loans (PR #<n>)

Part of #625 (auto-lend = the LenderIntent layer; see the design card). The
keeper already auto-FILLS standing lender intents; the next step is to auto-ROLL
a fully-repaid intent loan — re-deploying its proceeds straight back into the
lender's intent capital with no manual claim/refund round-trip. This change adds
the **on-chain discovery surface** the keeper needs to find those loans.

The discovery is kept fully on-chain on purpose: the keeper signs transactions,
so it must decide what to roll from authoritative chain state, not from an
off-chain index (which would add a trust boundary and an attack surface to a
value-moving path).

What's new:

- An **enumerable registry of live intent-originated loans**: a loan joins the
  registry the moment a fill records its originating intent, and leaves it when
  that origin is cleared — whether the proceeds are claimed through the normal
  path or auto-rolled. The registry therefore tracks exactly the loans that
  still carry a live intent origin, with no unbounded growth.
- **`getRollableIntentLoans(offset, limit)`** — a paginated, lean read view that
  pages the registry and returns only the loans that are **fully repaid** (the
  roll candidates), each with the originating owner, the asset pair, and the
  original fill amount that would be re-lent. It is keyed off each loan's
  recorded origin rather than the live lender of record, so a loan whose lender
  position was sold is still surfaced (the roll itself then safely rejects it,
  and the keeper authorises against the recorded owner).

This is a read-only surface plus registry bookkeeping — no change to how intents
are funded, filled, rolled, or settled. The keeper pass that consumes the feed
(paging it and calling the existing auto-roll entry point) lands in the
following step.

(Note: the registry is populated only by the new fill path from this deployment
forward; the protocol is pre-live, so there are no pre-existing intent loans to
back-fill.)
