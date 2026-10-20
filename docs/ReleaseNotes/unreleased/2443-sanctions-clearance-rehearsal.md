## Thread — Rehearsing the cross-chain sanctions clearance on testnets (PR #<n>)

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
