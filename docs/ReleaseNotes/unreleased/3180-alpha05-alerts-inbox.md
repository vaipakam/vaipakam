# The next app gets an Alerts page and a header count

The next app now has an Alerts page. It lists the free alerts the protocol's index keeps for the connected wallet on its network, newest first: when a loan starts, is repaid in part or in full, defaults or is liquidated, nears its due date, enters or leaves its grace period, or its health falls below 1.5, 1.2 or 1.05, and when a reward entry nears or passes its claim deadline. Each alert is one short sentence with its time and a link to the loan, whose page reads it from the chain, or to Claims for a reward entry. Nothing to sign up for and nothing to pay.

A bell beside the wallet in the header counts the alerts that arrived since the Alerts page was last opened in this browser, and opening the page marks them as seen. Which alerts are new is remembered in this browser only.

The page states what it cannot do rather than hiding it. An alert of a kind the app has no words for yet is shown and named, an outcome the index found by its own check rather than from an event says when it was found and that when it happened is not known, alerts the app could not read are counted, and an index that does not answer is said so, never shown as an empty inbox. Telegram and push alerts are still set up in the current app, and the page links there; they come to the next app in a later change.

Rulebook: `docs/DesignsAndPlans/Alpha05AppDesign.md` RB-INBOX. Part of epic #3180.
