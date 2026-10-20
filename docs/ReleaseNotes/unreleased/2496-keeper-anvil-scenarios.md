## Keeper — end-to-end scenarios on a local chain for the reward passes (PR #<n>)

Three keeper reward passes are now exercised end to end against a real chain
instead of only against unit-test doubles. The new scenarios start a local
Anvil node carrying the repository's current contracts, built from source,
and set it up as a canonical reward chain: VPFI, the reward launch, active
reward custody, a funded reward pool and the testnet sanctions overlay. They
then run the keeper's own pass exactly as the scheduler would, with its own
key and its own databases. Where the pass takes its work from the shared
database, the real indexer fills that database from the same chain. Nothing
touches a real network, and the only keys involved are Anvil's public
development keys.

The claim-horizon heartbeat scenario (#2517) follows a repaid loan's two
reward entries through their whole life:
- found and queued while the horizon is off, with nothing sent;
- their clocks started once an operator switches on a 180-day horizon;
- their final notice filed exactly 180 days of claimable time later;
- removed after the 90-day notice, with the value credited to the recycle
  bucket;
- every step sent by the keeper, with no operator alert raised.

The sanctions-hold scenario (#2515):
- has a lender flagged partway through a loan;
- shows the keeper finding that lender through the indexer's loan records and
  starting the evidence chain;
- keeps the chain observed until the three-day window is confirmed;
- settles in the same run: the two days earned before the flag are set apart
  for the owner, the three days earned while flagged go to the recycle
  bucket, and exactly one operator notice states both amounts.

The local-node harness the connected app's end-to-end tier already used is now
a shared package, used by both suites. The keeper scenarios run from their own
command and a separate CI job, not in the keeper's default unit-test run.
Coverage is recorded in the keeper's own matrix, apps/keeper/e2e/COVERAGE.md.
It states why that matrix is separate from the app's.

The delivery-proof pass (#2516) now has its scenarios too, on a second,
two-chain harness: one local node presenting Base Sepolia and one presenting
Sepolia, each carrying the current contracts, wired together by running the
operator scripts themselves, and joined by a local cross-chain lane made of
the real CCIP router, risk-management and token-registry contracts and the
real VPFI token pools. Only the two pieces that stand where Chainlink's own
network sits on a live lane are supplied: the ramps and a relay that carries
each message from one node to the other exactly as the sending chain emitted
it. The scenario runs the real cycle:
- a loan on the mirror; the mirror closes its days and its reports reach
  Base; Base finalizes them;
- the keeper's own remit pass funds the mirror: Base's pool locks exactly the
  remitted VPFI, and the mirror mints exactly that amount, which rests in the
  mirror's reward custody;
- the real indexer runs on both chains, then the keeper's delivery-proof pass
  rebuilds the delivery's day list from Base and indexes it, after which the
  mirror shows the delivery whole;
- every transaction the keeper's, no operator alert, and nothing to do on the
  next run.

A second scenario shows the pass's warning to operators: a delivery the
keeper cannot complete (here because it was given no connection to Base, so
it cannot rebuild the day list) raises nothing in its first ten minutes,
raises the "not yet whole" alert once, naming the delivery, after ten
minutes, and the alert is cleared once the keeper, reconnected, completes it.

To run the operator scripts on local nodes that present real test-network
ids, the guard that lets a script write its deployment record to a scratch
folder now also accepts any local Anvil node, recognised by asking the node
itself; a live network still cannot use it.

One thing is still not covered, and the matrix says why: the sanctions
pass's staging retry needs a reward claim delivered to another chain. The
two-chain harness can now carry one, but that scenario has not been written.

No keeper defect was found.
