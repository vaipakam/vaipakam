## Keeper — risky-loan and pre-grace warnings send through the shared Push sender (PR #<n>)

The keeper sends two kinds of Push alert: the warning when a loan's health
gets risky, and the warning before an auto-refinance loan reaches its grace
period. Until now it sent them with its own copy of the Push sender, which had
drifted from the agent's: it could not post as a delegate of the channel, and
when it had no usable signing key it printed one "skipping" line per
subscriber and said nothing else. It now uses the same shared sender as the
agent, so a correction to the sender lands once for both.

Two things change for operators. The keeper reads `PUSH_CHANNEL_ADDRESS`, the
channel to post as, from its machine's env file, exactly as the agent reads
it. With it unset the keeper posts as its signing key's own address, as
before; set it in both places, or the two senders post as different channels.
And each warning pass now reports what Push did not do in one line: how many
alerts Push could not send, with the reason (no signing key, a key that cannot
be used, or a malformed channel address), and how many sends failed. Failed
sends are never counted as delivered. Part of #2248.
