## #3789 — Run the public keeper bot for your own loans

The public keeper bot can now carry out a borrower's own standing instructions: the collateral top-up, the interest payment and the repayment at the due date. Each step has its own switch and is off unless the operator sets it. An operator can list their own wallets for each network, and the bot then acts only on loans whose borrower position one of those wallets holds at that moment. The contract decides whether a step is due; the bot checks the on-chain setting, simulates the call first, sends only what is due, and logs the reason the contract gives when it skips one.

The bot's key needs no keeper approval for these steps, because anyone may submit them. It cannot move anyone's assets, so a leaked key costs only the gas it holds. The bot repository's README states this.

The keeper-bot ABI export now includes the standing-instruction facet, so the bot is typed against the same contract surface it calls.

The site's FAQ entry on keepers now describes this. Its example of what an approved keeper does named a step keepers do not take; it now names the ones they do (finishing a loan sale or offset you started, extending a loan). It adds which steps anyone may submit, that Vaipakam runs a keeper and publishes an open-source bot anyone may run for their own wallets, and that a step runs only when someone submits it. All ten languages are updated.
