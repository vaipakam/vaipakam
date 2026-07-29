## Thread — Two untested paths in the three-chain mesh harness (PR #TBD)

The end-to-end mesh suite exercises three real deployments talking to each
other, but two operationally important paths ran at zero in every case it
contained. Both are now covered.

The first is the platform funding a chain that cannot fund itself. Reward
funding resolves in two passes: each chain covers what it can from its own
recycled balance, then the canonical chain tops up whatever is left over
from its remaining balance. Every existing scenario gave both mirror chains
far more than they needed and gave the canonical chain nothing to fund
with, so the second pass never ran once. A change that disabled top-ups
altogether, or booked their reservation against the wrong ledger, would
have passed a suite calling itself a three-chain end-to-end test — while
underfunding any live chain whose own balance fell short.

Getting a shortfall to occur at all is the interesting part, and it is why
this sat undone. A chain's spare capacity and its share of the reward
target are coupled through the same figure: what it reports having
absorbed. Simply giving a chain a smaller balance also shrinks its
contribution to the protocol-wide absorption average, which shrinks the
target the shortfall would be measured against, and the gap closes itself.
The fixture keeps the daily absorption feed high while the balance stays
low, so a genuine gap survives.

The two passes are pinned separately rather than by their total, which
could not tell them apart. The canonical chain is given a balance but **no
reward demand of its own**, so its reservation consists entirely of top-ups
for others; the other mirror stays comfortable, so it contributes nothing
to that pool. Removing the top-up pass fails this test and nothing else.

The second path is a missing day closed the way operators actually close
it. An existing case drops a chain's report and immediately accepts the
next day, leaving the incomplete day open forever. In practice the day gets
force-closed: the silent chain is dropped from that day's totals and marked
ineligible for remittance pending reconciliation, and only later does a
fresh report restore its capacity. The interaction between those two was
untested.

What this pins is that the day-4 exclusion **survives** the later healing.
Capacity recovering must not quietly re-admit a chain to a day's totals it
was never part of — those are separate facts about separate days. Worth
recording that the ineligibility marking only happens on an armed day,
since that is when there are commitments to be remitted at all; an unarmed
fixture exercises only the weaker half.

Closes #1442. Test-only — no platform behaviour changes.
