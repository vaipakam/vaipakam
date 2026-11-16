## Thread — the apps, the indexer and the keeper follow the merged contract batch

The batch that raised the lender yield fee to 5%, added extension fees, collection offers, the Ready balance, held lender payments and the instant market left the off-chain surfaces describing the older contracts. This change brings them back in line. The contracts are the source of truth; nothing here changes what the protocol does.

The public website now states the 5% yield fee wherever it named the old 2% figure: the fee constant it mirrors, the "how it works" fee line and the fee FAQ in all ten languages, the whitepaper's constant list and the admin settings reference. The connected app's fallback figure, shown only while the live fee read is in flight, is 5% as well. The figures the site computes from the fee (the worked repayment example) follow automatically.

In the connected app, the review before taking an offer now names a collection offer's refusal in its own words: such an offer is taken only through the protocol's collection-offer fill, which the app does not offer yet, never by a direct accept. The automatic-extension limits explain the added initiation fee an extension charges in every translated language, and the Activity page gives every new event kind a plain label in all ten languages instead of a generated English name. The alpha app gets the same refusal wording and activity descriptions.

The shared activity rules now name the wallet each new event concerns: the payer of an extension's added fee and the owner of a Ready balance. The indexer files a collection-offer fill on the collection offer's own timeline, and treats the extension fee as a companion of the extension, which already carries the notification. The keeper's machine settings template lists the held-payment re-commit switch the keeper already reads, so it no longer reaches a machine unset by omission.

> Caveat: the website still describes the loan initiation fee as a flat 0.2%; since the same batch it is 0.2% for loans up to 30 days and rises with the term. That copy is not changed here.
