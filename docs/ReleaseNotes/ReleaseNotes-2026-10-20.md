# Release Notes — 2026-10-20

Today the storage layout of every contract that survives an in-place upgrade came under a mechanical append-only check, in the pre-deploy gate and in CI. The cross-chain sanctions clearance was rehearsed and then wired on the three testnets. BNB testnet hosts the clearance attestor, which reads a labelled stand-in in place of RedStone's Sanctions Oracle. The delisting timelocks on Base Sepolia and Arbitrum Sepolia now take their clearance from it over CCIP, so their answer is the stand-in's, which flags only what the testnet admin flags. The sanctions adder now confirms finality from the list itself. On the keeper side:

- three reward passes are now tested end to end on a local chain;
- the sanctions-hold pass posts settlement and chain-lapse notices to the ops channel;
- the delivery-proof pass alerts when its work on a mirror is not getting done;
- a new heartbeat keeps the reward claim-horizon clock moving;
- the liquidator stops reading a single illiquid loan's expected revert as a rejected batch.

## Thread — Storage layouts are checked for append-only changes (PR #2600)

Every storage layout that survives an in-place upgrade is now checked mechanically instead of by comment. That covers the Diamond's namespaced storage areas, the thirteen upgradeable implementations behind proxies, and the OpenZeppelin storage areas those implementations use. The repository records each layout as the compiler reports it. A change that removes any recorded fact fails the pre-deploy check and CI. A fact here is that this field of this type, under this name, lives at this place, or that this enum member has this position, or that this namespace sits at this position. In practice the check fails on a field moved, removed, retyped, inserted in the middle or renamed without a declaration. It also fails on a struct that grows where something follows it, an array of structs whose element size changes, an enum reordered, or a namespace moved. Appending a field at the end passes.

Field names are part of the record, because position and type alone cannot tell an insertion into a run of same-typed fields from an append. A field that only changes its name is declared once as a rename and is honoured from then on. A field given a new meaning is a break. A deliberate break must be acknowledged against the exact earlier layout it was measured on, listing exactly the facts it removes, and states that no chain may be upgraded in place across that change; only the merge check reads acknowledgements, never a comparison against a deployed chain. A storage area or upgradeable contract the record does not list fails the check, and so does a second view of a listed storage area as a different struct, and a facet with an ordinary state variable. The check reads the compiler's own description of the source, not the text, and refuses any build output that was not compiled from the files as they are now.

Replaying the guard over history confirmed what it catches. It refuses the three 2026-06-23 removals, which moved several hundred fields. It also refuses the 2026-08-16 removal of `baseAuthorizedMessenger`, which moved nothing, because the removed field was packed behind another; that corrects #2092's estimate. The Diamonds running on the testnets today were deployed after all of these, and have only been appended to since. The follow-up records each chain's layout at deploy and refresh, and makes the in-place refresh scripts refuse a chain whose layout the new code would break. Refs #1274, #2092.
<!-- assembled-fragment: 1274-storage-layout-guard.md sha256=c2842e236a7d6bf864f6a3305fbbe969dec33f638caa647ac72cca81e41d6d4c -->

## Thread — The sanctions adder confirms finality from the list itself (PR #2594)

The sanctions adder's first run on the keeper machine updated both test lists, yet reported the Base Sepolia update as "reorganized out" and marked the run failed. The update was in fact final. The finality check had compared the transaction's block against the one first seen, in a single read, and treated any failure of that read as a lost transaction.

The adder now confirms an update by what the list itself holds at the finalized block, read the same way every update is computed: one snapshot, with every read pinned to that block. A chain is reported as applied only once one such reading holds exactly the update the run planned: at the update's last version, the planned addresses with nothing extra and nothing removed, this publication, and the outstanding counts the update declared. Nothing seen in one reading is carried into the next, since two readings can come from different servers. Finality is now stated as a fact about the list rather than about any transaction, because no reading of the list can say which transaction produced it; the report names the transactions sent and the reading that holds the update. No transaction receipt decides it any more, because a receipt and the finalized block can come from different servers behind one RPC address, and a reorg can move a transaction to another block. Only a reading that holds the update ends the wait early. Any other reading, or a failed read, describes one server's view, which another server's view of the finalized chain may contradict, so the list is read again every 15 seconds for up to 40 minutes instead of taking that view as a verdict. When the wait runs out, the report says what the last reading showed: the list not yet at the update (it may still land), the list at the update's last version holding something else (other updates took its versions), the list already past it (its outcome is unknown rather than guessed at), or a list that could not be read at all.

