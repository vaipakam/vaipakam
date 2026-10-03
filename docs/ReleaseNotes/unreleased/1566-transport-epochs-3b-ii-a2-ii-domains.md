## Thread — a sweep's wide day is staged like a claim's, under its own commitment (#1566 transport epochs 3b-ii-A2-ii, part a)

**Problem.** Until this change only a claim could stage a day that more epochs listed than one read could scan: a forfeit sweep or an expiry sweep reaching such a day deferred with nothing drawn and nothing kept, so a forfeited or expired reward on a wide day could never settle from its epochs — it waited on the live sources, which the staging change exists to keep it off.

**What changed.** A forfeit sweep's or an expiry sweep's wide day now opens a staging record exactly as a claim's does, under the sweep's own commitment (its entry and its operation), so the same preparation, reservation, resolution, unwind, deadline, stale-record and forfeit rules apply to it unchanged. Its close-out routes the day as the sweep itself would have: a forfeit's legs absorb into the recycle bucket as forfeited reward under its loan, an expiry's as expired reward, the expired totals are recorded on the entry and its expiry is announced when its last day settles, and no loan-side reward cap is charged for either. A sweep reaching a day a claim's record holds defers on it and opens nothing; a claim reaching a sweep's day is refused by the commitment.

**Every value movement is explicit, and in one place.** One leg settle now serves every close-out — the claim, both sweeps and every staged record's payout — taking the recycle source it absorbs under, so no two paths can route a leg differently. The record-opening step is hosted once, behind a Diamond-internal entry the claim walk and both sweeps reach by self-call, since the expiry walk's host has no room to carry it.

**Spec:** TokenomicsTechSpec, the staging change's bullet (a sweep's day).
