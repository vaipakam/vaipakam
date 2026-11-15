## Keeper matcher pairs pro-rata offers across terms (#3615)

Since #3617 the contract matches a lender and a borrower offer of different terms when both chose pro-rata interest and the borrower's term is the shorter one (the loan runs the borrower's term). The keeper's matcher still grouped offers by exact term, so it never looked at such a pair and the offers sat idle.

The matcher now groups offers by asset pair alone and checks each lender and borrower pair against the contract's term rule before it spends a preview: equal terms always pass, and different terms pass only for a pro-rata pair with the shorter borrower term. The contract's preview stays the final word. The fairness walk is unchanged, so one wallet's offers still cannot use up a run.

The change takes effect where the #3617 contract change is live, which is the next fresh testnet deploy. Until then the preview refuses the new pairs and the matcher simply moves on.
