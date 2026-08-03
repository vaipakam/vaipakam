## Contracts — conditional risk-tier setter closes a two-device race (PR #<n>)

Changing a vault's risk level from two devices at nearly the same time
had an unfixable-in-the-app race: each device checks the current state
before asking the wallet to sign, but the wallet-confirmation window is
unbounded, so the second transaction can land after the first already
moved the state — and re-submitting a just-raised level restarts its
safety cooldown while charging for a transaction that changed nothing
useful.

The risk-access facet now offers a conditional variant of the tier
setter, in both direct and gasless (relayer-submitted) forms. The
caller states two observed values — a per-vault change counter that
every tier write advances, and the platform's current risk-terms
version — and the contract applies the change only while both still
hold; otherwise it reverts with the CURRENT values (nothing changes),
which is the app's cue to refresh and re-present. The change counter
means even a lower-then-re-raise sequence that lands the visible state
back where the caller saw it is still detected as movement, and the
terms-version binding means a governance terms update between the
caller's reads and the transaction can never be silently re-affirmed.
For the gasless form the observed values are inside the signed
message, so a relayer cannot alter or strip them. The unconditional
setter remains for compatibility; semantics of an applied change are
identical, cooldown and anchor re-stamp included. A read-only view
exposes the change counter for apps to plan against.

Apps adopt the conditional variant once this lands in a deployment
(tracked with the follow-up that filed it); nothing changes for
existing integrations until then.
