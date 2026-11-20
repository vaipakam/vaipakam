# The keeper warns committed wallets about an announced Terms change

After a material change to the Terms comes into force, a wallet that has not accepted the new version takes on no new position. Its open offers, Auto-lend slots and standing instructions stop filling and running until it accepts. They are not cancelled.

This release adds a keeper alert for that case. While an announcement is pending, the keeper finds every wallet that has an open offer (on the book or signed), an Auto-lend slot, or a standing instruction on an active loan. If a wallet will not be current when the change comes into force, the keeper alerts it once, by Telegram and Push, in the owner's language. The alert names the version, the time it comes into force, and which of the wallet's commitments stop. It also says that nothing is cancelled and that accepting in the app keeps them working.

The chain's own record of the pending announcement decides everything. A withdrawn announcement is never alerted, and an announcement made again with a new time alerts again.

The keeper sends no transaction and records nothing on chain. The alert ships switched off behind its own flag.
