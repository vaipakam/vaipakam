## Thread — alpha05 rate desk: the markets and a market's rate ladder

The new app's rate desk, an Advanced page, now shows the open token loan book as markets and ladders. A market is one lending token against one collateral token for one term. The list comes from the protocol's index and states each side's count and best rate, says when the index listed only its deepest markets, and counts rows it could not read. Like the offer book, nothing is read before a wallet connects on a served network.

Choosing a market opens its rate ladder: lenders' offers from the lowest rate up and borrowers' requests from the highest rate down, each at the rate it binds when the other side takes it. Each rate step says how many offers stand there and their open amounts added up, and says plainly that this total is depth, not one amount: every offer is still taken on its own. The middle rate is worked out from the best two rates and labelled as such, a crossed ladder is stated, and every offer links to its own page, which reads it from the chain before anything is offered. Offers nobody can take at that market (expired, sale or early-close vehicles, offers bound to a moved loan position, fully filled ones, other terms) are left out and counted by reason.

One note above every view says what the desk cannot yet show: the index counts gasless signed orders in each market, but the desk does not list them yet, so a ladder can list fewer offers than its market counts, and the ladder then says both numbers. A failed read is stated, never shown as an empty desk.

A Basic-mode reader who reaches an Advanced page by its address now sees an orientation card on top: what the page is, the guided pages that do the same job (Borrow and Lend for the desk), and a switch to Advanced. It is never shown in Advanced mode and hides for good once dismissed.

The order ticket, signed orders, open orders, the fills tape and chart, and the desk's positions and history follow in later slices. Advances #3180.

> Caveat: signed orders are counted in the market list but not listed on the ladder until the signed-order slice lands.
