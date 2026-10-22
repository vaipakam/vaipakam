## Thread — EIP-7702 wallets get the vault reward default (PR #<n>)

A reward claim from a person's own wallet lands in their vault by default, where it counts toward their fee-discount tier straight away; a claim from a contract gets a plain wallet transfer instead, as integrations expect. The test for "a person's own wallet" was "the address has no code". A wallet that has upgraded to a smart account under EIP-7702 carries a 23-byte delegation marker as its code, so it was treated as a contract and its rewards skipped the vault. The 2026-10-21 reward rehearsal found this on Base Sepolia, where the dev wallets are delegated; the same wallets on Arbitrum Sepolia are not, so the same person got a different venue on each chain.

An address whose only code is that delegation marker now counts as a person's own wallet, both for a direct claim and for a staged claim day that settles later. One shared rule decides it, so the two paths cannot drift. A real contract, including code that merely resembles the marker, keeps the wallet transfer, and the explicit vault or wallet choice works as before for everyone. Checks elsewhere that an admin-set address is a contract are deliberately unchanged, since a delegated wallet does run code.

The owner chose this on 2026-10-22. It reaches each chain with its next contract refresh.

Closes #2617.
