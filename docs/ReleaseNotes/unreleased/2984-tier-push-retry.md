## Thread — keeper backstop for owed tier pushes, and one ledger rotation rule

Base sends a user's new discount tier to each mirror chain inside the user's own action. A lane that cannot be paid or reached then stays owed, and the protocol records a deferral for it. Anyone may deliver an owed push later, and nothing did, so a mirror could keep a user's old tier until that user's tier changed again.

The keeper's protocol upkeep pass now carries a fourth step, the tier-push retry, behind its own arming flag. It ships switched off; while it is off the run report says so by name.

The indexer's record of deferrals nominates the users. For each one the keeper reads the protocol's own account of which lanes are owed and when the broadcast budget may next pay each. The keeper attaches no value, so it calls the delivery only for a user with a lane the budget may pay now and whose quoted fee still fits the budget, counting what earlier deliveries in the same run would spend. A user waiting on spacing or on budget costs no transaction and is reported as waiting, with the reason.

This step spends the protocol broadcast budget: each delivered lane's cross-chain fee comes from it, under the protocol's own rule. The report names each lane delivered and each lane left owed, from the transaction's own records. The keeper receives nothing.

The same change moves the four passes that already read the indexer's event ledger onto one shared rotation rule: buyback expiry, prepay-sale offers, removed-destination releases and stranded returns. The rule reads a page a run above a stored floor, and moves the floor only past rows finished at the head and at the finalized block, with each row's own event finalized. Each pass used to carry its own copy, and each copy had been corrected separately for the same review findings. The shared rule also stops each of its index and cursor waits at the stage cutoff of the pass using it, so a slow index can no longer hold a pass past the time its sends need. A cursor write not finished by then is left for the next run, which reads the same page again or leaves the floor where it is. Otherwise their behaviour is unchanged. Refs #2984.

> Caveat: ships disarmed. Arming it on any chain is a separate owner decision, and arming it lets the keeper spend the protocol broadcast budget.
> Caveat: a deferral row on a chain whose destination list cannot be read holds the floor until the list reads again; the rotation still reaches every later row.
> Caveat: the fee is quoted before the send; if it rises in between, the delivery lands and leaves the lane owed, and the report says so.
