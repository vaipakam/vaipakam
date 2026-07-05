## Thread — offer deep links work the moment the transaction mines

Sharing or opening a "?offer=" deep link right after posting an offer
could show "We couldn't find that offer" for the length of the
indexing service's ingest window — the offer page resolved its id
from the indexed data alone. It now falls back to reading the offer
live from the chain when the indexed lookup misses (the same fallback
the loan page has had since the claim-center work), so a link works
the moment the transaction mines. A true not-found (no such offer id)
still reads as not found, and a transport failure still reads as
unavailable. Found by live-testing the two-illiquid-token flow on
Base Sepolia.
