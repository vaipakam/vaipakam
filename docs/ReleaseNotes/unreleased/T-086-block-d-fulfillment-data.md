## T-086 Block D follow-up — OpenSea Fulfillment Data unblocks fee-enforced collections

PR #346 (T-086 Block D atomic match-rotation) shipped with a
fail-closed placeholder for Seaport SignedZone offers — collections
that enforce creator fees via OpenSea's SIP-7 SignedZone contract.
The agent's signed-offer proxy detected those orders and returned a
`422 opensea-fee-enforced-needs-fulfillment-data` response so the
dapp could show a clear "not yet supported" message instead of
routing a doomed match to Seaport.

This change retires the placeholder. The proxy now wraps OpenSea's
Fulfillment Data endpoint instead of the single-order GET. OpenSea
returns the canonical Seaport order parameters, the bidder
signature, the SIP-7 `extraData` blob, AND a properly-shaped
`CriteriaResolver[]` for criteria offers — all in one upstream call.
Fee-enforced collections (Blur-style royalty enforcement, Yuga
collections, etc.) can now be matched atomically through the same
`matchOpenSeaOffer` path every other collection uses; criteria
offers (collection-wide bids on a trait) now settle via the real
resolver shape Seaport expects instead of raw Merkle proofs.

The proxy URL gains a required `?fulfiller=<vaultAddress>` query
parameter — OpenSea's fulfillment-data endpoint needs the fulfiller
address to validate creator-fee receivers and apply the correct
SIP-7 signature scope. The dapp resolves the borrower's vault
address before the Match button is reachable (the Match button only
renders for the position-NFT holder, who is by construction the
loan's borrower with a deployed vault).

No on-chain changes; this is an off-chain proxy / dapp wiring
change only.
