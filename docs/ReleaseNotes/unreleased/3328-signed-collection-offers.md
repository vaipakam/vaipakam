### Signed NFT collection offers (#3328)

A lender can now sign a collection offer instead of posting it on-chain. The signed order names the same things an on-chain collection offer does (the set of tokens, the terms of each loan and how many loans it funds), and costs nothing to make. Nothing is reserved when it is signed: each fill draws one loan's principal from the lender's vault balance at that moment, so a lender keeps the funds usable until a borrower actually takes a loan.

A borrower fills it one token at a time, signing the usual acceptance for their exact token. Every protection of an ordinary signed offer applies, and the order records when it was signed: its expiry and signature deadline can be no later than that time plus the governed maximum, so an order kept back for months cannot be used later. Excluded token ids are signed as a hash, and the fill must present the matching list. The ordinary signed-offer routes refuse a collection order by name, and the collection route refuses an ordinary order.

The off-chain tools that sign and check orders now share one field list and one conversion, so the next change to the order shape touches one place. The order book does not list signed collection offers yet.

An instant borrow now states each loan it opened in its own event, so the activity feed files each one under its loan.

Advances #3328.
