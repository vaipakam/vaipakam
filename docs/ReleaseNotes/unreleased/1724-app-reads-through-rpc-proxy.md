### The app reads testnet chains through the RPC proxy (#1724)

The connected app now reads Base Sepolia, Arbitrum Sepolia and BNB Testnet through Vaipakam's own read-only RPC proxy at rpc.vaipakam.com, instead of calling a provider directly from the browser. Before this, the app's build carried a provider URL with its key, so anyone opening the page could read the key and spend its quota. The proxy keeps the provider keys on the server, accepts only read calls from the app's own origins, and limits each caller.

If the proxy is down or over its daily allowance, the app falls back to each chain's public endpoint and keeps working. Ethereum and Base mainnet, which the app reads only for ENS names and display, use public endpoints until the proxy has keys for them. The proxy's hostname is now declared in its own configuration, so a deploy keeps it bound.
