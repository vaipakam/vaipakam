## Contracts — conditional risk-tier setter closes a two-device race (PR #<n>)

Changing a vault's risk level from two devices at nearly the same time
had an unfixable-in-the-app race: each device checks the current state
before asking the wallet to sign, but the wallet-confirmation window is
unbounded, so the second transaction can land after the first already
moved the state — and re-submitting a just-raised level restarts its
safety cooldown while charging for a transaction that changed nothing
useful.

The risk-access facet now offers a conditional variant of the tier
setter: the caller states the raw tier and terms-anchor version they
observed, and the contract applies the change only while both still
hold — otherwise it reverts with the CURRENT values (nothing changes),
which is the app's cue to refresh and re-present. The unconditional
setter remains for compatibility. Semantics of an applied change are
identical to the existing setter, cooldown and anchor re-stamp
included.

Apps adopt the conditional variant once this lands in a deployment
(tracked with the follow-up that filed it); nothing changes for
existing integrations until then.
