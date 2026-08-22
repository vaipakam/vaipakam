## The recycling activation ceremony is written down (#1349 M7)

Turning on the cross-chain VPFI recycling loop is a one-time sequence that spans
every chain, and until now it existed only as prose scattered across a planning
document. It is now a section of the governance runbook, in the order it has to
be performed, with the reasons each step comes where it does.

Three of those reasons are the kind that are only obvious in hindsight. The fee
entitlement has to be switched on **first**, because any loan opened between a
clean scan and that switch rejoins the class the scan was checking for — so
scanning first and enabling second means the scan result can be overtaken by
ordinary business. There is no way to fix such a loan afterwards: the stamp is
written when the loan opens and nothing can add it later, so the only remedies
are the ordering above and waiting for the loan to close. And where the platform is running
across several chains, the arming call is a single transaction on one chain that
commits all of them — it cannot be repeated, cannot be undone, and cannot be
postponed once the day it names arrives. (On the simpler arrangement where only
the main chain pays rewards, that call commits only that chain and nothing has to
be told; the runbook now separates the two, because a step that cannot be
completed on the simpler arrangement was previously demanded of it.) — so the day chosen has to leave room for every other chain to hear
about it, and each one has to be checked before that day, not after.

**A gate that reads as closed is not.** The plan pointed at a card for the
fund-safety half of the backing separation — reward payouts being bounded by the
platform's spare balance rather than by what was actually delivered for rewards,
where some of that balance is borrower collateral. That card shows as completed.
It was closed automatically when a different, smaller piece of work merged
mentioning it, and the real remaining half was re-filed under a new number. The
runbook, the plan and the library comments now all name the open card, and say
why the closed one is not evidence. Anyone verifying this gate by opening the
card the documents used to name would have read a green label over an open
fund-safety defect.

**Review then found three ways the first draft would have stranded an
operator mid-ceremony**, all of them about order rather than fact. Every piece
of keeper preparation now comes before the irreversible step, because none of it
can be redone afterwards — the day being switched on cannot be moved once it is
named. One authorization was missing outright: the address that sends funding
from the main chain has to be approved for that specifically, and the approvals
covering the other chains do not include it, so an operator following the first
draft would have finished the ceremony and then watched every funding send be
refused. And the day chosen has to be counted from when the switch-on actually
happens, not from when it is requested — on a live deployment those are two days
apart by design, which was enough to consume the whole safety margin the step
exists to provide.

Nothing about how the platform behaves changed here.
