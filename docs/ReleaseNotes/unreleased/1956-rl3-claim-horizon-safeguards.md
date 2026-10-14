## Thread — the reward claim window's two user safeguards: a free pre-expiry notice and a Claim Center countdown (#1956)

**Problem.** Once governance sets the reward claim window, an interaction reward that stays claimable but unclaimed for the full window plus a ninety-day notice period returns to the rewards programme. The ratified design lets that happen only after two safeguards are live: a free pre-expiry notice in the in-app notification center, and a countdown in the Claim Center. A paid channel alone would skip exactly the dormant claimants the window affects. The contract already announced each reward's last call and its removal point, and exposed each reward's earliest possible removal date. Nothing in the app or the indexer used any of it, so the window could not be switched on as designed.

**What changed.**
- **The notices.** The indexer now writes two inbox entries addressed to the reward's owner, the wallet the contract's event names, rather than to a loan party. One is a last-call entry when a reward enters its final notice period. The other is an outcome entry when an unclaimed reward reaches its removal point and returns to the programme.
- **A re-armed reward notifies again.** A change to the claim window restarts a reward's notice, so the last call is filed once per announcement, not once per reward.
- **The notices are independent of the loan entries.** They need no lookup, so a failed lookup for a loan entry in the same scan cannot drop them.
- **A failed write cannot drop them either (#2489 review).** The indexer keeps a mark of the block its inbox rows are complete through. Before, a failed write of a scan's rows was swallowed and that mark advanced anyway, so a one-shot notice whose event had already been scanned could be lost for good. Now a failed write holds the mark, and on the next run the missing rows are re-derived from the archived events and written before the mark moves on. A long gap is drained a bounded window at a time. A chain that has never been marked starts its mark at the present without replaying history, so a restored environment does not re-mint every old notice.
- **In the bell.** The entries name the reward rather than a loan, and open the Claim Center.
- **The countdown.** The Claim Center's rewards card now shows the soonest date by which one of the wallet's rewards must be claimed. The date is the contract's own earliest estimate, which assumes the reward stays claimable from now on, so it can only move later, and the card says so. Inside the final notice period the card switches to a final-notice warning.
- **When nothing shows.** The card shows nothing while the claim window is off. If it cannot read every reward's date, it shows none rather than one that might be later than the real date.

**How it is verified.** Indexer tests run the planner and the inbox write against the real schema, and two deliberate breakages were confirmed to fail them. A fork spec opens the reward entry in the bell and follows it to the Claim Center. Unit tests pin the countdown's choice of date and its switch to final-notice wording.

**Deferred: the countdown's live check.** The countdown itself cannot be exercised on the fork, which has no reward a sweep has started counting, nor on the deployed testnet, where the window stays off until the activation ceremony. The plan already makes verifying both safeguards live a step of that ceremony.

Refs #1956, #1349, #1213.
