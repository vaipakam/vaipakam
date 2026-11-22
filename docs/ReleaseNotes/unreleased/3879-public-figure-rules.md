## Indexer — one counting rule for public figures

Every figure the indexer publishes now follows one written rule, kept in one module so later figures (the rental figures among them) state it in the same words.

No value total is formed. The index reads no price, so it never adds amounts of different assets together: each amount stays in its own asset's smallest units, on its own line. The loan totals say so in a new `counting` statement.

No figure is a mean across assets or terms. The loan totals no longer carry an average interest rate: it averaged rates of different assets and terms together, and nothing used it.

A loan whose opening event names the same address as lender and borrower is left out of the rate candles and counted on its own line, and the loan totals count such loans too. The test reads the two parties of the opening event, now kept with the loan row, so a later sale or handover moves a loan neither in nor out. Each figure that applies the rule says that it cannot see two addresses that belong to one person.

A new migration adds the two opening-party columns and fills them for existing loans from the activity ledger; a loan with no ledger record is left with no parties and is not left out.

Part of #3879. Design: `docs/DesignsAndPlans/ProjectKitDesign.md` section 8.
