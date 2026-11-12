## alpha05: choose where a reward claim lands (RW-26)

A reward claim in the new app now starts on the same delivery rule the protocol uses by default. A person's own wallet account, including one with an EIP-7702 delegation, is paid into its vault. A wallet that is a contract, such as a multi-signature wallet, is paid to the wallet itself. Before this change every claim named the vault, whatever kind of account made it.

In Advanced mode, the claim offers a choice between the vault and the wallet before the review. Each option says what it means: VPFI in the vault is not locked and can be withdrawn at any time. A separate note says what the choice does to the fee-discount tier on this network: on VPFI's home network, VPFI in the vault counts toward it and VPFI in the wallet does not; on another network the tier is worked out on the home network, so neither choice changes it there. The review's "Delivered to" line names the chosen destination and binds it, the re-check simulates that destination, and the outcome reports where the VPFI actually arrived. Claim everything still sends its reward legs to the vault and says so.

With protected mode on, the protocol sends every reward claim to the vault whatever destination is passed. In that case the claim names the vault, says withdrawals wait the account's delay, and offers no wallet option. If the mode cannot be read, the claim names the vault too. The re-check reads the mode again before signing.

The Basic and Advanced guides describe the choice in all ten languages.
