## The RPC proxy runs on the testnets first (#1724)

The read-only RPC proxy now binds only the three testnet keys (Base Sepolia,
Arbitrum Sepolia, BNB Testnet), which are the keys that exist today. Cloudflare
refuses a deploy that names a key the store does not hold, so the five mainnet
entries are added back with their keys at mainnet. Until then a request for a
mainnet chain is refused as not configured, and the app falls back to that
chain's public endpoint, as it does whenever the proxy cannot answer. The app
does not use the proxy yet; that is a separate build setting.
