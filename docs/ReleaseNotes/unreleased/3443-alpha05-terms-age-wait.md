## Thread — alpha05: how long a just-changed offer must wait before a fill

The protocol now takes an offer only once its terms have stood a few seconds (#3443, default five, set by the admin up to a minute). The new app already named this refusal; its review now gives the protocol's own figures instead of only "try again shortly": how long terms must stand, and how long was left at the block the review read. Both are read at one block, from the offer's terms time, the minimum age and the block's time.

No step to sign is shown while the refusal stands. The review reads the chain each block, so the refusal lifts by itself once the time is up. When those figures cannot be read, the review keeps the plain refusal, which says it lifts within seconds.

The rule reaches the testnets with the next fresh deploy; until then no live offer carries it.
