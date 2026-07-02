## Thread — Deploy-script swap-adapter phase hardening (#862)

Follow-up hardening from the BNB-testnet oracle work (#860). None of these change
the deployed state of any chain; they make the deploy tooling correct for the
edge cases that surfaced while wiring an on-chain DEX (PancakeSwap) swap adapter
into the deploy flow for chains that have no 0x backend.

The main change relaxes an over-strict coupling between two deploy phases. The
oracle-configuration step used to hard-fail unless a liquidation-swap adapter was
already registered on-chain in a specific slot order, which cascaded into a series
of adapter-index edge cases. Slot ordering properly belongs to the swap-adapters
phase and the keeper's per-chain routing map, so the oracle step now only emits an
advisory warning about slot ordering rather than blocking on it. It still keeps a
hard gate on the essentials: the adapter list must be non-empty (an oracle config
run before any swap adapter is registered still refuses, because every liquidation
would otherwise revert), and its own inputs must be coherent (the 0x
proxy/allowance-target pair, and that only chains without a 0x backend may omit
them). In short: adapter *existence* is a hard requirement; adapter *ordering* is
advisory.

The remaining fixes: the swap-adapters phase no longer registers the 0x/1inch
aggregator adapters on a chain that has no 0x backend even if a stale settings
value is left in a shared env file (they would be useless and would displace the
on-chain DEX adapter from the slot the keeper expects); on such no-0x chains the
deploy now hard-requires the on-chain DEX router up front, since that adapter is
the sole liquidation route there; re-running the swap-adapters phase to add the
DEX adapter after the aggregators already landed skips a duplicate aggregator pair
based only on that phase's own dedicated completion marker (an older, ambiguous
combined marker is deliberately NOT treated as proof the aggregators ran); and the
DEX-adapter deploy now requires the configured factory address up front — resolved
under the same env-var name the oracle step uses — so a missing/misspelled value
can't skip the same-DEX safety check.
