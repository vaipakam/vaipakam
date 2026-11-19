# A restore re-checks every signed order's signature before it goes back on the book

Closes #2899

The nightly archive carries the signed-offer book, and a restore puts it back.
It already checked that each archived order was in the form the indexer
stores, but not that its signature was the signer's. A row written straight
into the database before the backup ran would skip the indexer's own check.
The Diamond would never fill it, but the restored book would list it until it
expired, and a taker trying it would pay gas for a revert.

The restore now applies the indexer's signature rule again to every archived
order. An order goes back only when its chain has a Diamond in the build's
deployment bundle, its stored hash is the hash of its stored terms, and its
signature recovers its signer on that Diamond, alone or in the set it was
signed with. Any other order is left out rather than restored, and the restore
prints each one with its reason for the incident record. The rest of the
restore carries on, and the count the operator checks after import counts only
the orders restored.

The rule is no longer written twice. The hashing and signature check now live
in one shared module that both the indexer's order route and the restore
read, so the two cannot drift apart. The restore tool now installs its own
copy of the library it needs for the check, and the restore runbook says to
install it first.
