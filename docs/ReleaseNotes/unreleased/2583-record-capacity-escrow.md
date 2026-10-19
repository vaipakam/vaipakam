## Thread — each chain's service-capacity deposit escrow is published with its deployment (PR #<n>)

Binding a chain's service-capacity escrow creates a dedicated holder contract that will custody operators' refundable capacity deposits. Until now its address could be found only by asking the Diamond. It now appears in each chain's deployment artifact and in the consolidated deployments bundle, alongside the reward custody holder, so monitoring and explorer tooling can find it the same way.

A small operator script binds the escrow if it is not bound yet and records the address. The recorded address is always the one the Diamond itself reports, read back after any bind, so the artifact cannot name a holder the Diamond does not use. On a chain that is already bound, the script sends nothing and only records. It was run on Base Sepolia, Arbitrum Sepolia and BNB testnet, whose escrows were bound on 2026-10-19. Closes #2583.
