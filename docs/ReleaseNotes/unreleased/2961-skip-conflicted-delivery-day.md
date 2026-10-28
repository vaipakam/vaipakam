## Rewards — a mirror can skip a day whose delivery parts disagree (#2961)

A mirror can receive one reward day in several parts, and every part states the day's whole. If two parts state different wholes, the mirror refuses to open that day. Base locks the whole at the first part, so this happens only through a fault: a faulty or compromised Base, a replaced Base deployment, or a wire defect. Nothing could repair it, and because the reward cursor cannot pass an unopened day, it also held every later day's claims and sweeps on that chain for good.

Such a day can now be skipped (owner decision, option B). One day after the first disagreeing part, anyone may close it unpaid, and the keeper will do so if nobody else does. The skip uses neither disagreeing figure.
- The day's rewards end unpaid on that chain.
- The recycled commitment held for it is released.
- Every later day resumes.
- The figures given up are recorded.

The value that landed for the day is then moved, again by anyone, into that mirror's recycling pool. There it funds later days for the same chain's users. On a mirror whose reward custody is not yet activated, nothing needs to move: that value already counts toward the chain's later funding.

The skip refuses a day that opened before the conflict (it pays normally) and a day the broadcast has not stamped yet. It also refuses a day where a side the delivery gate does not hold carries recycled funding, because that side's claims may already have paid from it. That last case stays held and is an incident for the runbook.

Also in this change:
- A disposed delivery's part no longer counts toward its day on either route. The rule now lives in the one place parts are counted.
- A new test covers a day delivered in 65 parts, more than one claim scan window.

Fresh deploy only, like the rest of the current reward work.

> Caveat: a day skipped this way is lost to claims on that chain. Its rewards are not paid later, even if the fault is found.

Closes #2961.
