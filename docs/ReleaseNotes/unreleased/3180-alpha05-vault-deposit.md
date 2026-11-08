# The next app can deposit into your vault

The next app's Vault page now takes a deposit: one token or NFT moved from the connected wallet into its own vault, outside any loan. The reader picks a suggested token or test collection, or pastes an address, and whether it is a token, an NFT or a multi-token collection is read from its contract. Then they type the amount, the NFT's token id, or the token id and how many. A Terms of Service version not yet accepted is asked for first, and the Terms are read again just before signing, so switching to a wallet that has not accepted them, or a version published meanwhile, sends the deposit back to the Terms prompt.

The review says what leaves the wallet and into which vault, and that the deposit creates the vault when there is none. It asks exactly the approval the deposit needs: the amount for a token, that one token for an NFT, and for a multi-token collection an approval granted for this deposit alone and taken back right after it, in one more wallet step. A paused protocol, a wallet the sanctions screen flags, a wallet retired by a replacement, or a wallet holding too little stops the review by name; a pause or screen that could not be read is stated and left to the protocol's own check.

The protocol's dry run runs once the approval is in place, so a token that does not arrive in full, such as one that charges a fee on transfer, is refused before the deposit is sent, and an approval the flow made is put back. The receipt says no token-safety screening runs, and how the deposit can leave the vault again: at once without protected mode, after the account's delay with it, and not at all while the account is locked, which the protocol does not stop a deposit for. The finish card states what the protocol credited and what the token's own record moved into the vault. While the protocol is paused, the panel says deposits are closed and what stays open.

Withdraw comes to this page next. Until then the page links the current app for it.

Rulebook: `docs/DesignsAndPlans/Alpha05AppDesign.md` RB-VAULT-DEPOSIT. Epic #3180.
