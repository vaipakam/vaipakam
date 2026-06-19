### #400 — Pluggable quote-time interest-rate model (the mechanism, identity by default)

Vaipakam's interest rate is set by the **human-driven P2P order book** — lenders
and borrowers post offers at the rate *they* choose, and the market clears
between them (a limit-order book for credit). That market price-discovery is the
core differentiator from pooled lenders that impose an algorithmic rate. This
change adds an *optional* pluggable rate-model substrate **without changing
that**: a human who types a rate still posts at exactly that rate.

What ships:

- An `IRateModel` interface — a pure, view-only quote function that, given an
  offer's create-time dimensions and a **reference rate**, returns a rate in
  basis points.
- A governance registry: governance can register one active model (a
  risk-increasing change → timelock + guardian-revocable after handover) or
  leave it unset. **Unset is the default — the "identity model" — so nothing
  changes on the live protocol until a model is deliberately registered.**
- A read-only resolver (`quoteOfferRateBps`) that returns the reference rate
  verbatim when no model is set, else the model's quote.

How it's used — deliberately **not** by overwriting human offers:

- **Manual offers stay human-priced.** The rate a person types is binding and is
  never transformed on-chain. The model is, at most, a *suggestion* the dApp can
  show — which the person can take or ignore.
- **Automated / delegated pricing is where the model does the work** — auto-lend,
  auto-roll, and keeper-posted standing intents (where the user opted into having
  their liquidity priced for them). Those flows call the resolver and post the
  quoted rate themselves. This is the legitimate, fixed-rate-safe "keeper-AMM":
  automated price-discovery layered *on top of* the human market, not a protocol
  rate decree.
- **Signed offers** carry the offerer's client-quoted rate inside their
  signature, so the model is applied off-chain before signing.

Safety / anti-rate-setting hardening:

- A model only ever sets the value written into a *new* offer; a matched or live
  loan's rate is never re-priced (it's snapshotted immutably at initiation).
- **Deviation cap (on-chain).** The resolver clamps a model's output to within
  a governance-set band (±5% by default, tunable 0.5%–25%) of the reference
  rate. So a registered model — even a buggy or adversarial one — can only nudge
  the rate around the supplied market anchor; it can never drive an automated
  offer far off-market. This guarantee lives in the substrate, so every consumer
  inherits it rather than each having to re-implement it.
- **Enable-slow / disable-fast.** Registering a model is admin-gated (→ timelock
  after handover, a risk-increasing change); disabling it back to identity is a
  fast path a watcher/guardian can flip instantly in an incident.
- Automated callers must still anchor the reference to the **live cleared-market
  rate** (the clamp then bounds drift from the real market) — a requirement on
  the consumer work (risk premiums / auto-lend); this change ships only the
  mechanism and never auto-posts on its own.