Once anything is broadcast, the list decides the outcome however the sends ended. When the last transaction's receipt never comes, it may still land, so the adder waits for the list just as it would after a receipt. When a transaction was never sent or is known to have listed nothing, the adder reads the list once. Either way, a reading that holds exactly the planned update is reported as applied, and the report names the transactions no receipt confirmed. "This publication" now means the same publication date and file hash together, the pair the list records, and one rule decides it for the update tool and both services. A record carrying this file's hash under another date is reported as a conflicting record and never treated as this publication.

Every report now also states what the list declares outstanding, refused and stopped runs included, using the last finalized reading and naming which publication it belongs to. The delistings this run computed are named only for the state of the list they were computed from, or the update's planned outcome. For any other state, even of the same publication after a remover has applied some of them, the report gives the count and the command that works them out from the list itself, so it never names an address that is already gone or pairs a newer publication with an older file. The addresses are named only when they account for the whole count the list declares; a larger declared count, left by an earlier update that overstated it, is reported as a disagreement for a person to reconcile rather than as the remover's complete work. A run whose OFAC publication cannot be downloaded or read no longer drops every chain from its report: each chain is reported as refused, with what its list declares outstanding and for which recorded publication, or as unknown. A report lists as sent only the transactions that reached the network.

The same run's ops alert was refused by Telegram with HTTP 400, and the report carried only the status code. Both sanctions services now record Telegram's own reason, such as "chat not found", so a refused alert names its cause. Refs #2443.
<!-- assembled-fragment: 2443-sanctions-adder-finality.md sha256=1afd0df343448ccf36753ac11e70fa9c0a4c0363bed929bc672612ee27d26cd3 -->

## Thread — Rehearsing the cross-chain sanctions clearance on testnets (PR #2601)

The delisting timelock completes a proposal only after RedStone's Sanctions
Oracle agrees, and on chains without RedStone that agreement travels over
Chainlink CCIP from a chain where it runs. RedStone's oracle is live only on
Ethereum mainnet, so that route could not run on any test network and every
testnet timelock reported automated delisting as closed. By the owner's
decision of 2026-10-20, the route is now rehearsed on testnets against a
labelled stand-in: a new testnet-only contract answers in RedStone's place,
flags only what the test network's admin flags, says on-chain that it is a
stand-in for RedStone, and is only as current as the admin's last update to
it. It refuses to deploy on any mainnet.

A new wiring script connects the route one chain at a time: on the chain that
hosts the check (BNB testnet for the rehearsal) it deploys the stand-in and
the clearance attestor and opens the CCIP lanes to Base Sepolia and Arbitrum
Sepolia; on each of those it points the delisting timelock at that attestor.
Every step is skipped when already in place, nothing already set elsewhere is
re-pointed, and the script refuses a mainnet. Every sanctions deploy and
configure script now reuses, configures or binds to a recorded contract only
while the admin owns it with no ownership transfer pending, and none of them
replaces a contract that
still holds a role: the wiring script stops when a replacement attestor would
leave the old one answering, and the timelock deploy script never deploys a
second timelock while the recorded one can still delist, so a list never has
two automated delisting routes. The list deploy script no longer replaces a
recorded list it cannot reuse with a new, empty one: it refuses and says how
to resolve it, since a list's listings are what every consumer reads. The
oracle configure script now does the same for the test list a Diamond
already screens against: where it used to switch the Diamond to a fresh,
empty test list when the live one was controlled by another account, about
to be handed over, extended another list or was not a test list at all, it
now stops and says how to resolve it, since that list's flags live only in
it. Reads of a recorded contract that decide whether to reuse it never stop
a run on a malformed answer; they answer "not reusable" instead. Nor
does it start a new list while a delisting timelock is still recorded, since
a timelock belongs to its list for good, and the wiring script wires only the
timelock of the recorded list. Each
of these scripts records its addresses
only after every step of the run has succeeded, so a run that stops sends
nothing and records nothing. When they report a timelock's clearance check
they call it a clearance check, not a RedStone check, name the stand-in
only when it says it is one, and say automated delisting is closed while the
timelock is not a remover of its list. No list, proposer, waiting
window or Safe power changes. A fork test runs the script against forks of
the three live testnets and drives a drill proposal through request,
reading, reply and execution, plus a stand-in flag that blocks the delisting.
Running the script on the live testnets waits on the owner's go-ahead for
each chain.

