# Release Notes — 2026-06-19

The backstop gained its second half — #630 Role B, the liquidator-of-last-resort
cash buyout — and governance gained four feature kill switches (#633) for
aggregators, keepers, individual swap venues, and peer-data reads.

### #630 — Treasury-seeded backstop, v0 Role B (liquidator-of-last-resort)

The protocol backstop now has its second half: a cash buyout that can make a
lender whole when a liquidation fails and the loan is stuck holding collateral
nobody will swap. It is governance-run, treasury-funded, and off by default
behind its own kill-switch — independent of Role A's, so the riskier buyout can
be paused on its own.

How it works: when a liquidation's market swap fails, the loan enters a
"fallback pending" state and the protocol holds the collateral, with the borrower
still able to cure (top up or repay) until the lender acts. The lender (the
current holder of the lender position) can now opt that loan into a backstop cash
exit. Once opted in, the protocol's designated keeper can execute the buyout: the
system first tries one more time to resolve the loan on the open market (an
internal match against an opposing loan, plus a best-effort swap) — if that
works, no backstop money is spent and the lender is paid the proceeds normally.
Only if the market still can't clear does the backstop step in: it pays the
lender their principal-plus-fees due in cash from a dedicated treasury-funded
bucket, takes the lender's slice of the collateral to warehouse and sell later,
and routes the treasury and borrower slices exactly as a normal settlement would.

The buyout is deliberately conservative and self-protecting:
- It only pays out if the collateral slice it receives is worth at least the cash
  it pays (priced by the protocol's own oracle, with a dust tolerance) — an
  underwater or unpriceable position is refused, and the lender simply uses the
  ordinary in-kind claim instead.
- Governance sets a per-asset-pair cap on how much cash the backstop can have
  tied up in unsold collateral at once, and seeds a finite cash bucket — together
  bounding the protocol's exposure.
- Loans that received a borrower collateral top-up are excluded and routed to the
  normal claim, so the top-up is never mis-handled.
- The lender keeps their normal self-service claim at all times; the cash exit is
  strictly an additional option, never worse for them.

When the warehoused collateral is later sold back to cash (or written off by
governance), a governance action records that realized return and frees the
corresponding exposure headroom for future buyouts.

This completes the v0 backstop. Both halves stay inert until governance enables
and funds them. The pooled-LP / first-loss version remains a separate future
effort.

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
  re-activated later. The pause is honoured on **both** liquidation routes: the
  single-route failover path skips a paused venue, and the multi-route split path
  now **rejects** a paused venue on-chain rather than relying on the off-chain
  keeper to omit it — closing the gap where a split leg (which carries no
  per-leg slippage floor of its own) could otherwise have been routed through a
  compromised venue.

- **Peer-data reads.** Governance can pause the optional reads of peer lending
  protocols used to refine the depth-tiered collateral limits; while paused the
  platform falls back to its own governance-set limits, so a compromised external
  data source can't influence risk parameters.

All four are off (inactive) by default and are surfaced through events plus a
read for the per-venue swap state.
