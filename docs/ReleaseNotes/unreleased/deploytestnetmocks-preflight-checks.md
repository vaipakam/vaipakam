## Thread — DeployTestnetMocks validates reuse/override env before broadcasting (#1102)

The testnet-mocks deploy script ran two view-only guards — the
`FAUCET_SWAP_ADAPTER` reuse probe (`owner()` version gate + the price-aware
`tokenUsdPrice8` getter check) and the `MWETH_USD_FEED` live-feed freshness
validation — **inside** the broadcast block. On a misconfigured rerun (a stale
or incomplete live feed, or a pre-#1095 swap adapter passed by env), the script
would broadcast every other mock deployment first and only *then* revert,
leaving orphaned mock contracts on-chain and burning operator gas.

Both checks are now a **pre-flight** block that runs before `startBroadcast`:
they're pure staticcalls, so a bad config fails fast with zero on-chain writes
and an actionable message. The state-writing pieces they feed — the static
snapshot feed deploy and the fresh swap-adapter deploy — stay inside the
broadcast, driven by the values the pre-flight resolved (`wethQuotePrice8` and
whether to reuse `swapAdapter`). The happy path is unchanged; only the failure
ordering moved, so a correctly-configured deploy behaves exactly as before.

Testnet-tooling only — no contract `src/` logic, no facet ABI, no mainnet
surface. Closes #1102.
