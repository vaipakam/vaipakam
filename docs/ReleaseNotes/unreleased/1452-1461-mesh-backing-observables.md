## Thread — the mesh watcher's two blind spots closed: a late-delivered release resolves, and Base's delivered share is checked against the mirror (#1452, #1461)

**#1461 — a released remittance that later landed stayed counted as stranded backing.** Releasing a remittance whose message seems never to execute records its recycled share as backing stranded in transit. The watcher's coverage check counts that as backing that exists. Nothing reduced it when the message executed after all, so the allowance overstated in-transit backing by the late-delivered amount and could hide a real shortfall of that size.

Each reservation now keeps the share its own release recorded. When the destination acknowledges that it credited a released remittance after all, that share is resolved once. It goes into the figure the allowance already nets out, the same figure a recovery settlement or a recorded terminal loss feeds. Those two routes take their share off the same record first, so one remittance is never resolved twice.

A delivery the destination held in quarantine instead of crediting resolves nothing on acknowledgement, and neither does a credit reported after such a hold. Its value is still the platform's to recover or write off, and the recovery or the loss record resolves it. The two sides are exclusive by one rule: recovery and loss records are refused once a credit stands unchallenged, and a destination cannot report holding a delivery after reporting a credit for it.

The keeper's ack pass now also acknowledges a released remittance whose delivery has landed, covering the case where nobody would otherwise pay for the acknowledgement. It stops once the destination's classification is recorded. A late delivery nobody acknowledges still stays counted until somebody does. Nothing that moves value reads this figure; it governs an alert, not a payout.

**#1452 — a delivery booked as absorption instead of relocated custody went unseen.** When a mirror receives a remittance, it must book the recycled share as relocated custody, not as its own absorption. A delivery credited the ordinary way instead keeps every relation between the mirror's own figures true. The mirror then reports the canonical chain's top-up as its own absorption, and the canonical chain offers it back as that mirror's funding. Only a record the mirror does not write can catch that.

The canonical chain now records, per destination, the recycled share of every remittance the destination acknowledged crediting, once each, and publishes it. An acknowledgement that the delivery is held or still provisional books nothing, since the mirror relocates custody only when it credits; a released remittance credited late is booked. Forced finalizations are counted apart because they are evidenced rather than delivered; one that the delivery's own acknowledgement later confirms moves over to the acknowledged figure. The watcher pages when that figure exceeds the mirror's relocated custody. The acknowledgement always follows the delivery's credit, so the canonical chain's figure trails the mirror's; leading it means a misbooked arrival. When the figure cannot be read, the check is skipped and the gap is named.

**History.** On a fresh deployment there are no older releases, so no historical figure needs seeding.

Closes #1452. Closes #1461. Refs #1349, #1222.
