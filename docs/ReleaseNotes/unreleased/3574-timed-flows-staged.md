## Thread — The timed positive flows run on the staged runner (#3574)

The positive flows that must wait between their steps, cancelling an offer after the five-minute cancel cooldown (PF-045, PF-046) and settling a monthly interest checkpoint once it is due (PF-116), now run on the same staged runner as the other broadcastable positive-flow modules. Before this change they had their own three-stage script, and since the offer-age rule its first stage could not broadcast at all: PF-116 posted an offer and accepted it in the same broadcast, which the rule refuses before anything is sent, so the whole timed rehearsal opened nothing.

The staged runner now lets a step say how long its next step must wait, beyond the usual offer-age wait. The record each stage writes carries that wait and the earliest time the next stage may run, and a stage run too early is refused by name. On a local Anvil the runner steps the clock for every wait. On a live rehearsal chain it waits out short waits (up to thirty minutes by default) and stops with a distinct exit code before a longer one, saying when the next stage may run; running the same command again then resumes from the record.

PF-116 now takes three steps: it turns on the periodic-interest switch if it is off, registers its settlement adapter, lowers the finer-cadence threshold if needed and posts its offer; once the offer's terms have aged it accepts it and puts the threshold back; once the checkpoint is due it settles it from collateral, closes the loan out and puts back the switch and the adapter. A setting changed across a wait is written into the run's record with the value to put back, and removed from it by the step that puts it back. A run abandoned part-way can be unwound with a new step that puts back whatever the chain still shows changed, and the closing check refuses while any recorded setting is still changed, so a month-long wait never leaves a protocol setting changed without a record of it.

The separate timed runner script and its record are retired. The rehearsal runbook now runs the timed module in the same loop as the other staged modules.

Advances #3574. The partial and negative flow scripts and the vault, keeper, operator-admin and swap-to-repay modules are still simulation-only; staging them, one module per change, is the rest of that issue.

> Caveat: unwinding an abandoned timed run puts back the protocol settings it changed but leaves its open offers and loan on the rehearsal chain.
