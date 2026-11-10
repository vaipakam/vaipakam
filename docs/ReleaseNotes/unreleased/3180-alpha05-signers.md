## Thread — alpha05 manages secondary signers on the Protection page

A secondary signer is another wallet the user holds, such as a hardware wallet, that guards a protected account. It can cancel a waiting change, lock the account, cancel or co-sign a queued payout, remove a destination and, with the other signers, approve replacing the main wallet. It can never move anything out of the vault, open a position, or add a destination or signer. The new app's Protection page now lists the account's signers and the wallets asked to become one, with each one's acceptance and timing by the chain's clock.

A signer is chosen only from the saved wallets that proved control by signing, never an exchange address. Asking a wallet changes nothing at first: the page shows a link the asked wallet opens to accept from its own key. That page names the account in full and offers to accept only to the asked wallet, on the right network, while the request waits. Once the delay has passed and the wallet has accepted, the request is made active within one further delay, or it lapses and must be cancelled before asking again. Removing a signer also waits the delay and can be cancelled by another signer. The user can also require a signer's co-sign on every payout: switching it on is immediate, switching it off waits the delay, and removing the last signer switches it off too, which the review says.

Each change opens its own review, which states the signer in full, what a signer can and cannot do, and the timing, and its outcome is measured from the transaction's own events. Wallets asked to become a signer now also count as known addresses, so a look-alike of one is refused in every address box.

Name-service names, flags on unknown senders, test payouts, the incoming-payment fallback and withdrawing to a saved destination come in a later slice.

Advances #3415 and #3180.
