## Keeper — the interim auto-extend window is removed (#2921)

Until now, the auto-extend pass checked each chain's Diamond for the contract's extension-window view (#2738, contract half #2918). On a Diamond that predated the view, the keeper applied its own interim copy of the window and term rules on the loan clock.

At the all-waves fresh deploy every served Diamond states the window and enforces the term rules itself, so the interim copy and the per-chain loupe read are gone. For each consenting loan the pass reads `getAutoExtendWindow` directly. A window it cannot read leaves that loan for the next run. A term the contract refuses fails at the gas estimate, so nothing is broadcast.

This merges with the all-waves fresh deploy. Merged earlier, a pre-#2918 testnet Diamond would answer the window read with `FunctionDoesNotExist`, and no loan would be extended there.
