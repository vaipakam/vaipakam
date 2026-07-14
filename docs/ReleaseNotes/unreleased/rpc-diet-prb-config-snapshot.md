# RPC read-diet PR B — display config from the indexer snapshot

Second phase-2 slice of the Alpha02 RPC read-diet design (§4.2.1).
Governance-tunable protocol config — the fee bundle, the NFT-rental
prepay buffer, and the range/partial master flags — was chain-only:
every browser re-read it on five-to-ten-minute caches even though it
changes only on rare governance action.

The indexer now maintains a one-row-per-chain snapshot of that config
and serves it at a public endpoint. It refreshes the row whenever an
ingest scan sees a governance setter event (so a retune reaches the
snapshot within about one scan) and on a slow time backstop, always
fail-open: a refresh problem can never block ingest, and the apps fall
back to their live chain read whenever the snapshot is missing or has
gone stale.

The connected app's DISPLAY hooks (protocol fees, rental buffer, master
flags) read the snapshot first — zero per-user chain reads for config —
and keep the chain read as the fallback. The boundary is unchanged and
deliberate: anything a user signs against is still read live from the
chain at submit time, and the master-flag-gated execute paths still
live-check before the write.
