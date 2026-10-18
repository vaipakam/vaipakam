## Thread — Rehearsal sanctions lists recorded on the testnets (PR #TBD)

The rehearsal `SanctionsList` deployed on Base Sepolia is now recorded in the deployment artifact and the exported deployments bundle, so the sanctions adder service installed from this commit finds it without any hand-configured address. On Base Sepolia the admin owns it, the adder service's own key may only list, and the testnet Safe alone may delist. The Diamond does not screen against this list: it is where the unattended services rehearse, beside the admin's testnet overlay, which stays the Diamond's oracle. Nothing a user sees changes.

Refs #2443.
