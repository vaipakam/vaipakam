## Thread — Protected account mode and the depository vault in the app

The connected app now carries the depository vault and protected account mode that the contracts introduced. The vault page gains a deposit and withdraw card for every asset kind. The figure it calls free is the contract's own (tracked holding less whatever loans, offers, intents and queued payouts hold), so the card never offers more than the contract will release. With protection on, the withdraw button says before signing that the withdrawal is queued and for how long.

A new vault protection page shows the account's settings, the queued payouts and position NFT transfers with their request codes, the changes waiting the delay, the payout addresses and the recovery signers. It covers locking, unlocking, co-signing, releasing, cancelling and moving the account to a new wallet. A recovery signer can open another account from the same page to accept the role and act on it. Whatever cannot be read is stated as unknown: a queue that could not be read is never shown as empty, and the page shows no controls at all when the settings themselves could not be read.

The desk, the accept flow, the fee-tariff check and the vault's locked figure now read the contract's free figure too, so a queued payout is never counted as spendable. The Terms gate keeps every write that frees the user's own assets or protects the account open to a wallet that has not accepted new Terms, including asking to unlock.

The new copy is translated into all nine shipped languages.
