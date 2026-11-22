## Thread — A gas-starved price read in the offer floor is no longer read as "no price"

Posting an offer checks a small value floor, and that check reads the lending
asset's liquidity and value. Both reads were best-effort: if either failed, the
offer was admitted without the floor. A read that failed only because the
transaction had too little gas counted as a failure too, so a wallet's gas
estimate could settle on the limit at which the floor was skipped. The offer
then ran out of gas a few steps later. This is the same class of fault #3504
closed for the other best-effort price reads, and it is what made the
fork-tier end-to-end desk scenarios fail intermittently.

The floor's two reads, the shared best-effort valuation used by analytics, the
fee log and the cadence and treasury thresholds, and the seller claim's
in-kind cover check now tell the two cases apart. A read the price rule
refuses is still treated as before. A read that ran short of gas stops the
transaction with the named out-of-gas error, so a gas estimate always covers
the reads. The price guard and its gas budget are unchanged.

Advances #3504.
