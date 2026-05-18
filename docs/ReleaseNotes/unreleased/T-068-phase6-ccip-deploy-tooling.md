## Thread — T-068 Phase 6: CCIP deploy & configuration tooling

Phases 1–5 of the LayerZero → Chainlink CCIP migration built the
cross-chain contracts and deleted the old LayerZero deploy scripts, but
did not replace them — there was no script to stand the cross-chain
stack up on a chain, nor to wire its lanes. Phase 6 closes that gap.

`DeployCrosschain.s.sol` deploys the whole CCIP stack for one chain in a
single run — the CCIP messenger, the VPFI token pool (lock/release on
canonical Base, burn/mint on a mirror), the rate-limit governor, the
reward messenger, and the buy receiver or mirror-token + buy adapter —
picking canonical-vs-mirror from the chain id. `ConfigureCcip.s.sol`
then wires the cross-chain topology — chain selectors, remote messengers,
the buy and reward channel peers, the per-lane token-pool rate limits
(through the bounds-checked governor), and the registration of VPFI as a
Cross-Chain Token. Because the wiring step reads every chain's
deployment record, it runs as a deliberate second pass once every chain
has been deployed.

The three shell orchestrators (`deploy-chain.sh`,
`deploy-testnet.sh`, `deploy-mainnet.sh`) were carrying calls to the
deleted LayerZero scripts; they now invoke the two new scripts, resolve
CCIP infrastructure addresses per chain, and — having no per-chain DVN
policy to curate any more — replace the old `lz-config` step with a
`ccip-wire` pass. The deploy-verify gate now confirms the token pool's
rate-limit admin is the governor rather than checking a now-absent
buy-adapter cap.

A rehearsal test stands the full two-chain stack up exactly as the
scripts deploy and wire it, and exercises all three cross-chain flows
(the buy round-trip, the reward report/broadcast, and the cross-chain
token mint/burn authority) plus a full wiring-consistency check. A new
operator runbook documents the testnet-rehearsal and mainnet-cutover
procedure, the mainnet-deploy gates, and the post-deploy steps.

One follow-up is deliberately left open: `Handover.s.sol` still rotates
the LayerZero-era contract set to governance and does not yet hand the
CCIP stack over — the cutover runbook flags this as a manual multisig
step until that script is updated.

Closes #60.
