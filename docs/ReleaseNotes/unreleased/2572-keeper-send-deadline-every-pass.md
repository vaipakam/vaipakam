## Keeper — every pass's sends honour its run deadline (#2572)

Every keeper pass now hands its run deadline to the send queue, and the queue
will not build a signing wallet without one. Before this change only the
delivery-proof, remit-acknowledgement and sanctions-hold passes stated a
deadline. The liquidator, the matcher, grace-default, auto-extend, the
reward-budget remit, the commitment report, the liquidity-tier relay and the
daily oracle snapshot did not, so a send from any of them could wait behind
another pass on the same key and then be signed after its own run was over.

A run's deadline is its scheduled minute plus its cadence, less a thirty-second
margin. A send whose turn in the queue comes after that point is refused before
it is signed. No nonce is spent and nothing reaches the network, and the work
is picked up by the next run from fresh reads. For the liquidator and the
matcher this is a deliberate behaviour change, chosen by the owner: a
liquidation or match that would have been signed late, priced from old state,
now waits for the next one-minute run instead. Passes that loop over loans,
days or mirrors also stop asking for more work once the deadline has passed,
and say so in the log, rather than queueing sends that would be refused.

The check lives in one place: the submission slot every keeper transaction
passes through, whether it goes out through the queued wallet or through the
keeper's own prepared sends (the internal-match liquidation and the in-kind and
grace-default close-outs). The slot needs a deadline to run at all. The type
system makes every pass state it, and the slot refuses at run time a missing,
non-numeric or infinite deadline, so a caller outside the typechecked sources
cannot switch the check off by leaving it out. A refusal is recognised however
the signing library wraps it, and the liquidation routes that catch their own
send failures hand it on rather than reporting it as their own failure. The fallback deadlines three passes used when no tick was supplied are
gone. Closes #2572.
