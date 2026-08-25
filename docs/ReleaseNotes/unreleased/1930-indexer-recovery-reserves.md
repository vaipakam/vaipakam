## The published backing figures now include every amount subtracted from them (#1930)

The platform publishes how much of the recycling balance is unspent. That figure
is a remainder: it is what is left once each reserved class has been taken out.
Two of those classes — value quarantined while it is in transit back to the main
chain, and value set aside against a recovery position — were being read from the
contract and then dropped before the figure was stored, so they never reached the
page.

The effect was not a wrong number. The remainder itself was right. What was
missing was any way for a reader to check it: given only the answer and some of
the amounts subtracted to reach it, the arithmetic does not close, and there is
nothing on the surface to explain the gap. Those two amounts exist in the contract
specifically so an outside reader can reproduce the calculation instead of taking
the platform's word for it, which is the whole point of publishing the series.
Both are now stored and published alongside the figure they help explain.

Readings taken before this change do not carry the two new amounts, and they are
still served. A reading that predates the addition is a complete record of
everything it claimed to hold at the time, and the two newer amounts are simply
reported as not determinable for it. The alternative — treating those readings as
unusable — would have blanked the backing figures until fresh ones were taken, an
outage caused by improving the disclosure.

This does not change what the deployed contract returns. A separate operator step
is still needed before the two amounts appear on the live network; until then the
new fields stay empty, and nothing else about the surface changes.
