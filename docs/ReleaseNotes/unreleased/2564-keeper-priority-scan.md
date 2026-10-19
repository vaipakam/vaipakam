## Keeper: a spent fill capacity no longer ends the intent pass for credit-backed intents (#2564)

**What changed.** When the keeper's own fill capacity was spent, its auto-lend intent pass used to stop at the first refusal, so it never reached a later intent that a priority-routing credit (#2550) could still fill. Now a capacity refusal ends only the ordinary intents for the rest of that pass. For each remaining intent, the keeper asks the contract whether a credit unlocks it. That is the same check the fill itself makes. The keeper previews and fills only those intents. The shared per-tick limits on previews, submissions and time still apply. A capacity refusal found during offer matching carries over too, because both draw on the same solver capacity.

**On chains without the perk.** None of the testnet Diamonds carries priority routing yet. On those chains the keeper treats the missing check as "no credit unlocks this", says so once in its log, and fills nothing more that round. So the change is safe to ship ahead of the contract.

**Why.** This is the keeper precondition for arming the perk (design: "Pricing and arming", precondition 3). Without it the perk's benefit would never be delivered, so it must not be sold.
