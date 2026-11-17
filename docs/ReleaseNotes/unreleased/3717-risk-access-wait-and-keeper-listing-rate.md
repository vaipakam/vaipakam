## Security — Risk access wait before first use; keeper listing rate bound

When a wallet raises its own asset access, or consents to an illiquid asset pair, the platform makes it wait a set time before the first deal can use the change. That wait is what stops a website from walking a new user through "raise your access, then take this deal" in one sitting. Its setting started at zero and no deploy set it. Now a mainnet deploy sets it to 48 hours, governance cannot lower it below one hour on a mainnet, and the launch check refuses to open a mainnet whose wait is zero. Public test networks start at ten minutes and a local test chain at none, so test flows stay quick. Lowering access stays immediate.

The record of each change now names what an alert needs: an access change states the level before it and when the new level takes effect, and a pair consent states both assets and when it can first be used. A keeper permission switched on a loan or offer names the owner it is for, and a change to a keeper's allowed actions states the actions it had before.

A keeper a lender allowed to start an early exit may now list the loan only at the loan's own rate or below. A higher listing rate makes the seller pay the difference to the buyer out of the sale, so that price is the lender's own decision, never a keeper's.

An automatic extension always ends by a date both sides stated. Each side's extension consent already had to carry a future latest date, but the extension step itself read a missing date as "no limit"; it now refuses instead, and the keeper should treat a missing date the same way.

Closes #3717
