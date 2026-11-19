## Agent — alerts for a loan the wallet does not hold

A wallet can now watch any active loan by its id and get Telegram alerts about it on the chat it linked for that network. It is told when the health level falls into a worse band, when the final due date is three days away or has passed, and when the loan is repaid or otherwise closed, which also ends the watch. Every message says the wallet is watching and holds no position in the loan. A wallet that holds a side of the loan is refused, because its own holder alerts already cover it.

Watching, stopping and listing are three new agent routes. Each is signed by the wallet over a message naming the action and the loan, from a new shared module the app will use for the wallet prompt, and each signature is accepted once. The list of watched loans is the wallet's private setting and is kept in the agent's own state object beside the Telegram links, not in the shared database. Watches are kept per deployment, so a fresh deployment ends them rather than pointing them at a different loan with the same id.

The limits are configuration, with the owner's defaults: 10 watched loans per wallet across networks and 20 watch changes a day. The alert pass runs on its own minute of each five-minute window, so it never shares an invocation, or its request allowance, with the agent's other scheduled work. It reads each network's watched loans with one chain read. A message Telegram did not take is sent again on the next run.

Not covered yet: periodic interest checkpoints, partial repayments, and languages other than English. The app screens are the alpha05 thread's.

Advances #3769. Design: `docs/DesignsAndPlans/FeaturesOverExistingPartsDesign.md` section 9.
