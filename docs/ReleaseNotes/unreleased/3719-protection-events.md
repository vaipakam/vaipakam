## Protection events name the account and report role changes (#3719)

Every protection event an account's vault emits now names the account first: switching protection on or off, a setting change, a payout destination, a secondary signer, a lock, and each step of a replacement. An alert service can follow one account's protection without first working out which vault belongs to it.

A new event reports every change to who holds a role on the account, in one common form: the role (the owner wallet, a secondary signer, or the wallet a replacement nominates), the old wallet and the new one. It fires when a signer is added or removed, when a replacement is proposed, cancelled or completed, and when the owner wallet changes. Alerts can then warn the holder as soon as a replacement is proposed, not only when it completes.

The vault's protection code changes, so this reaches a chain by fresh deploy.
