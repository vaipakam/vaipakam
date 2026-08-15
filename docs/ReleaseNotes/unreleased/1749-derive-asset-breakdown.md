## Connected app — the asset breakdown stops mixing two networks' figures (PR #1761)

The analytics page shows a per-asset breakdown of loan volume, including each
asset's percentage share of the total. Those rows carried no record of which
network or which asset set they were computed from, so switching networks left
the previous network's breakdown on screen beside the new network's headline
totals until the reads finished.

That combination is worse than an ordinary stale figure, because a share is a
proportion *of a total* — showing one network's percentages next to another
network's total presents an arithmetic that does not hold. The rows are now
labelled with the network and the exact set of assets they describe, and the page
reports that it is still working rather than showing the earlier set.

The analytics page itself needed a matching change. It had been treating "no
rows yet" as "no loan volume", which was harmless while the rows were merely
stale but became a confident and wrong "there is nothing here" once they
correctly go blank between networks. It now says it is loading, and only reports
no volume once something has actually answered.

Two states are deliberately kept distinct. "The indexer is offline" is a settled
answer, not a pending one, so the page keeps rendering its own placeholder for
that instead of spinning forever. And a network with no assets to break down is
also an answer — an empty breakdown — rather than something to wait for.
