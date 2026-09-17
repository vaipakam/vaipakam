### The indexer now counts the requests it makes, instead of estimating them

Each run of the indexer is allowed a fixed number of outbound requests before
the platform stops it. Until now, the indexer did not count them. The figure
lived in a note written by hand, and that note was corrected three times in
three consecutive reviews — and was wrong each time. Every correction came from
a person re-reading the sum, because nothing in the running system knew the
number.

Being wrong about it has a specific cost. Going over the allowance does not make
a run slower; it stops the run before it records how far it got. The next run
starts from the same place and does the same thing, so a chain can stop moving
forward entirely while appearing to run normally.

The indexer now keeps a live count of what a whole scheduled run spends. The
allowance belongs to the run, not to any one job inside it, and a run does
several things at once — reading the chain, catching up records, retrying an
earlier listing that failed to publish, tidying old rows. Counting each job
separately would have produced several comfortable-looking numbers for a run
that had already been stopped. There is now one count, and every job draws on
it: reads from the chain, reads and writes to the indexer's own database, the
credentials it fetches at the start, and the listings it sends to the
marketplace.

Two details are worth stating because they are what made hand-counting
unreliable in the first place. Several database statements sent together travel
as a single request, not one each. And a statement that is prepared but never
sent on its own costs nothing. A count that got either of those wrong would be
a confident number that was still incorrect, which is what was there before.

Those statements are also why there are now **two** counts rather than one.
The platform sets two separate allowances — how many requests a run may send,
and how many database statements it may submit — and they are the same size on
the tier this is built for. A batch sent together is one request but many
statements, so one number would have had to be wrong about one of the two: it
would have reported a comfortable figure for a run about to be stopped for its
statement count. Both are counted and both are reported, and a run that passes
either one says so.

A third detail was found by review of the first attempt, and it is the reason
this note no longer claims more than it should. The counting originally wrapped
the two objects the run was known to use, and was described as if it counted
everything the run sent. It did not: a failed read is retried automatically up
to three more times, and those attempts were invisible; a second reader built
elsewhere in the run was invisible; and the message sent to the marketplace was
invisible. The counting now happens where requests actually leave — so a retry
costs what a retry costs, and code that knows nothing about the allowance is
counted anyway.

Two things follow from that, and both are deliberate. Every run reports what it
spent, including runs that end early or fail — the ordinary figure is the one
worth having, and it was previously reported only on the busiest path. And when
a run does pass its allowance, it says so at the moment it happens rather than
at the end, because by the end the run may no longer be alive to say anything.

Review found two further places the count fell short, and both are now closed.
A run is counted to its own end rather than to the end of its main job — the
step that tells connected apps what changed reads records too, and a figure
published before it ran was short by that much.

The second is a deliberate change in behaviour and is worth stating plainly.
A request answered with "this has moved elsewhere" used to be followed
automatically, and each move is a further request that the count did not see.
Following them and counting each one was tried first, and it meant
reproducing the web's own forwarding rules — which method survives which kind
of move, which requests keep their body, what happens to credentials when the
new address is on another host. Review found three separate places where that
second copy of the rules did not match the original, which is what a second
copy of anybody's rules does.

So these runs no longer follow. A moved address is reported, naming where the
request was being sent, and the request fails there. What these runs talk to
is a configured address for each network, a marketplace and the platform's own
services — none of which should be moving — and if one does, the fix is to
correct the configured address rather than to have the indexer quietly follow
a provider somewhere new. The count stays exactly right either way, which is
the property the rest of this work exists to establish.

What is still not counted is stated in the code rather than left to be
discovered: requests served to visitors of the public read endpoints are a
separate allowance and a separate count.

This is the groundwork for the allowance being enforced rather than only
observed. The figures the indexer works to are still the conservative ones set
while the true cost was unknown; now that it can be measured, they can be set
from evidence.
