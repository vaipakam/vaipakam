### #633 — Admin/governance kill-switches for aggregators, keepers, swap venues, and peer data

Governance now has four additional emergency levers to pause individual platform
features without disabling unrelated machinery. Each defaults to "active" so the
platform behaves exactly as before until governance deliberately flips one, and
each is admin-settable now and moves to the governance timelock after handover —
the same posture as the existing backstop switches.

- **Aggregator adapters.** Governance can pause the external yield-aggregator
  feature — both onboarding a new aggregator and filling an existing aggregator's
  standing lending intent — in a single switch, without freezing ordinary user
  lending intents or the backstop (which a broader switch would have caught).

- **Global keeper pause.** Governance can freeze all delegated keeper activity
  protocol-wide in an incident (the bots that run liquidation follow-ups,
  auto-roll, and the backstop buyout). Position owners can always still act on
  their own positions directly, and ordinary permissionless liquidation stays
  available — only third-party keepers are paused. This complements the existing
  per-user control where each user can already pause their own delegated keepers.

- **Per-venue swap pause.** Governance can pause an individual swap venue
  (e.g. one DEX aggregator) so liquidation routing skips it and fails over to the
  remaining venues, without de-registering it and reshuffling the others. A
  compromised or temporarily-illiquid venue can be sidelined instantly and
  re-activated later.

- **Peer-data reads.** Governance can pause the optional reads of peer lending
  protocols used to refine the depth-tiered collateral limits; while paused the
  platform falls back to its own governance-set limits, so a compromised external
  data source can't influence risk parameters.

All four are off (inactive) by default and are surfaced through events plus a
read for the per-venue swap state.
