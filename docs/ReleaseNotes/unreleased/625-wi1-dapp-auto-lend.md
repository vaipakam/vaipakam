## Thread — Auto-lend Phase 1: dapp surface, wired to standing intents (PR #<n>)

Part of #625 (auto-lend = the LenderIntent layer; see the design card).
With every on-chain piece (intent discovery, fill preview, the keeper
fill + roll passes) already merged, this final step gives lenders a
front-end to turn auto-lend on — and rewires it off the legacy
fixed-duration offer-posting marker onto the standing-intent machinery.

What's new for the user — a new **Auto-lend** card on the Dashboard:

- The lender picks a `(lending asset, collateral asset)` pair and sets
  their own bounds: max exposure, minimum fill size, a minimum rate
  floor, a maximum initial LTV, and a maximum loan term. A "use recent
  market rate" hint pre-fills the rate floor from the freshest matched
  offer on that pair (the same anchor the Offer Book surfaces), so the
  lender isn't guessing.
- Turning it on runs an ordered, **resumable** sequence: register the
  standing intent, delegate the protocol keeper (auto-roll, plus
  signed-fill when the lender keeps the intent keeper-gated), record the
  auto-lend consent marker, and **fund working capital last** — so
  capital is never pulled into custody before a fillable, properly
  delegated intent exists. Each step probes its on-chain state first, so
  a sequence interrupted by a rejected wallet prompt or a dropped tx
  resumes from where it stopped rather than redoing finished steps.
- The two admin kill-switches are reflected honestly: the consent switch
  gates the consent step, and the fill-path switch is surfaced as "you
  can register and fund now; the keeper starts filling once it's
  re-enabled" — an intent can be staged while filling is paused and
  starts automatically when governance flips it on.
- Wind-down is first-class: **Pause** clears the consent marker while
  leaving the intent and capital in place, and **Withdraw & stop**
  returns the un-lent capital to the wallet and cancels the intent.

The keeper's signing address is published per-chain (a new optional
deployment field the operator sets); where it isn't yet configured, the
card still offers intent registration + funding (auto-fill works without
any delegation) and explains that auto-roll delegation becomes available
once a keeper address is set. The legacy auto-lend toggle was removed
from the Auto-lifecycle card, which now carries only the borrower
auto-opt-in-on-new-loan convenience.

This is a pure front-end change — no contract behaviour changes; the
intent layer it drives was specified and shipped in the WI-2 work. Closes
the #625 auto-lend epic's dapp work item. Follow-up: surfacing/managing
multiple concurrent intents per lender (this card configures one pair at
a time) and an indexer-populated keeper discovery path (#752) remain
tracked separately.
