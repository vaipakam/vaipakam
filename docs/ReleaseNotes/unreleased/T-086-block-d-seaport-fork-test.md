## T-086 Block D — Seaport hash-rederive fork test on Base-Sepolia

Adds a forge fork test that exercises the real Seaport 1.6
deployment at the canonical address against a Base-Sepolia fork to
confirm the §17.5 on-chain hash re-derive invariant the atomic
match facet relies on. The unit-test `MockSeaport` uses
`keccak256(abi.encode(components))` for determinism but doesn't
match the EIP-712 typed-data digest real Seaport produces. The
fork test fills that gap.

Two phase-1 assertions:
- Real Seaport's `getOrderHash` is deterministic + non-zero for a
  well-formed bidder OrderComponents struct.
- Real Seaport's `getOrderStatus` for a freshly-constructed
  off-chain-signed order returns the
  `(isValidated=false, isCancelled=false, totalFilled=0,
  totalSize=0)` shape the atomic facet's early-fillable check
  passes for.

Gated by `FORK_URL_BASE_SEPOLIA`. Silently skipped when the env is
empty so CI without an archive-node URL passes — same fail-soft
pattern the Permit2 real-fork test uses.

The full `matchAdvancedOrders` happy-path settlement walkthrough
(conduit registration, ERC-1271 vault sig, both orders signed +
matched end-to-end) is a richer phase-2 follow-up — it needs a
whole diamond deployed on the fork + a real ConduitController
interaction. Phase 1 locks the hash-rederive contract; phase 2
will add the full settlement walkthrough.
