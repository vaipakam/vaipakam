## Thread — The next app can withdraw from your vault (PR #3375)

The next app's Vault page now takes a withdrawal: what is free in the connected wallet's own vault goes back to that wallet. Free means no loan, offer, claim, standing offer or queued payout holds it. The protocol's own figure decides, and the form shows that figure, reads it again each block and refuses more. Each asset with something free has a Withdraw button. An NFT the deposit record names only by its collection is withdrawn by typing its token id under that collection.

The app withdraws only to the wallet that signs and offers no other destination. The review names the vault the asset leaves and where it goes. Without protected mode it reaches the wallet at once. With protected mode on, it waits in the account's payout queue for the delay, and needs a secondary signer's approval where the account requires one. The review also says a queued withdrawal can be cancelled from the payout queue on the Claims page, and that no approval is asked.

A missing vault, a wallet retired by a replacement, a wallet the sanctions screen flags, a pause, a locked account, an amount over the free figure, or a refusal from the protocol's own dry run stops the review by name. A pause does not stop a protected account once the escape route has opened. A pause, screen or free figure that could not be read is stated.

The finish card states the protocol's own record of the withdrawal and whether it queued it, the queued payout with its release time, and what the token's own logs moved from the vault to the wallet.

Rulebook: `docs/DesignsAndPlans/Alpha05AppDesign.md` RB-VAULT-WITHDRAW. Epic #3180.
