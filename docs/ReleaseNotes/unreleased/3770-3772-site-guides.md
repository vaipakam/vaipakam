## Site — guides for shared accounts and for running your own agent

The marketing site has two new help pages, in English for now.

**Shared accounts with a contract wallet** (`/help/shared-accounts`, #3770). It explains how a family, club or team can hold one account through a multi-signature contract wallet, where the safe's own rules decide who may act and the platform keeps no member list. It covers what those rules can stop (any action the account takes) and what they cannot (the loan's own terms once agreed, or an action already approved). It also says that a protected account's delay and signers still apply on top. Three known limits are stated. A token sent to the vault by a plain transfer cannot be adopted by a contract wallet until #3780, so deposit through the app. A contract wallet's address on one network need not be the same wallet, or any wallet, on another. Each network is set up separately. A note at the top says that using the app from inside a contract wallet is still being checked step by step.

**Running your own agent** (`/help/run-your-own-agent`, #3772). It explains approving a keeper and the conditions under which a keeper may act, read from the contracts' keeper checks. It lists what a keeper can never do and gives a table of each action a keeper can be given, what it allows and what it never allows. It links the open-source reference keeper and states plainly what that keeper does today: liquidations, offer matching and agreed extensions. It does not carry out a wallet's own approved actions. The page promises no result and names no rate.

Both pages follow the help pages' body-source rule, so a translation added later is served and indexed without a code change.

Advances #3770 and #3772. Design: `docs/DesignsAndPlans/FeaturesOverExistingPartsDesign.md` sections 3 and 10.
