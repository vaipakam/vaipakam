## Thread — The operator and compliance rehearsal flows run on the staged runner (#3574)

The operator and compliance rehearsal flows now broadcast through the staged runner. These are the flagged wallet whose close-out stays open (PF-008), the per-asset and global pauses (PF-323, PF-322), treasury accrual (PF-329) and the admin fee setting (PF-324). Before this change they could only run as a simulation, because three of them posted an offer and filled it in the same broadcast, which the offer-age rule refuses before anything is sent.

A scenario that fills an offer it posted now posts it in one step and fills it in a later one, once the offer's terms have aged. The fee scenario takes a third step: it opens its first loan at the configured fee and changes the fee, then opens a second loan at the new fee and puts the original back. The pauses take one step each.

Every setting these flows change is recorded as a setting to put back: the borrower's sanctions flag, the asset pause, the global pause and the initiation fee. If a run stops part-way, the unwind step restores whatever the chain still shows changed, and the closing check refuses while anything is. This was exercised on a run stopped after the fee change, and on a record whose flag and pauses were set by hand. Each time the unwind put every setting back, and a second unwind found nothing left to do.

The rehearsal runbook runs the operator-admin module in the same loop as the other staged modules.

Advances #3574. The partial and negative flow scripts and the vault module are still simulation-only.

> Caveat: unwinding an abandoned run puts the settings back but leaves that run's open offers and loans on the rehearsal chain.
