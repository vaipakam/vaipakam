## Thread — The keeper returns a closed day's reward leftover from a mirror to Base (PR #3560)

A reward mirror pays each day's claims from the batch of VPFI Base delivered
for that day, and a claim takes only what it pays. What the loan-side reward
cap or the per-wallet daily cap trims, and any reward nobody claimed, stays in
the batch. Since PR #3555 a keeper may send that leftover home once the day is
proven closed. This change adds the keeper step that does it.

It is a new step of the return-transport pass, which already carries every
other return from a mirror to Base, and it has its own switch on top of that
pass's switch. On each run it reads the batches the indexer saw open on the
mirror, a page at a time, and for each one whose day is proven closed it sends
what the batch still holds back to the Base that delivered it. Each part is
sized to what the batch holds, to what its delivery still holds untyped, and to
the cross-chain lanes at both ends, exactly as the pass's other returns are.
The keeper pays the transport fee from its own wallet, and the pass's notices
in the ops channel announce each send with its amount.

It sends nothing whose destination it cannot confirm: Base must be a chain it
serves, the Base Diamond there must be the one that sent the delivery, and
Base's return receiver must deliver to it. It leaves a leftover the operator
has already acknowledged, because that releases it for classification on the
mirror, which is the operator's call; the run's line names any such leftover
still holding value. A batch a staging record still references, or whose
delivery has a live stranded-recovery record, waits until those settle.

The step ships switched off. Arming it is an owner decision, needs the
return-transport pass armed too, and needs the keeper role on each mirror.

Advances #3360.

> Caveat: until the step is armed, each closed day's leftover waits on its mirror, held and accounted.
