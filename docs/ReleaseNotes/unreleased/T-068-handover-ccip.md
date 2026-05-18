## Thread — T-068: Handover.s.sol brought onto the CCIP stack

The post-deploy ADMIN → governance handover script
(`script/Handover.s.sol`, the `--phase handover` step) was left
LayerZero-shaped after the cross-chain migration. Its Diamond-side work
— rotating the access-control roles and the Diamond's ownership to the
governance Safe and the Timelock, then renouncing the admin EOA's
authority — was always provider-agnostic and correct. Its cross-chain
half was not: it rotated the deleted LayerZero contract set and never
touched the new CCIP contracts, so a mainnet handover would have left
the CCIP messenger, the VPFI token pool, and the rate governor still
owned by the hot admin key — a violation of the project's cross-chain
security policy.

The script now hands the full CCIP contract set — the messenger, the
VPFI token pool, the rate governor, the reward messenger, and the
per-chain mirror token and buy adapter / receiver — to the governance
Timelock, and rotates the Cross-Chain Token administrator (the Chainlink
token-admin registry entry for VPFI) to the Timelock as well. The
Timelock was chosen as the destination for consistency with the
Diamond's own ownership: these contracts are upgradeable, so their owner
gates upgrades and lane configuration, which fits a review-window delay
— and fast incident response is still covered by the guardian pause
lever every cross-chain contract carries.

A simplification fell out of the migration: because the deploy and
configuration scripts leave every cross-chain contract owned by the one
admin address, the old per-contract owner-key juggling is gone — every
ownership transfer is signed by the single admin key.

Closes #63.
