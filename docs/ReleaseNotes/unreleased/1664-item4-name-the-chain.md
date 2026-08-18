## A documented figure now says which network's configuration it came from

The documentation's tunable figures — the fee rates, the tier thresholds, the
amounts computed from them — follow the published configuration of one
nominated network, because every supported network runs its own independently
tunable copy of the protocol and a wallet-free page cannot ask the reader
which one they mean. The marker on each figure, though, said only that the
value came from "the published protocol configuration", as if there were one.

That reads as universal, and it stops being true the moment two networks are
retuned apart: a reader on any other deployment would see a figure that is not
theirs, under a label asserting it is current. The marker now names the
network — "Live value from the published Base Sepolia configuration" — and the
fallback wording names it too, so a reader always knows which deployment was
consulted, whether the read succeeded or not.

The name is derived from the same setting that selects the deployment, not
written beside it as a second fact. If the nomination is ever pointed at
another network, the label follows automatically; a deployment the site does
not know a name for is labelled by its numeric identifier — ugly and honest,
rather than a prettier guess. Two records of one fact drift, and a provenance
label naming the wrong network would be worse than none.

Nothing about the figures themselves changes, and the machine-readable marker
that distinguishes published from bundled values is untouched — this names the
source more precisely; it does not change what the source is.
