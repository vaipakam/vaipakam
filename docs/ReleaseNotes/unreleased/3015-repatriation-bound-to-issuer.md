## Thread — a repatriation instruction is paid out only to the chain that issued it (PR #3143)

A mirror chain records each Base-issued repatriation instruction under the full identity of its issuer: the chain the cross-chain transport authenticated it from, and the Base Diamond there. Executing the instruction, which sends the mirror's surplus VPFI home, and acknowledging its cancellation now both go to that issuing chain. Before this change they went to whichever Base the mirror followed at the moment the step ran. A mirror that detached and then bound to a different Base would therefore send an earlier instruction's VPFI to a chain that never authorized it, and leave the issuing Base's authorization charged. Both steps are permissionless, so anyone could trigger that.

The mirror takes on a new instruction only from the Base it is bound to when the instruction arrives. A cancellation is accepted from any Base that issued one, because it can only stop a payment in that Base's own records, and that is how a Base the mirror has left still releases what it reserved. Two Bases at the same address on different chains are now different issuers. Under the old key, the second Base's first instruction would have been dropped as a re-delivery of the first Base's.

The mirror's execute, cancellation-acknowledgment and instruction-read entry points take the issuing chain as a new first argument. The four instruction events carry it as a new indexed field. The keeper's return-transport pass passes it, and it still sends nothing for an authorization whose mirror now follows another Base. That caution is now the keeper's own choice, no longer the only guard. This reaches a chain only at its next fresh deploy.

Closes #3015.
