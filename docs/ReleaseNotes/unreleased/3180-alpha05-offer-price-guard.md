## Thread — alpha05 shows and sets the price-move guard on an offer's page

The protocol now lets an offer's creator put a price-move guard on a loan offer of one token against another: once set, nobody can fill the offer while either token's price has moved more than the chosen limit since the guard was set, in either direction, or while the pair has not been calm against its last two hourly price checks. The new app's offer page now shows that guard to everyone who opens it, with its limit, when it was set, and whether a fill is allowed right now or refused and why, so a taker learns about a refusal before signing rather than at it.

The creator of an open offer can set the guard between 0.5% and 50%, change it, or remove it. Each change opens its own review, read at one block and dry-run against the protocol before signing. The review says what the guard does, that the prices are recorded at the change, that it only refuses fills and moves nothing, and whether the offer has a guard right now, so the creator knows a fill can still happen until the change lands. The finish card reads the change from the transaction's own event.

The guard reaches the test networks with the next fresh deploy. Until then the creator is told that this network's protocol has no guard yet, and nobody else sees a section. Arming a guard while posting an offer comes in a later slice.

Advances #3358 and #3180.
