## alpha05: choose where a reward claim lands (RW-26)

A reward claim in the new app now starts on the same delivery rule the protocol uses by default. A person's own wallet account, including one with an EIP-7702 delegation, is paid into its vault. A wallet that is a contract, such as a multi-signature wallet, is paid to the wallet itself. Before this change every claim named the vault, whatever kind of account made it.

In Advanced mode, the claim offers a choice between the vault and the wallet before the review. Each option says what it means: VPFI in the vault is not locked and counts toward the fee-discount tier, and VPFI in the wallet counts toward no tier until it is deposited. The review's "Delivered to" line names the chosen destination and binds it, the re-check simulates that destination, and the outcome reports where the VPFI actually arrived. Claim everything still sends its reward legs to the vault and says so.

The Basic and Advanced guides describe the choice in all ten languages.
