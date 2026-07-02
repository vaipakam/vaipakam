## Thread — Deploy-script swap-adapter phase hardening (#862)

Follow-up hardening from the BNB-testnet oracle work (#860). None of these change
the deployed state of any chain; they make the deploy tooling correct for the
edge cases that surfaced while wiring an on-chain DEX (PancakeSwap) swap adapter
into the deploy flow for chains that have no 0x backend.

The main change decouples two deploy phases that had become entangled. The
oracle-configuration step used to hard-fail unless a liquidation-swap adapter was
already registered on-chain, which forced a specific phase ordering and cascaded
into a series of adapter-index/marker edge cases. That responsibility properly
belongs to the swap-adapters phase and the keeper's per-chain routing map, so the
oracle step now only emits an advisory warning when the on-chain liquidation
route looks unusable, rather than blocking. It still strictly validates its own
inputs (the 0x proxy/allowance-target pair, and that only chains without a 0x
backend may omit them).

The remaining fixes: the swap-adapters phase no longer registers the 0x/1inch
aggregator adapters on a chain that has no 0x backend even if a stale settings
value is left in a shared env file (they would be useless and would displace the
on-chain DEX adapter from the slot the keeper expects); re-running the phase to
add the DEX adapter after the aggregators already landed no longer risks
deploying a duplicate aggregator pair (the pre-existing phase marker is now
honoured as "aggregators already done"); and the DEX-adapter deploy now requires
the configured factory address up front so a missing/misspelled value can't skip
the same-DEX safety check.
