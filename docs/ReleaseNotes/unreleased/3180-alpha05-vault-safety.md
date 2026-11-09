## Thread — The next app's Vault page gets an account safety card (PR #3376)

The next app's Vault page now has an Account safety card. It shows whether the wallet's account runs protected mode, its delay, and whether a secondary signer must approve each release. It also shows whether position NFTs are protected, how many payouts wait in the queue, the lock (since when and by whom), and every change still pending with its time. The account's own payout queue appears under the card. It is the same queue the Claims page shows.

From the card, a wallet can turn protected mode on, lock its account at once, ask to unlock, and apply the changes that are due. In Basic mode, turning on uses the shortest delay the protocol allows, two days, with position NFT protection off, and the card says so. Advanced mode lets the reader choose up to five days and protect position NFTs.

Each review states what the account becomes and every consequence. Turning on never delays what the wallet owes others, and payments from other vaults land in the wallet's own vault. A lock cancels every queued payout and drops every pending change, and the review counts both. Repayment and adding collateral stay open, and a lock works during a pause. An unlock waits out the delay. Applying due changes applies all of them together, and a switch-off waits until no payout is queued. Each action runs the protocol's dry run at review and again before the wallet opens. The finish card reads the protocol's own events.

A protocol without the feature is shown as unavailable, never as off. If the mode cannot be read, the card offers no control and says not to assume protection is off. A wallet retired by a replacement is shown the wallet that now manages the account.

Rulebook: `docs/DesignsAndPlans/Alpha05AppDesign.md` RB-VAULT-SAFETY. Epic #3180.
