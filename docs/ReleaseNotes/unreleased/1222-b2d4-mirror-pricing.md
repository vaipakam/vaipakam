## #1222 M3 B2-d4 — multi-chain reward claims stay paused, and now it is written down why

Stage B2-d4 of the recycling completion programme (plan #1348 §M3; umbrella
#1349; design record `Vpfi1222B2dDeliveredBackingDesign.md` §2g) set out to let
chains other than the canonical one price their own reward claims. **The change
was withdrawn during review.** Those claims remain paused, exactly as before, and
this note records what has to be true before they can resume.

**No behaviour changes.** Reward claims on a receiving chain were already paused
for post-cutover days and still are. Nothing regresses, and none of this surface
is reachable until the operator arming ceremony in any case.

**Why the pause was expected to lift.** It existed because such a chain's reward
funding arrives by remittance, and nothing recorded those arriving tokens against
the chain's own recycled balance — so paying from that balance would have spent
value absorbed for other purposes. The previous stage fixed exactly that, and the
recycled side has a second protection besides: a claim budgets the recycled
portion against the chain's live balance and defers any day it cannot cover.

**Why it did not lift.** Review found the pause was doing two further jobs that
the previous stage never addressed:

1. *The freshly-issued side has no equivalent limit on a receiving chain.* That
   side is funded entirely by the canonical chain and arrives with the
   remittance, but a claim there limits it only against the programme's global
   lifetime ceiling less that chain's own past payouts — not against what has
   actually been received. Resuming claims would have let a chain pay out before
   its funding arrived, drawing on tokens the platform holds for unrelated
   obligations.
2. *Days that were deliberately zeroed would consume themselves.* When a chain's
   activity report is missing at day-close, the platform deliberately records
   that chain's funding for the day as zero and flags the day for separate,
   operator-sized compensation. With claims resumed, such a day would be walked
   as an ordinary zero-value day: it would count as settled and the rewards
   attached to it would be closed out — before the compensation could reach
   them.

Both are now tracked as explicit prerequisites, and the pause is covered by a
test so it cannot be removed inadvertently.

**One durable rule came out of this**, recorded alongside the code. When a chain
cannot pay a day for want of funding, the claim stops at that day and resumes
from it on a later attempt — days are settled oldest-first, so later days do
wait behind it. That is acceptable only because the wait can always end: a day
the platform actually funds becomes payable as soon as its funding lands.

The rule is therefore about what the wait is keyed on. A wait keyed on the
*amount* of funding present always clears. A wait keyed on the *arrival of a
message* may never clear — and some days are deliberately never funded from the
canonical chain, either because the receiving chain covers them entirely from
its own balance or because the day's liability rounds to nothing. Keying on
arrival would strand that chain's rewards permanently, which is the trap the
first attempt at this stage fell into.
