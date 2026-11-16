## New app: why an open offer is not matching

The page of an open offer you posted in the new app now says why it has not matched yet. It looks at the open offers on the other side of the same pair that sit closest to yours, reads each from the chain, and asks the protocol whether each pair would match now. The reason shown is the protocol's own.

It states one thing: that nothing stands on the other side yet, that matching is off on the network, that a pair would match now (with the offer and the rate), or the closest offer's gap. A rate gap gives both rates and a term gap gives both terms. A gap in how the loan runs names the option that differs: interest mode, partial repayment, prepay listing or the interest schedule. The closest offers, each with its verdict, are one tap away, and the Offers list links each open offer to this section.

The ranking comes from a new indexer route, `/offers/:id/nearest`, which serves the other side's open offers on the pair, closest rate range first, and how many there are. It is a cache ranking only: the page never names a gap the protocol has not confirmed, and a failed index read says the closest offers are unknown rather than that there are none.

Nothing is promised: another taker can reach an offer first. This app cannot change an open offer yet, so for now the page says the way to close a gap is to cancel and post again. This is #3623 and needs no contract change. The rule is in the rulebook as RB-WHY-MATCH.
