## Thread — Rehearsal sanctions lists recorded on the testnets (PR #2566, #2567)

The rehearsal `SanctionsList` deployed on Base Sepolia and the one deployed on Arbitrum Sepolia are now recorded in their deployment artifacts and the exported deployments bundle, so the sanctions services installed from this commit find them without any hand-configured address. On both chains the admin owns the list and the adder service's own key may only list. The power to delist differs: on Base Sepolia the testnet Safe alone may delist, while on Arbitrum Sepolia, for now, the admin is the remover; it moves to a Safe with one call when one is set up there. The Diamond screens against neither list: they are where the unattended services rehearse, beside the admin's testnet overlay, which stays the Diamond's oracle on each chain. Nothing a user sees changes.

Refs #2443.
