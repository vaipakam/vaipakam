## Thread — positions hydrate in one read instead of one per position

The retail app's chain-authoritative "My positions" discovery now
hydrates all of a wallet's offers and loans through the protocol's
batch views: one network read per 250 positions instead of two reads
per offer and one per loan. Nothing changes in what the user sees —
the same rows, the same statuses, the same freshness — but the page
leans far less on the public RPC endpoint, which matters exactly when
a wallet holds many positions and the per-row fan-out used to be
noisiest.

On networks whose deployment doesn't carry the batch views yet, the
app detects that in-flight and quietly uses the previous per-position
reads — the switch activates by itself once the upgraded views are
deployed, with no app release needed. Single-position lookups (a deep
link to one offer) keep the direct single read: a batch of one gains
nothing.
