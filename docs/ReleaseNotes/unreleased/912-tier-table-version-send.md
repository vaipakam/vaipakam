## Thread: send the tier-table version to each mirror (branch, contract batch)

When governance changes the discount tier thresholds or the per-tier discounts, Base raises its tier-table version, and every mirror should stop honouring tier caches stamped with the old table. A message for that existed on the reward messenger, but nothing ever sent it. In practice a mirror only learned the new version from the next user who acted on Base, so until then it could keep granting discounts under a table governance had already replaced.

There is now a step on the Diamond that sends Base's current version to one mirror. Anyone may call it. The caller pays that lane's fee and gets the rest back, so the protocol budget never pays for repeats. The version is always read from Base's own storage, and a mirror never lowers a version it already holds, so a repeated or late send changes nothing. A chain off the broadcast list is refused. A quote and a read of Base's version come with it.

It sends to one mirror per call by design, the owner's choice over the old loop to every mirror. That loop would have had to be paid for in the governance call, and a single lane that could not be routed would have failed the whole send. The loop and its quote are deleted from the messenger.

The keeper pass that compares each mirror's version with Base's and sends where a mirror is behind ships disarmed. It lands with the contract batch, and until then the step is recorded as a gap in the permissionless-steps ledger.

Advances #912.

> Caveat: until a mirror receives the version, it keeps honouring caches stamped with the old table. The send invalidates old caches, but it does not give dormant users fresh ones; they read as no discount on that mirror until their own next tier push.
