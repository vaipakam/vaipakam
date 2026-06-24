## Thread — Progressive risk access: opt-in strict mode (PR #<n>)

Phase 2 of #671 (#728), PR-2d. Adds an **opt-in per-vault strict mode** to
progressive risk access. By default, a mid-tier (BroadLiquid) pair needs no
per-pair acknowledgement — the tier opt-up is itself the consent, and the
quantitative LTV / health-factor check still applies. A vault that wants a
stronger, deliberate gate can now turn **strict mode** on: while it is on, the
vault must hold a fresh **explicit** acknowledgement for **every** mid-tier pair
it originates, not just illiquid ones. This is what makes the strict-mode flag
actually enforce something.

The explicit acknowledgement is a separate, deliberate action
(`setMidTierPairAck`) — it is never auto-stamped by the protocol on first use, so
a strict-mode vault can't satisfy its own requirement by accident. The ack binds
to the exact assets (asset types + token ids) the signer reviewed and is anchored
to the current risk-terms version, so a governance terms bump re-locks it exactly
like the tier and illiquid-pair consents: the vault must re-acknowledge.

Turning strict mode **off** is treated as a risk-increasing change. It is
immediate by default, but on a deployment that has configured an opt-up cooldown,
the mid-tier acknowledgement requirement **lingers** for the cooldown window after
a disable — so a vault can't drop strict mode and originate an un-acknowledged
mid-tier loan in the same breath. Both the strict-mode toggle and the explicit
ack are available as direct self-calls and as relayer-submittable gasless signed
messages (the off-direction toggle carries the full signed envelope because it is
the risk-increasing direction).

To keep interfaces honest, the existing read-only risk preview now also reports
the strict-mode case — an interface can tell, before any signature, that a vault
in strict mode would be blocked on a mid-tier pair until it acknowledges, and
collect that acknowledgement first. A dedicated view also answers the question
directly for a given vault and pair.

The whole feature sits behind the off-by-default `riskAccessGateEnabled` master
switch, and strict mode itself is off for every vault until explicitly enabled —
so nothing changes for anyone who doesn't opt in. A deliberately-deferred
companion (a passive, analytics-only record of first mid-tier use, written by the
gate) is noted as a follow-up because it would require the gate to write state on
an otherwise read-only path. Part of #671 / #728 (does not close them).
