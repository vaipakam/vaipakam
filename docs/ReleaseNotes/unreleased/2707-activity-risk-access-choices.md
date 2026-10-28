## Thread — A wallet's risk-access choices appear on its Activity page (PR #<n>)

The Activity page shows a wallet the events it took part in, by a shared participants rule. Four events record a wallet's own risk-access choices: its risk level, strict mode, and its consents and acknowledgements for asset pairings. None of them ever reached the wallet's page.

The rule treated the address these events carry as a vault contract, because the contract names it `vault`. It is not one. The risk-access contract keys this state by the account that made the choice: the account itself when it calls directly, or the account that signed when a relayer submits it. So the address is the wallet, and the rule now lists it as the wallet's own row. Each of the four gets a plain-language label in all ten languages.

The name `vault` still means a vault contract in other events, so it is no longer treated as "never a person" across the board. Each of those events is now classified on its own: the swap-to-repay lot pull keeps the borrower as its party and the vault contract out; the backstop vault being set up stays with the treasury records; and an admin exempting an account from the risk-access checks stays with the administrative records, off the account's page.

Closes #2707.
