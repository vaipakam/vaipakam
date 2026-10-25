## Governance gates — the canonical VPFI token gets the fast guardian pause (#937)

The canonical VPFI token on Base can now be frozen by the Pauser Safe straight away, the same way every cross-chain contract already could. Before this change only the token's owner could pause it. Once ownership moves to the governance Timelock, that would have meant waiting out the Timelock's 48-hour delay, so a minter-key compromise or a mint bug could keep running for two days with nothing able to stop it. The guardian can only freeze. Unfreezing stays with the owner, so a compromised or hasty guardian cannot switch the token back on.

A freeze stops every VPFI movement on the canonical chain: transfers, mints, burns, the cross-chain pool's lock and release, and the platform's own VPFI flows. A cross-chain delivery refused during a freeze is recorded by CCIP as failed and can be re-executed once the freeze is lifted, so nothing is lost. The guardian is installed during cross-chain configuration, while the deploying admin still owns the token. If a reused token already belongs to someone else, the configuration says that it could not set the guardian and names who must. The live handover check now also reads the canonical token's guardian and fails the chain unless it is the Pauser Safe.

The guardian is stored in its own namespaced slot, so the token's existing storage is untouched and an in-place token upgrade needs no migration. It still needs the owner to set the guardian afterwards. No testnet has been changed yet.

Closes #937.
