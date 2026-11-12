## alpha05: what you have claimed so far (RW-31)

The rewards section on Home and on the Rewards page now shows what the connected wallet has claimed on the current network over its lifetime, and how much of that was delivered into its vault. Every claim counts, including a release of rewards held while a wallet was flagged, whichever destination the claim chose. Each claim is counted on the UTC day it was paid, not on the reward day it was earned.

The figures come from the indexer, through a new read that sums the claim and vault-delivery records it already keeps for each wallet. The line says up to when the indexer has recorded every claim. While it has not recorded the network that far, or is still reading the network's past claims, the line says the total is not known yet. If the indexer cannot answer, the line says so; it never shows zero in place of an unknown total. A claim the wallet confirms re-reads the total at once.

A vault credit that fell back to the wallet is counted in the total but not in the vault part, because the protocol records no vault delivery for it.

The Basic and Advanced guides describe the line in all ten languages.

Closes #3216.