The delister bot now states which oracle answered. It asks the oracle it
reads whether it is the stand-in, and when it last updated, and names it
accordingly in every action, note and report line, adding that the stand-in
is not RedStone. For the stand-in it also reads who owns it and whether a
transfer is pending, and names that owner rather than assuming the admin;
a pending owner is named even when the current owner could not be read.
The bot also refuses to run on a chain where its key controls, or is about
to control, anything a delisting depends on beyond its proposer role: the
timelock, the list, the oracle a clearance is read from, or a messenger
carrying the request or the answer. Which of these a chain depends on
follows from its clearance route, not from what the bot managed to read, so
a chain where it cannot read who controls one of them, including one whose
attestor chain it cannot reach, is refused for that run, completing a
proposal included. Any other oracle is "the clearance oracle", and the bot
never calls an oracle RedStone, since RedStone has no deployment on the test
networks it runs on and nothing it could read would establish it. The
attestor chain's
own report says the same of the oracle its attestor reads. It reads
candidates from the same oracle the report names, and when a clearance comes
back stale it judges the remedy from the oracle's current update time rather
than from the old answer: a new request alone when the oracle has updated
since, the stand-in's owner re-publishing it when it has not, and a
conditional instruction when the current time could not be read. An oracle
time later than its chain's latest block counts as unknown, as the contracts
count it, and no time a chain returns can stop the report being written. Part of
#2443, which stays open for the mainnet adder host and RedStone's terms.
<!-- assembled-fragment: 2443-sanctions-clearance-rehearsal.md sha256=e17c9211ff79898637ed5ba68eff07330e84e0a0d3dea0929a6f8f180a16d33f -->

## Thread — The cross-chain sanctions clearance is wired on the testnets (PR #2606)

The clearance route rehearsed in the previous change is now live on the three
test networks, with the owner's go-ahead. BNB testnet hosts the clearance
attestor and the labelled stand-in it reads in place of RedStone's Sanctions
Oracle, and its CCIP lanes to Base Sepolia and Arbitrum Sepolia are open. The
delisting timelocks on Base Sepolia and Arbitrum Sepolia now take their
clearance from that attestor, and both report automated delisting as open.
The clearance they wait for is the stand-in's answer, not RedStone's: the
stand-in flags only what the test network's admin flags and is only as current
as the admin's last update to it.

The BNB testnet deployment record and the shared deployments bundle now carry
the attestor and the stand-in, so the sanctions services and the app read the
same addresses the chain uses. The Base Sepolia and Arbitrum Sepolia records
are unchanged: their timelocks were already recorded, and only their on-chain
clearance source moved. The delister service's key now also holds 0.1 test
BNB on BNB testnet. Part of #2443, which stays open for the mainnet adder host
and RedStone's terms.
<!-- assembled-fragment: 2443-sanctions-clearance-wired.md sha256=1ea4670c32ea54870e2305534e64c240800a1e707c801535d1566ab94021248a -->

## Keeper — end-to-end scenarios on a local chain for the reward passes (PR #2604)

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
<!-- assembled-fragment: 2496-keeper-anvil-scenarios.md sha256=c5eb602f6ec05227c135c3d0616370a43b99ee43f2ccb294ee28e64321133465 -->

## Keeper — sanctions settlement and chain-lapse notices (PR #2602)

The keeper's sanctions-hold pass now tells operators, on the ops Telegram chat,
about two kinds of event that previously left no trace outside the chain.

When one of the keeper's own settlements or staging resolutions moves reward
value, a notice names the wallet, the transaction, and what moved: the amount
set apart for the wallet, any amount paid to its wallet or vault, a staged
payout of the wallet's that was forfeited, and the transaction's whole
forfeited-reward credit to the recycle bucket. Every figure is read from the
transaction's own events, not computed by the keeper, and each says whose it
is. The recycle credit names no wallet on chain, so it is reported as the
transaction's, and where part of a forfeited staged payout sits inside it the
notice says the two figures overlap instead of letting them read as two moves.
A transaction whose receipt arrives after the keeper stopped waiting is checked
again, all at once and within a short bound, before the alerts and notices go
out. A late receipt counts exactly as one seen in time: a late revert is
reported as a failure, a late successful settlement can clear a failure alert
the run had open, and a transaction whose outcome is still unknown is said to be unknown rather
than left untold.

