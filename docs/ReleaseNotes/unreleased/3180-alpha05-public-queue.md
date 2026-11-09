# The next app warns before signing on networks with a public queue

On Ethereum, BNB Chain and BNB Testnet, a sent transaction waits in a public queue before it is included, and anyone watching that queue, bots included, can see it and act first. Someone could take an offer before its cancel lands, or act on a loan before a repayment does.

In the next app, the review of posting, taking or cancelling an offer, repaying in full or in part, and adding collateral now says so on those networks, before the wallet opens. Its help explains that some wallets can send a transaction privately, that neither the protocol nor the app can choose that route, and that the usual route changes only who can see the transaction before it lands. The app names no private sending service. On Base, Arbitrum, Optimism and their test networks, which keep no public queue, nothing is shown.

Rulebook: `docs/DesignsAndPlans/Alpha05AppDesign.md` RB-PUBLIC-QUEUE. Part of #3357; epic #3180.
