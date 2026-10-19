## Keeper — every pass's sends honour its run deadline (#2572)

Every keeper pass now hands its run deadline to the send queue, and the queue
will not build a signing wallet without one. Before this change only the
delivery-proof, remit-acknowledgement and sanctions-hold passes stated a
deadline. The liquidator, the matcher, grace-default, auto-extend, the
reward-budget remit, the commitment report, the liquidity-tier relay and the
daily oracle snapshot did not, so a send from any of them could wait behind
another pass on the same key and then be signed after its own run was over.

A run's deadline is its scheduled minute plus its cadence, less a thirty-second
margin. A send whose turn in the queue comes after that point is refused, and so
is one whose preparation runs past it, at the last moment before broadcast. No
nonce is spent and nothing reaches the network, and the work is picked up by the
next run from fresh reads. (A send refused at that last moment may already have
been signed locally; the bytes are discarded, never sent.) For the liquidator and the
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
send failures hand it on rather than reporting it as their own failure. Every
pass logs such a refusal the same way, as "deferred to the next run: the run
deadline passed before broadcast, so nothing was sent", never as a
failed broadcast, so an operator reading the log is not sent looking for a
transaction that was never made. Real failures keep each pass's existing
wording. The fallback deadlines three passes used when no tick was supplied are
gone. Closes #2572.

Two passes needed more than the send check. The liquidity-tier relay now also
stops starting new assets and chains once its deadline passes, so a slow quote
source cannot hold back the next run's fail-safe demotions. When a tier change
it decided on is not sent, for any reason, it keeps the evidence that qualified
the change, so a promotion is retried next run instead of starting a new
qualifying window. The daily price snapshot is the one pass whose sends carry a
later deadline: an hour before the end of the UTC day being captured. The pass
acts only in the first ten minutes of the day, so a capture refused at its last
run's deadline could never be retried and the day's price would be missing for
good. Nothing in a capture goes stale within its day, because the Diamond reads
the prices when the transaction executes. The hour is left for inclusion: the
Diamond files a capture under the day of the block that mines it, so one mined
after midnight would fill the next day's slot. The keeper now records the day
the mined block actually filed it under, not the day it meant to capture, says
so in the log when the two differ, and records nothing for a capture that
reverted.

A deadline only defers work if the next run can reach it, so every pass that
works under one follows three rules. Chains now run side by side rather than one
after another, so a slow chain cannot use up the window of the chains after it.
A list walked in a fixed order (the liquidator's loans, auto-extend's loans,
the tier relay's assets, the reward-budget remit's mirrors) starts at a point
that moves each run, so the deadline never cuts off the same tail every time.
Every scan that reads a list in pages (the liquidator's and auto-extend's
loans, the tier relay's asset discovery, and the matcher's offers, lender
intents and repaid intent loans) moves its start by item, not by page, spread
evenly over the list from run to run, so a run that stops partway through its
first page does not leave the rest of that page unreached. For the tier relay
this also changes which assets its per-run cap admits, which before always came
from the start of the book. And a pass that reads before it sends (the
liquidator's scan, the commitment report's entry scan, the reward-budget
remit's planning, the tier relay's asset discovery, the matcher's listings and
offer reads) stops reading early enough to leave its sends ten seconds, and
acts on what it read. The tier relay and the matcher read each page's details
before listing the next page, so a run stopped partway always has something to
act on.
The commitment report also records how far it got when a batch is not sent, so
the next run continues from there instead of repeating the same scan. A scan stopped that way acts on what it read and is not
reported as complete. Auto-extend now acts on each page of loans as it reads it,
rather than reading the whole book first. When a tier change is sent, its
transaction is logged before any bookkeeping, and a bookkeeping failure no
longer stops the other assets. Evidence gathered toward a promotion now counts
only while the chain is still at the tier it was gathered at. The grace-default summary
now counts the loans it actually attempted separately from the loans it picked,
so a run the deadline stops early does not report an attempt it never made.
