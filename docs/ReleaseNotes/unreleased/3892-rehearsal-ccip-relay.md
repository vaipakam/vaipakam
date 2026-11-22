## Deploy rehearsal — the CCIP relay between forks (PR #3903)

The deploy rehearsal can now carry a cross-chain message between its local
forks of the testnets. On the sending fork nothing is replaced: the
protocol's messenger sends through the real CCIP router and on-ramp, which
charge their real fee. On the receiving fork the code at the real off-ramp's
address is replaced with a harness stand-in, so the real router and the real
token pools still check who may deliver, and a pool still releases or mints
under its own rate limit.

The relay reads the messages the sending on-ramp emitted and hands each one
to the stand-in exactly as emitted; it never composes one. The receiving
contract is called with the message's own gas limit, so a receiver that would
run out of gas on the real lane fails in the rehearsal too, and a failed
delivery fails the step. A plan step that waits for a message names the
transaction that sent it, and the relay delivers that message before the step
continues. Each delivery is recorded with its id, fee, gas limit and gas used.

The testnet lanes run the 2.0.0 version of the CCIP ramps, so the stand-in and
the relay speak that message format. Before installing, the relay reads each
lane's ramps from the routers on the forks and refuses any ramp of another
version by name; the older off-ramps a router still lists are reported, not
used.

The report states what this does not rehearse: the messaging network's own
verification, its delays, manual execution, and the gas-limit override a
manual execution may carry.

Advances the deploy rehearsal (design docs PR #3898). Closes #3892.

> Caveat: the relay refuses any node that is not on this machine; the check that a node is a marked rehearsal fork arrives with the rehearsal mode itself (#3891).
