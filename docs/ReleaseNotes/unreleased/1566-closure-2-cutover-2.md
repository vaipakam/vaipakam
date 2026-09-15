## #1566 closure 2 — the cutover apparatus, part two: the legacy reconciliation epoch (PR #TBD)

The first part of the cutover apparatus protected every untyped arrival
the moment it landed and recorded every packet under its transport
identity. This second part is what an administrator does with that
protected value: classify it, correct a classification, and reconcile the
inventory that arrived before packets were stamped. All of it is
administrator-only, under the platform's manual pause, on a deployment
whose custody is activated, and all of it stays inside the custody
address — a classification moves attribution and, where tokens move at
all, they move between the address's own rows, never from the platform's
own balance.

A classification takes part of what one recorded packet put into the
unclassified attribution and makes it fresh backing (what a standing
deficit absorbs goes to the restitution position, only the excess to live
backing), recycled backing, or both. It can never take more than the
packet put in — the packet's own remainder is the bound, which is what
protecting at ingress bought — and never more per component than the
authenticated split the first entry for that packet states, a split that
is fixed once and must be restated exactly by every later entry, so a
wrong split refuses at submission rather than being discovered after it
has published headroom. Each entry is applied once. A rounding residual
stays where it is, visible. A packet whose value is still reserved for a
return is not classifiable.

A classification is correctable, within a bound. Attribution moves between
the fresh and recycled sides of an entry without changing its total, and
only what has not been spent moves freely: outflows are taken to consume
every credit of that side in the order it was credited — deliveries and
fundings, absorptions and relocations, the classified entries among
them, and whatever backing stood there when the first entry was made —
measured against ordering counters that count outflows only and only
ever grow (the headroom figures the platform already keeps can be
corrected downward, which is why the ordering could not read them), and
a correction of an earlier entry shifts every later entry's place in
that order. A debit one side inherited is unwound by the reverse move,
so a correction and its reversal leave an entry exactly as spent as it
was; and recycled value that left by a surplus repatriation, rather than
by consumption, is never inherited by the fresh side. Unspent value moves with
its tokens — out of live backing only, never out of the restitution
position; out of recycled backing only up to what is not committed. Spent
value moves as a debit the other side inherits: fresh spent then corrected
to recycled lowers the delivered and paid figures together and raises the
recycled consumption, and the reverse raises them together and gives the
consumption back — never a demand for new capital, because an
authenticated ledger inherits the debit.

The inventory that arrived before packets were stamped is reconciled as
one aggregate, once. Every figure of it is read by the platform itself at
the import — what it counts as uncounted, less what the address already
holds of it, less the quarantine reservation still resting in its own
balance, less every return ever sent — and the administrator states only
how each unit is resolved: relocated from the platform's own balance where
the tokens are still there (measured at both ends), funded by the
administrator where they are not (delta-checked into the address), or
written down. The resolution must be exact and the aggregate is then
entered into the same correctable record as every classification, so its
error path is the same correction. The epoch has no end: nothing here
closes it, by design.

One small correction to the refresh rides along: the remittance
receiver's generation probe now takes the live receiver before a stale
deployment record's distinct proxy, the order every other probe already
used, so a record naming a proxy the signer can no longer upgrade cannot
abort the run before the live receiver is reached.

Two things this part does not do, stated so they are not read as
forgotten. The epochs a role change carries in flight are a change of
their own, to land before the era registry that makes them consumable;
and every entry keys a single era until that registry assigns real ones.
Refs #1566, #1349, #1956.
