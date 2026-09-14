## #1566 closure 2 — the cutover apparatus, part one: protected at ingress (PR #TBD)

The custody design's second closure-2 change — the apparatus that lets a
deployment already carrying reward value cut over to the dedicated custody
address — lands in two parts. This is the first, and it is about what
every packet needs the moment it arrives; the second is the reconciliation
of what arrived before.

Three kinds of reward value were, by design, still resting in the
platform's own balance after the custody switch: the part of a delivery
that could not be attributed to a composition, a compensation quarantined
for a day the mirror refused, and a return for a receipt older than
per-receipt attribution. On a deployment whose custody is activated, each
of these now moves into the address's unclassified attribution as it
lands. That attribution is visible and auditable — it equals its own two
figures, checked as an invariant — and it is never spendable as reward
value; its only exit in this change is the return of a quarantined
compensation, which now draws from the address what the address backs and
from the platform's own balance only what predates the activation. A
provisional compensation that is later demoted has its remaining credit
re-attributed inside the address rather than released back to the
platform's balance. The platform's backing position, and the reservation
figure both backing snapshots publish, count only the Diamond-side part of
the quarantine reservation from now on, so the watcher's exact balance
relation keeps its meaning without a shape change.

Every value-bearing reward packet is now recorded under an identity the
transport itself supplies at delivery — the message id the cross-chain
adapter passes through to every recipient, which is a change to that
shared interface, so the adapter and all its recipients are upgraded
together by the same generation probe the refresh already uses — each
resolved from the live configuration first and the deployment record
second, so a missing or stale record can never leave a live contract on
the old shape. A packet delivered twice under one identity is refused
whole, and so is a second delivery for a receipt that already exists: a
receipt is delivered once, so every figure kept against a receipt
describes exactly one delivery. A transport that supplies no identity has
one allocated in sequence by the platform's own ingress; the receipt a
delivery creates is bound to the identity. This
record is what the second part will reconcile against, and it is taken on
every deployment, activated or not.

The migration mode the design calls for is the platform's own manual
pause: reward packets still land and are protected while the pause
refuses every reward consumer, because the receive ingresses are no
longer pause-gated. The expiry clocks already respect the pause boundary,
so the paused interval never counts as claimable time; the receivers'
own guardian pause remains the way to stop packets at the edge. The
activation ceremony's pre-flight also now mirrors the activation's
holder-wide check, so an unreadable or under-held holder is refused
before anything is sent. Refs #1566, #1349, #1956.
