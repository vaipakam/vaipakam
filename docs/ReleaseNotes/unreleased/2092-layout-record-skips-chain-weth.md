## Thread — Storage-layout record stops anchoring the chain's own WETH (PR #<n>)

An in-place facet refresh first checks each chain's storage-layout anchor, a fingerprint of all the code the chain's layout record governs. That set was built from every address in the chain's deployment file, which also records the chain's own WETH. On Arbitrum Sepolia (as on Arbitrum One) that WETH is an upgradeable proxy run by Arbitrum, so it counted as code the record governs. The testnet rig writes the WETH entry after the deploy has anchored, so the first refresh after the 2026-11-03 deploy was refused for a proxy the anchor did not list. A live readback showed every Vaipakam address on Arbitrum unchanged.

The record now governs every proxy the walk finds except the chain's own WETH, the deployment file's top-level `weth` entry. Vaipakam neither deploys nor upgrades that contract. The same name deeper in the file, such as a rig's own entry, is still governed. Base and BNB testnet anchors are unaffected, because their WETH is not a proxy. Arbitrum's existing anchor matches the chain again with no re-anchoring.

The exclusion is one named entry, not a general rule, so it fails closed. Another chain-provided proxy would still be refused loudly. A rule that guessed ownership could instead drop one of our own proxies from the guard without saying so. The governance handover is unchanged and still reports any third-party contract that answers `owner()`.

Advances #2092.
