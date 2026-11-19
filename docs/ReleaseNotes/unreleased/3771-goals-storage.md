## Agent — goals storage

The agent now keeps a wallet's goals. A goal is a name, a target amount of one asset and a date, attached to one of the wallet's Auto-lend slots (named by its lending asset, its collateral asset and its number, 0 to 7, as the contracts name it) or to loans the wallet made. It is the user's own note: it locks nothing and changes nothing on chain. The app's goal screens are the alpha05 thread's work.

Saving, deleting and listing goals are three new agent routes. Each is signed by the wallet and accepted once. A save is signed over every value it stores, from a new shared module, so the wallet prompt and the agent's check read the same text. The name is checked to one plain line before it goes into a message. Goals are private to the wallet and are kept in the agent's own state object beside the Telegram links, not in the shared database. They are kept per deployment, because the slot and the loan ids a goal names exist only on one Diamond.

The limits are configuration: 20 goals per wallet and 50 changes a day by default. These defaults are the builder's and have been raised with the owner.

Advances #3771. Design: `docs/DesignsAndPlans/FeaturesOverExistingPartsDesign.md` section 4.
