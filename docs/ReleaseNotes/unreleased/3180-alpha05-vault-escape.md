# The next app states a pause and its escape route on the Vault page

While the protocol is paused, the next app's Vault page now says so at the top. Withdrawals are closed, while full and partial repayment and adding collateral stay open. Under an administrative pause, the page also says when the pause's escape route opens. That time comes from the protocol itself, is counted down against the chain's clock, and is never assumed. An automatic pause, or a protocol not yet launched, schedules no escape route, and the page says none is scheduled.

Once the escape route is open, the Withdraw button sends a wallet without protected mode through it. The review says the asset goes straight to that wallet through the escape route, and that the route never returns what a loan, offer or claim holds. A protected account keeps the ordinary withdrawal, which still waits out the account's delay in the payout queue. If the pause, the route or, under an open route, the account's mode cannot be read, nothing is sent and the review says why.

The finish card reads the protocol's own record of the escape withdrawal and the token's own transfer from the vault to the wallet.

The withdrawal copy no longer says only a protected account can withdraw under an open escape route.

Rulebook: `docs/DesignsAndPlans/Alpha05AppDesign.md` RB-VAULT-ESCAPE. Epic #3180.
