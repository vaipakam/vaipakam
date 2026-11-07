## Reading queued governance changes from the chain (#3237, part 1)

Every admin change waits out the governance timelock's delay before it can run. That wait is only useful if people can see what is waiting. This change adds the shared reader that the public "queued changes" page and the ops alert will both use.

The reader takes the list of queued operations from the timelock's own storage, and reads every value at one block. The timelock stores only each operation's id and the earliest time it can run, not the call itself. So the reader finds the block the operation was scheduled in and reads the schedule record from that block's logs. It then recomputes the operation's id from the calls it found. Only calls that hash to the id stored on chain are reported. A wrong index or a misbehaving endpoint can leave an operation's details unknown, but cannot make them wrong. An operation whose details could not be found is still listed, with its time and the reason its action is unknown.

A second step turns each call into data a page can put into words: the contract it targets, the function and its arguments, role names where a role is involved, and a recognised kind for the common changes (a code change to the Diamond, a role granted or revoked, a new delay, a pause, an ownership move or an upgrade). A call that cannot be decoded is reported as such, never guessed.

Advances #3237. Nothing user-facing changes yet: the page and the alert follow.

### The public page (#3237, part 2)

The new app has a page listing queued governance changes, reached from the footer and needing no wallet. For the network on screen it lists every change waiting in the governance timelock, soonest first. Each change shows when it can run, what it will do in plain words (a code change to the protocol contract, a role granted or removed, a new minimum wait, a pause), and its exact call. The page always states the block it read the queue at. A change whose action could not be proved is listed with its id and the reason. A network with no timelock, or a failed read, is stated as such and never shown as an empty list. The page also says that a queued change stays runnable until it is run or cancelled. All three testnets had nothing queued when this was built.