When one of the keeper's own transactions restarts a held claimant's observation
chain, a notice names the wallet and when the new chain began, read from that
transaction's own event. The cause is stated only as far as the contract's state
proves it. A chain that had already lapsed when the run first read it is reported
as lapsed, with the gap given only as more than the maximum observation gap,
because the contract no longer reports its last observation. A chain that was
live at that read but lapsed while the transaction waited to be included is
reported with its last observation and the exact gap. Any other restart is
reported as one whose cause the run's reads do not determine. A transaction
whose broadcast got no answer may still have reached the chain, so it is now
treated as unknown and its receipt is looked up, instead of being counted as a
failure that moved nothing.

All of a run's notices go out as one post per chain, after the pass's standing
alerts, so a burst of them can never use up the time those alerts need. Each
notice is also written to the keeper journal, which names any the post could
not fit. They are best-effort and cover only the claimants the keeper touched in
that run. Part of #2515 (item 5); the pass still ships with its arming flag
unchanged.
<!-- assembled-fragment: 2515-sanctions-value-notices.md sha256=5ddb5f652c92778a83489bfbe2c57ae134441afc7c19fc10eb45571d48584e36 -->

## Thread — Delivery-proof alerts on every mirror (PR #2599)

The keeper's delivery-proof pass, which indexes or proves each reward budget delivery on every mirror so the day-delivery gate never holds a funded day for a manual step, now tells the operator when that work is not getting done. It already runs on the two testnet mirrors (Arbitrum Sepolia and BNB Testnet) but reported only to its log, and the governance runbook said to watch the log because the alerts were not built.

There are two alerts, both sent to the operations chat and kept separate per mirror. The first says that a delivery has arrived but is still not whole more than ten minutes later, which is one full scan after the first scan that could have reached it. It names each such delivery, oldest first, with when it arrived: as many as one message holds, with a count of the rest, while the keeper's log names every one on every run that finds it. A delivery the keeper has just worked on counts as whole only when a fresh read after its transactions shows it whole, never because the transactions went through: admitting a rollout-era delivery, for example, only opens the epoch its days are indexed into on a later run. The alert clears only after a run that looked at every open delivery on that mirror; a run that could not read some delivery, ran out of time before reaching it, or has not yet queued every delivery the indexer has recorded, may raise the alert but never clears it, and then says "at least" that many, oldest of those it could read, rather than presenting a partial count as the whole. The second says that a proof or index call was refused by the contract, naming the delivery, which of its days the call covered, and the contract's reason. A delivery proven in chunks is held back only by the chunk that was refused, since its other chunks prove on their own, while a list indexed page by page is held back only in the days its epoch has not indexed yet, and the alert says which. A call that never reached the contract, such as a provider timeout or outage, is not a refusal: it is not reported, and the next run tries again. Every refusal of a run goes out in one message, so many refusals cost one send rather than one each; it names as many as fit, counts the rest, and the keeper's log names every one. "Already indexed" and "already admitted" are never failures, because another caller or an earlier run got there first; that holds for a transaction that reverted after being mined too, which is checked again against the state it left before anything is reported. That alert clears once the delivery is whole, once a later run's calls for it all go through, or once the delivery is no longer open work at all, so an alert whose clearing was missed never stays open after the queue moves on. A refusal is reported even when the run is out of time, or when updating the work queue afterwards fails, because a later run may succeed and could not report it, while clearing an alert and the not-whole report wait for the next run, which can measure them again. A refusal for a delivery that the same run then found whole is not reported, since nothing is held back. Error text from the network is never copied into an alert, because it can carry the provider address and its key.

The issue asked for the user-facing bot; these alerts go to the operations bot instead, because the people who act on them are the operators. The runbook now says what "verified on a mirror" means before the irreversible day-delivery gate may be armed there: deliveries indexed or proven within those ten minutes, and neither alert open. The end-to-end scenario against a local chain follows in its own change. Part of #2516.
<!-- assembled-fragment: 2516-delivery-proof-alerts.md sha256=000ad3b5f21c8f06ffdcf729b24b61a9968c3460c76c1782db7314e6a9152899 -->

## Keeper — the reward claim-horizon heartbeat (PR #2596)

