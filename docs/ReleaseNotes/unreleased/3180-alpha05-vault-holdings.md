# The next app shows what your vault holds and can create it

Until now the next app's Vault page only said it was not built yet and pointed to the current app. It now shows the connected wallet's own vault on its network: the full vault address with an explorer link, and that the vault is a contract kept for this wallet alone, with nothing pooled with anyone else's, which assets leave only by the protocol's rules.

A wallet with no vault is told so and can create one. The review says nothing moves and no approval is asked, and that a deposit or a first offer would create it anyway. The protocol's own dry run decides whether it goes ahead. A wallet the sanctions screen flags is told the protocol creates no vault for it. The finish card names the vault address the transaction's own record gives.

Each asset shows the protocol's figures, read at one moment, and the app works none of them out itself. "In your vault" is what the protocol counts as the wallet's there: the smaller of the vault's balance and the protocol's record, so a token sent in by a plain transfer never raises it. "Free to withdraw now" is the protocol's own answer after every loan, offer, claim, reserve and queued payout. The rest is shown as held by the wallet's positions. If the vault holds less than the protocol counts, both figures are shown. A part that reached the vault outside the protocol is named as not counted and not withdrawable until adopted, with a link to adopt or disown it. VPFI in the vault is named as setting the fee-discount tier, not as collateral.

The page lists every asset in the vault's deposit record and every asset the wallet's loans and open offers name. It says plainly that an asset sent by a plain transfer shows only if one of those names it, and says when either list could not be read in full. Empty rows and tiny leftover balances are hidden behind a switch that says how many there are.

Deposit and withdraw come to this page next. Until then the page links the current app for them.

Rulebook: `docs/DesignsAndPlans/Alpha05AppDesign.md` RB-VAULT. Epic #3180.
