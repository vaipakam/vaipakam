## Connected app — liquidation quotes and loan totals stop showing the previous answer (PR #1759)

Two more lookups get the treatment from PRs #1753 through #1756.

The liquidation quote panel is the one that matters. A quote is a price for a
specific loan, on a specific network, for a specific size — so the previous
loan's ranked venues shown against a different loan is not stale decoration, it
is a number someone would act on. The panel now labels each quote with the whole
request it answers, and reports that it is still working rather than showing the
earlier answer. Closing and re-opening the panel re-quotes rather than showing a
price fetched before it was closed, and the explicit refresh button is included
in the label, since that button exists precisely to obtain a newer price.

The loan totals behind the analytics cards were keyed to nothing at all, so
switching networks showed one network's totals under the other's name until the
new figures arrived. They are now labelled with the network they describe.

One distinction worth stating: the periodic background refresh does **not**
count as a new question. It asks the same thing hoping for a fresher answer, so
the charts keep their current figures while it runs instead of blanking on every
tick. Only a genuine change of question — a different network, loan, or size, or
an explicit press of refresh — clears what is on screen.
