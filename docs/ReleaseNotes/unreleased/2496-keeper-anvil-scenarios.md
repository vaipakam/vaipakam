## Keeper — end-to-end scenarios on a local chain for the reward passes (PR #<n>)

Two keeper reward passes are now exercised end to end against a real chain
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

Two things are not covered, and the matrix says why:
- **The delivery-proof pass (#2516).** It works only on a mirror chain, on
  deliveries a Base remit sent across CCIP. A faithful scenario needs two
  nodes, the cross-chain contracts and a message relay between them. The
  matrix lists what that harness would take. Faking the delivery would have
  tested the pass against invented data.
- **The sanctions pass's staging retry.** It needs a claim delivered to
  another chain, which the same two-chain harness would provide.

No keeper defect was found.