The reward claim horizon (RL-3, #1956) lets a reward that its owner never
claims be reaped into the recycle bucket, but only after the reward has stayed
claimable for the whole horizon plus a 90-day notice — measured as time the
owner could actually have claimed, not calendar time. That clock advances only
when something touches the reward, and nothing did: with the horizon switched
on, no clock would start, no final notice would be filed and nothing would
ever expire, while the setting read as live. The keeper now provides the touch.

The new keeper pass keeps a private list of every reward that is not yet
settled, read from the chain's own sequence of rewards, and touches each one
about every 12 hours, far inside the contract's 7-day limit on how far apart two
touches may be and still count. A touch on a reward that cannot advance changes
nothing. While the horizon is off, the pass only keeps its list current and
finishes the settlement of any reward whose removal had already begun; so it can
be armed first and the horizon switched on afterwards, and clocks start at once.
It reports to the operations chat when a touch is refused (naming the reward and
why); when a reward on its list has not been reached for two rounds, which
covers both touches that are not landing and more rewards than the pass can
reach (it handles at most 300 an hour per chain, about 3,600 per 12-hour round,
and the message says so); and when a reward's clock did not advance across two
landed touches, saying both readings: an owner who could not claim in that time
(expected), or touches landing without being credited (a fault). A stalled
clock is recognised by its removal estimate moving forward by exactly the time
between two readings, so a change to the horizon setting, which restarts the
notice and moves the estimate by days, is not mistaken for one. The pass reads
the protocol's pause state first: while it is paused it sends nothing and
leaves every one of these reports as it stands, raising none and clearing none.
Each transaction carries exactly the rewards just simulated together, so a
batch that only fails as a whole is split rather than resent. Rewards that keep
failing go to the back of the line, so they cannot hold a round's capacity
against the rest. Each run's log line says whether discovery has reached the
end of the reward sequence or is still catching up a long history. Its moves of value go only to the recycle bucket, never to
the keeper.

The pass ships disarmed behind its own flag, `REWARD_HORIZON_HEARTBEAT_ENABLED`,
and its list lives in a new private keeper database migration. The governance
runbook now states what "verified" means before the horizon is armed on a
chain. Part of #2517; the end-to-end scenario against a local chain follows
in its own change.
<!-- assembled-fragment: 2517-reward-horizon-heartbeat.md sha256=85cacae6b1d1ea149a719f910b0745da98a966dbadc3474b94642e8efe86e03c -->

## Keeper — the liquidator stops re-reading illiquid loans (PR #2605)

On Base Sepolia, while the only active loan had illiquid collateral, every
liquidator run logged "aggregate3 rejected … retrying serially" and then read
that loan a second time. Nothing was wrong with the RPC. An illiquid loan has
no health factor, so its read reverts by design. In a batch of one, that
loan's own revert matched the rule the keeper used to spot a rejected batch,
which was "every entry failed with the same error". So one loan's expected
answer was logged as an RPC fault and retried.

The shared batch reader now tells the two cases apart from what the error is,
not from how many entries share it. A rejected batch carries the error of the
batch call itself. A loan's own revert carries the name of that loan's read.
So a failure in a batch of one is that loan's own result, and a real rejection
of a batch of one is still retried loan by loan. The liquidator used to carry
its own copy of the batching and retry rules. It now uses the shared reader,
so there is one set of rules for every keeper pass that batches reads.

The liquidator also stops asking for a health factor that cannot exist.
Whether a loan is illiquid is fixed when the loan opens and never changes
afterwards. So once the chain has answered "illiquid" for a loan, the keeper
leaves that loan out of later scans for as long as it keeps running. It takes
that answer only from a finalized block. The scan itself reads the latest
block, which a reorg can replace, and a replaced block can give the same loan
number to a different, liquid loan; trusting the latest block alone could have
hidden that loan from liquidation. So a loan the latest block calls illiquid is
checked once more at the finalized block, and is read every run like any other
until the finalized block agrees. The keeper forgets a remembered loan once the
loan leaves the active list, including when the active list is empty. After a
restart, it learns the list again with one read per illiquid loan. Rentals
secured only by their prepayment also have no health factor, but they are
still read each run, because in their case the reason is the loan's
collateral amount rather than a fact fixed when the loan opened.

Each complete scan's line now ends with a count of the loans that have no
health factor (`noHealthFactor=N`), so the scanned count and that count add up
to the whole active book. Nothing on-chain changed. Closes #2579.
<!-- assembled-fragment: 2579-liquidator-no-health-factor.md sha256=3303b6880f961f8af6e65a2d80369c27789591f61edcb8b6482346d41c0f6081 -->
