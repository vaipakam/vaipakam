## Thread — alpha05 says which holding rule holds a fee-discount tier down

The Rewards page of the new app already said when the holding rules kept a wallet's fee-discount tier below what its counted VPFI alone would give, but not which rule, because the protocol did not report it. The protocol now explains a tier rule by rule, and the card names the rule from that explanation: no holding recorded yet, a holding younger than the minimum holding period (with the moment that period ends), a weighted average in a lower tier, or a dip to a lower tier during the look-back over the current holding. The explanation is read at the same block as the tier the fees use, and only used when it resolves that same tier; otherwise the card says why could not be read and names no rule.

While the fee-discount consent is off, the card now also says which tier would apply with it on. In Advanced mode the card lists each rule's figure for the wallet (the counted VPFI and its tier, when the current holding began, the end of the minimum holding period, the weighted average and its tier, the lowest tier in the look-back) and this network's settings for the rules, with the average's window and the look-back stated as two separate lengths.

The explanation reaches the test networks with the next fresh deploy; until then the card there states the tier and says why could not be read.

Advances #3459 and #3180.
