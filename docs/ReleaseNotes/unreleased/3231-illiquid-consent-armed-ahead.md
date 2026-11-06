## Thread — Illiquid deals need a pair consent armed ahead (PR #<n>)

Accepting an offer on an illiquid pair (an unpriced token, an NFT, or a rental) now needs the acceptor to hold a standing per-pair consent, exactly as the offer's creator already did. Before this change the acceptance signature itself, which names the illiquid assets, counted as that consent.

That shortcut skipped the unlock cooldown. Someone holding a stolen key could approve a worthless asset and take the deal in the same sitting, with no window for the owner to notice. With the consent required in advance, a raise recorded just before a deal stays pending for the configured cooldown (48 hours on the testnets, and on mainnet from the first deploy), and the owner can withdraw it instantly in that time.

The accept preview now reports a missing or still-pending consent as a block. The soft "the acceptance acknowledgement will cover it" result it used to give is retired and never returned. The connected app treats any non-zero preview result as a block, which is also the safe reading on a network that has not yet been refreshed past this change.

Nothing changes while the risk-access switch is off, and liquid pairs are unaffected. The storage slot that carried the acknowledged risk-terms anchor for the retired rule is kept unused, because storage is append-only. The signed acceptance terms still carry that anchor for now; removing it from the signed message is a follow-up, because every signer would have to change at the same time.

Closes #3231.
