### Offer Book: just-ended offers vanish even while the cache lags (alpha02)

The shared Offer Book (and every guided flow that reads it — borrow
and lend matching, rentals, early exit) now double-checks the chain
before rendering (#1029). The market cache is refreshed continuously,
but during any ingest lag it could briefly keep showing an offer that
was just accepted, cancelled, matched, or consumed by a loan sale —
inviting a user to pick it and hit a doomed transaction. The app now
scans the slice of chain history the cache hasn't ingested yet and
strips any offer the chain already marked as ended.

The check is deliberately one-sided and fail-open: it only removes
ghost rows (brand-new offers surface on the next cache refresh,
seconds later), and if the scan itself fails for any reason the book
simply renders the cache state it always rendered — the safety layer
can never make the book unavailable. If the cache is very far behind,
the scan steps aside entirely rather than hammering the network, and
the existing "this list may be behind" note covers that state.

Porting this from the primary app also fixed a latent bug there in
passing: the event signatures the primary app scans for had silently
drifted from the deployed contracts. alpha02 derives them from the
compiled contract ABI, so a future contract change breaks tests
loudly instead of silently disabling the safety net.
