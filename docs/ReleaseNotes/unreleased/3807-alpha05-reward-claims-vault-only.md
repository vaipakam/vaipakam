## alpha05: reward claims always land in the vault

The payout rule (owner decision 2026-11-19) pays every reward into the claimant's vault as free balance, and the contracts refuse the wallet delivery from #3805. The app now claims with the vault in every case. Before, it sent a contract wallet's claim to the wallet and let Advanced mode pick the wallet, and the contracts would now refuse both.

Advanced mode no longer offers a destination choice. It shows one line, "Rewards land in your vault, ready to use. Withdraw moves them to a wallet.", with the note on whether vault VPFI counts toward the fee-discount tier on this network. The review's destination line says the reward arrives as free balance, that Withdraw moves it to a wallet, and that a vault is opened for a claimant who has none. With protected mode on, it adds that a Withdraw to a wallet waits the delay. While the mode cannot be read, it says so instead of assuming either answer.

The finished claim is still measured from its own transaction, so the outcome names where the VPFI actually arrived.

Caveat: the line about opening a vault describes the contracts from #3805. Ship this with the deploy that carries #3805.

Closes #3807.
