## Thread — Live driver for the auto-extend card and extension reserves (PR #3124)

A new manual-only live driver, `live-auto-extend.mjs`, drives the loan page's automatic-extension card and the extension reserve through the deployed app with two dev wallets on Base Sepolia. The borrower and the lender each save their limits through the six-row review receipt, and the chain must then hold exactly those limits. The borrower reads the overlap as limits, not as a promise. The borrower then adds a small reserve, withdraws it from the loan page, adds it again, and withdraws it from Claims. Every signature goes through one ordered write plan in the wallet, with each request's full expected payload. Every fund movement is checked against its own event and a read pinned to its block.

Funds moved: setting limits moves nothing but gas. Each deposit moves the reserve from the borrower's wallet into the borrower's own vault, reserved for that loan (ExtendReserveFunded). The only approval is exactly the deposit amount. Each withdrawal returns it from the vault to the borrower's wallet (ExtendReserveWithdrawn). Nothing reaches the lender or the treasury, and the drive fails if a reserve or an approval is left standing.

The first run passed on Base Sepolia loan 1. Its tx hashes and per-step evidence are on the PR. Advances #2814.

> Caveat: an extension itself is not driven, because the window opens near maturity. Both sides' limits are left in force on the fixture loan on purpose.
> Caveat: the forced close-out KYC check had nothing to observe, because the new Base Diamond has no past-grace loan.
