## Reading queued governance changes from the chain (#3237, part 1)

Every admin change waits out the governance timelock's delay before it can run. That wait is only useful if people can see what is waiting. This change adds the shared reader that the public "queued changes" page and the ops alert will both use.

The reader takes the list of queued operations from the timelock's own storage, and reads every value at one block. The timelock stores only each operation's id and the earliest time it can run, not the call itself. So the reader finds the block the operation was scheduled in and reads the schedule record from that block's logs. It then recomputes the operation's id from the calls it found. Only calls that hash to the id stored on chain are reported. A wrong index or a misbehaving endpoint can leave an operation's details unknown, but cannot make them wrong. An operation whose details could not be found is still listed, with its time and the reason its action is unknown.

A second step turns each call into data a page can put into words: the contract it targets, the function and its arguments, role names where a role is involved, and a recognised kind for the common changes (a code change to the Diamond, a role granted or revoked, a new delay, a pause, an ownership move or an upgrade). A call that cannot be decoded is reported as such, never guessed.

Advances #3237. Nothing user-facing changes yet: the page and the alert follow.
